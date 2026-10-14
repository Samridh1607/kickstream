import asyncio
import contextlib

import pytest

from kickstream.adapters.dir_image_store import DirImageStore
from kickstream.adapters.json_studio_store import JsonStudioStore
from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.contracts import MatchStatus, Narrative, QueuedMatch, SceneElement
from kickstream.domain.teams import AWAY, HOME
from kickstream.ports.bus import INSIGHTS, NARRATIVES, STATUS
from kickstream.ports.match_source import SourceFailure, SourceUnavailable
from kickstream.studio import rules
from kickstream.studio.rules import StudioError
from kickstream.studio.service import StudioService
from kickstream.studio.stage import StudioStage
from kickstream.studio.templates import BREAK, LIVE_MATCH
from tests.factories import MATCH, moment

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
FINAL = QueuedMatch(source="statsbomb", ref="43/3/8658", speed=10, title="France vs Croatia")


class FakeNow:
    def __init__(self, at=1_000.0):
        self.at = at

    def __call__(self):
        return self.at


class Harness:
    def __init__(self, tmp_path, now=None, fail_start=False, refuse=None):
        self.now = now or FakeNow()
        self.started = []
        self.chosen = []
        self.fail_start = fail_start
        self.refuse = refuse
        self.moments = {(MATCH, f"{MATCH}-k1"): moment(1)}
        self.service = StudioService(
            JsonStudioStore(tmp_path / "studio.json", sanitize=rules.sanitize_raw),
            DirImageStore(tmp_path / "images", max_images=3),
            now=self.now,
            start_match=self._start,
            find_moment=lambda m, k: self.moments.get((m, k)),
        )

    async def _start(self, chosen):
        if self.fail_start:
            raise RuntimeError("simulator unavailable")
        if chosen is not None and self.refuse is not None:
            raise self.refuse
        self.started.append(self.now.at)
        self.chosen.append(chosen)
        return "m-1"

    async def countdown_ends(self):
        await self.service.countdown(self.now.at + 60)
        self.now.at += 60
        await self.service.tick()


def scene_id(doc, template):
    return next(s.id for s in doc.scenes if s.template == template)


async def test_a_new_studio_starts_from_the_templates_and_stamps_the_server_time(tmp_path):
    harness = Harness(tmp_path)
    doc = harness.service.doc
    assert len(doc.scenes) == 5 and doc.revision == 0 and doc.server_time == 1_000.0
    harness.now.at = 1_050.0
    assert harness.service.doc.server_time == 1_050.0


async def test_a_change_bumps_the_revision_and_survives_a_restart(tmp_path):
    harness = Harness(tmp_path)
    live = scene_id(harness.service.doc, LIVE_MATCH)
    doc = await harness.service.apply(lambda d: rules.activate_scene(d, live))
    assert (doc.revision, doc.active_scene_id) == (1, live)
    restarted = Harness(tmp_path).service.doc
    assert (restarted.revision, restarted.active_scene_id) == (1, live)


async def test_a_rule_that_changes_nothing_does_not_create_a_revision(tmp_path):
    harness = Harness(tmp_path)
    doc = await harness.service.apply(rules.end_countdown)
    assert doc.revision == 0 and not (tmp_path / "studio.json").exists()


async def test_a_refused_change_leaves_the_document_as_it_was(tmp_path):
    harness = Harness(tmp_path)
    with pytest.raises(StudioError):
        await harness.service.apply(lambda d: rules.activate_scene(d, "nope"))
    assert harness.service.doc.revision == 0


async def test_a_result_outside_the_schema_is_refused_with_the_field_named(tmp_path):
    harness = Harness(tmp_path)

    def too_many_queued(doc):
        waiting = rules.enqueue_banner(
            rules.enqueue_banner(doc, "a", "info", 8, 0.0), "b", "info", 8, 0.0
        ).banner_queue[0]
        return doc.model_copy(update={"banner_queue": [waiting] * 11})

    with pytest.raises(StudioError, check=lambda e: e.status == 422 and e.field.startswith("banner_queue")):
        await harness.service.apply(too_many_queued)
    assert harness.service.doc.revision == 0


async def test_a_failed_save_is_reported_and_nothing_changes(tmp_path):
    harness = Harness(tmp_path)
    (tmp_path / "studio.tmp").mkdir()
    with pytest.raises(StudioError, check=lambda e: e.status == 503):
        await harness.service.banner("Hello", "custom", 8)
    doc = harness.service.doc
    assert doc.revision == 0 and doc.banner is None


async def test_subscribers_get_the_current_document_then_the_latest_after_changes(tmp_path):
    harness = Harness(tmp_path)
    changes = harness.service.changes()
    assert (await anext(changes)).revision == 0
    await harness.service.banner("One", "custom", 8)
    await harness.service.banner("Two", "custom", 8)
    latest = await asyncio.wait_for(anext(changes), 1)
    assert latest.revision == 2, "a slow page gets the latest document, not every step"
    pending = asyncio.create_task(anext(changes))
    await asyncio.sleep(0.01)
    assert not pending.done()
    pending.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await pending
    await changes.aclose()
    assert harness.service._listeners == set()


async def test_tick_settles_what_is_due_and_nothing_sooner(tmp_path):
    harness = Harness(tmp_path)
    await harness.service.banner("Hello", "custom", 8)
    harness.now.at += 7
    await harness.service.tick()
    assert harness.service.doc.banner is not None and harness.service.doc.revision == 1
    harness.now.at += 1
    await harness.service.tick()
    assert harness.service.doc.banner is None and harness.service.doc.revision == 2


async def test_the_end_of_the_start_countdown_starts_the_match_and_cuts_to_live(tmp_path):
    harness = Harness(tmp_path)
    await harness.service.countdown(harness.now.at + 600, label="Kick-off")
    harness.now.at += 600
    await harness.service.tick()
    doc = harness.service.doc
    assert harness.started == [1_600.0]
    assert harness.chosen == [None], "with nothing chosen, the simulated demo match starts"
    assert doc.countdown is None and doc.active_scene_id == scene_id(doc, LIVE_MATCH)


async def test_a_match_that_fails_to_start_does_not_undo_the_scene_change(tmp_path):
    harness = Harness(tmp_path, fail_start=True)
    await harness.countdown_ends()
    assert harness.service.doc.countdown is None


async def test_the_end_of_the_countdown_starts_the_match_chosen_in_the_match_tool(tmp_path):
    harness = Harness(tmp_path)
    await harness.service.apply(lambda d: rules.set_queued_match(d, FINAL))
    await harness.countdown_ends()
    doc = harness.service.doc
    assert harness.chosen == [FINAL]
    assert doc.problem is None and doc.settings.queued_match == FINAL


async def test_a_chosen_match_that_cannot_start_gives_way_to_the_simulated_one_and_says_why(tmp_path):
    harness = Harness(tmp_path, refuse=SourceFailure("StatsBomb could not be reached. Check the connection."))
    await harness.service.apply(lambda d: rules.set_queued_match(d, FINAL))
    await harness.countdown_ends()
    doc = harness.service.doc
    assert harness.chosen == [None], "the simulated match plays instead"
    assert "simulated match" in doc.problem and "StatsBomb could not be reached" in doc.problem
    assert doc.settings.queued_match == FINAL, "the choice is kept for another go"

    harness.refuse = None
    await harness.countdown_ends()
    assert harness.chosen == [None, FINAL]
    assert harness.service.doc.problem is None, "a start that works clears the old problem"


async def test_a_source_that_is_not_set_up_also_gives_way_to_the_simulated_match(tmp_path):
    harness = Harness(
        tmp_path, refuse=SourceUnavailable("Set KICKSTREAM_API_FOOTBALL_KEY to follow live matches.")
    )
    live = QueuedMatch(source="api_football", ref="1035", speed=1)
    await harness.service.apply(lambda d: rules.set_queued_match(d, live))
    await harness.countdown_ends()
    assert harness.chosen == [None]
    assert "KICKSTREAM_API_FOOTBALL_KEY" in harness.service.doc.problem


async def test_deadlines_that_passed_while_the_server_was_down_are_settled_on_start(tmp_path):
    first = Harness(tmp_path)
    live = scene_id(first.service.doc, LIVE_MATCH)
    await first.service.apply(lambda d: rules.activate_scene(d, live))
    await first.service.take_break(5)
    await first.service.banner("Stale", "custom", 8)
    assert first.service.doc.active_scene_id == scene_id(first.service.doc, BREAK)

    later = Harness(tmp_path, now=FakeNow(first.now.at + 3_600))
    assert later.service.doc.countdown is not None, "loaded as saved"
    await later.service.tick()
    doc = later.service.doc
    assert (doc.countdown, doc.banner, doc.active_scene_id) == (None, None, live)


async def test_a_start_countdown_that_ended_while_down_still_starts_the_match(tmp_path):
    first = Harness(tmp_path)
    await first.service.countdown(first.now.at + 60)
    later = Harness(tmp_path, now=FakeNow(first.now.at + 500))
    await later.service.tick()
    assert later.started == [1_500.0]


async def test_the_run_loop_settles_overdue_deadlines_when_a_change_wakes_it(tmp_path):
    harness = Harness(tmp_path)
    loop = asyncio.create_task(harness.service.run())
    await harness.service.banner("Hello", "custom", 3)
    harness.now.at += 10
    await harness.service.apply(lambda d: rules.set_ticker(d, d.ticker.model_copy(update={"speed": 200})))
    await asyncio.sleep(0.05)
    assert harness.service.doc.banner is None, "the change woke the loop, which found the banner overdue"
    assert not loop.done()
    loop.cancel()


async def test_replaying_a_known_moment_sets_the_replay_and_an_unknown_one_is_not_found(tmp_path):
    harness = Harness(tmp_path)
    doc = await harness.service.replay(MATCH, f"{MATCH}-k1")
    assert (doc.replay.moment_id, doc.replay.started_at, doc.replay.duration_s) == (
        f"{MATCH}-k1",
        1_000.0,
        8.0,
    )
    for match_id, moment_id in ((MATCH, "nope"), ("m-9", f"{MATCH}-k1")):
        with pytest.raises(StudioError, check=lambda e: (e.status, e.field) == (404, "moment")):
            await harness.service.replay(match_id, moment_id)


async def test_uploads_are_checked_by_content_and_size(tmp_path):
    harness = Harness(tmp_path)
    image_id = harness.service.upload(PNG)
    assert harness.service.image(image_id) == (PNG, "image/png")
    assert harness.service.image("../studio.json") is None
    for content in (b"plain text pretending", b"<svg xmlns='http://www.w3.org/2000/svg'/>", b""):
        with pytest.raises(StudioError, check=lambda e: (e.status, e.field) == (422, "image")):
            harness.service.upload(content)
    with pytest.raises(StudioError, check=lambda e: "2 MB" in e.message):
        harness.service.upload(PNG + b"\x00" * rules.MAX_IMAGE_BYTES)


# --- stage ------------------------------------------------------------------------------------


def narrative(mode="fan", language="en", n=1, text="GOAL! What a strike."):
    return Narrative(
        id=f"{MATCH}-k{n}-{mode}-{language}",
        match_id=MATCH,
        minute=23,
        moment_id=f"{MATCH}-k{n}",
        mode=mode,
        language=language,
        text=text,
        source="scripted",
        agent="scripted",
        evidence=[],
        team="home",
    )


def status(state="live", match_id=MATCH):
    return MatchStatus(
        match_id=match_id, state=state, minute=45, score_home=0, score_away=0, speed=30, home=HOME, away=AWAY
    )


async def staged(tmp_path, **settings):
    harness = Harness(tmp_path)
    if settings:
        await harness.service.apply(lambda d: rules.set_settings(d, d.settings.model_copy(update=settings)))
    bus = InMemoryEventBus()
    task = asyncio.create_task(StudioStage(bus, harness.service).run())

    async def publish(topic, payload, match_id=MATCH):
        await bus.publish(topic, match_id, payload)
        await asyncio.sleep(0.01)

    return harness, publish, task


async def test_a_goal_narrative_in_the_program_variant_becomes_a_banner(tmp_path):
    harness, publish, task = await staged(tmp_path)
    await publish(INSIGHTS, moment(1, kind="goal"))
    await publish(NARRATIVES, narrative("analyst", "en"))
    await publish(NARRATIVES, narrative("fan", "es"))
    assert harness.service.doc.banner is None, "other variants are not the program's"
    await publish(NARRATIVES, narrative("fan", "en"))
    task.cancel()
    banner = harness.service.doc.banner
    assert (banner.text, banner.kind, banner.duration_s, banner.source_id) == (
        "GOAL! What a strike.",
        "goal",
        8,
        f"{MATCH}-k1-fan-en",
    )


async def test_red_cards_become_card_banners_and_lesser_moments_do_not(tmp_path):
    harness, publish, task = await staged(tmp_path)
    await publish(INSIGHTS, moment(1, kind="big_chance"))
    await publish(NARRATIVES, narrative(n=1))
    assert harness.service.doc.banner is None
    await publish(INSIGHTS, moment(2, kind="red_card"))
    await publish(NARRATIVES, narrative(n=2, text="Red card!"))
    task.cancel()
    assert harness.service.doc.banner.kind == "card"


async def test_the_banner_follows_the_program_language(tmp_path):
    harness, publish, task = await staged(tmp_path, mode="analyst", language="hi")
    await publish(INSIGHTS, moment(1))
    await publish(NARRATIVES, narrative("fan", "en"))
    await publish(NARRATIVES, narrative("analyst", "hi", text="गोल!"))
    task.cancel()
    assert harness.service.doc.banner.text == "गोल!"


async def test_automatic_banners_can_be_switched_off(tmp_path):
    harness, publish, task = await staged(tmp_path, auto_banner=False)
    await publish(INSIGHTS, moment(1))
    await publish(NARRATIVES, narrative())
    task.cancel()
    assert harness.service.doc.banner is None


async def test_a_long_narrative_is_cut_to_fit_a_banner(tmp_path):
    harness, publish, task = await staged(tmp_path)
    await publish(INSIGHTS, moment(1))
    await publish(NARRATIVES, narrative(text="x" * 500))
    task.cancel()
    assert len(harness.service.doc.banner.text) == 200


async def test_half_time_starts_a_two_minute_break_once_per_match_when_enabled(tmp_path):
    harness, publish, task = await staged(tmp_path, auto_half_time_break=True)
    await publish(STATUS, status("live"))
    assert harness.service.doc.countdown is None
    await publish(STATUS, status("half_time"))
    doc = harness.service.doc
    assert (doc.countdown.kind, doc.countdown.ends_at) == ("break", 1_000.0 + 120)
    await harness.service.apply(rules.end_countdown)
    await publish(STATUS, status("half_time"))
    assert harness.service.doc.countdown is None, "a repeated half-time status does not restart the break"
    await publish(STATUS, status("half_time", match_id="m-2"), match_id="m-2")
    task.cancel()
    assert harness.service.doc.countdown is not None


async def test_half_time_does_nothing_unless_enabled(tmp_path):
    harness, publish, task = await staged(tmp_path)
    await publish(STATUS, status("half_time"))
    task.cancel()
    assert harness.service.doc.countdown is None


def logo(n, image_id):
    return SceneElement(
        id=f"logo{n}",
        type="image",
        x=0,
        y=0,
        width=200,
        height=200,
        layer=9 + n,
        visible=True,
        props={"image_id": image_id, "fit": "contain"},
    )


async def test_a_full_image_store_drops_images_no_scene_uses_to_make_room(tmp_path):
    harness = Harness(tmp_path)
    used, unused_one, unused_two = (harness.service.upload(PNG) for _ in range(3))
    scene = harness.service.doc.scenes[0]
    await harness.service.apply(
        lambda d: rules.replace_scene(d, scene.id, scene.name, [*scene.elements, logo(0, used)])
    )

    newest = harness.service.upload(PNG)
    assert harness.service.image(newest) is not None
    assert harness.service.image(used) is not None, "an image a scene shows is never dropped"
    assert harness.service.image(unused_one) is None and harness.service.image(unused_two) is None


async def test_when_every_stored_image_is_in_use_a_new_upload_is_refused(tmp_path):
    harness = Harness(tmp_path)
    scene = harness.service.doc.scenes[0]
    logos = [logo(n, harness.service.upload(PNG)) for n in range(3)]
    await harness.service.apply(lambda d: rules.replace_scene(d, scene.id, scene.name, logos))
    await harness.service.apply(lambda d: rules.save_template(d, scene.id))
    await harness.service.apply(lambda d: rules.replace_scene(d, scene.id, scene.name, []))
    with pytest.raises(StudioError, check=lambda e: e.status == 422 and "already holds" in e.message):
        harness.service.upload(PNG)
    assert all(harness.service.image(item.props["image_id"]) for item in logos), (
        "a saved template still uses them"
    )
