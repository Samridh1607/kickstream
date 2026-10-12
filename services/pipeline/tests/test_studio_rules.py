import pytest

from kickstream.contracts import KeyMoment, SceneElement, StatFact, Studio, Ticker
from kickstream.studio import rules
from kickstream.studio.rules import StudioError
from kickstream.studio.templates import (ANALYST_DESK, BREAK, CANVAS_H, CANVAS_W, FULL_TIME, LIVE_MATCH,
                                         STARTING_SOON, builtin_templates, default_studio)

NOW = 1_000.0


def scene_id(doc, template):
    return next(s.id for s in doc.scenes if s.template == template)


def element(**over):
    fields = {"id": "x1", "type": "text", "x": 100, "y": 100, "width": 400, "height": 100, "layer": 1,
              "visible": True, "props": {}}
    return SceneElement(**{**fields, **over})


def refused(status, field):
    return pytest.raises(StudioError, check=lambda e: (e.status, e.field) == (status, field))


def moment(n=1, kind="goal"):
    return KeyMoment(id=f"m-1-k{n}", match_id="m-1", minute=23, kind=kind, team="home", score_home=1,
                     score_away=0, facts=[StatFact(label="xg", value=0.4)])


# --- templates -------------------------------------------------------------------------------

def test_there_are_five_built_in_templates_that_fit_the_canvas():
    templates = builtin_templates()
    assert [t.name for t in templates] == [STARTING_SOON, LIVE_MATCH, ANALYST_DESK, BREAK, FULL_TIME]
    for template in templates:
        assert template.template == template.name and template.elements
        for e in template.elements:
            assert 0 <= e.x and e.x + e.width <= CANVAS_W and 0 <= e.y and e.y + e.height <= CANVAS_H
            assert rules.normalize_element(e) == e, f"{template.name}/{e.type} is not already normal"


def test_a_new_studio_has_one_scene_per_template_with_starting_soon_live():
    doc = default_studio()
    assert [s.template for s in doc.scenes] == [STARTING_SOON, LIVE_MATCH, ANALYST_DESK, BREAK, FULL_TIME]
    assert doc.active_scene_id == scene_id(doc, STARTING_SOON) and doc.revision == 0
    assert len({s.id for s in doc.scenes}) == 5
    assert Studio.model_validate(doc.model_dump()) == doc


# --- scenes ----------------------------------------------------------------------------------

def test_scenes_can_be_made_from_a_template_a_saved_template_or_another_scene():
    doc = default_studio()
    doc = rules.create_scene(doc, "builtin", LIVE_MATCH, name="Second half")
    made = doc.scenes[-1]
    assert (made.name, made.template) == ("Second half", LIVE_MATCH) and len(doc.scenes) == 6
    doc = rules.save_template(doc, made.id, name="My live")
    doc = rules.create_scene(doc, "template", doc.templates[0].id)
    assert (doc.scenes[-1].name, doc.scenes[-1].template) == ("My live", LIVE_MATCH)
    doc = rules.create_scene(doc, "scene", made.id)
    assert doc.scenes[-1].name == "Second half copy"
    assert doc.scenes[-1].elements == made.elements and doc.scenes[-1].id != made.id


def test_creating_from_something_that_does_not_exist_is_refused():
    doc = default_studio()
    for source, ref in (("builtin", "Halftime show"), ("template", "nope"), ("scene", "nope")):
        with refused(404, "ref"):
            rules.create_scene(doc, source, ref)


def test_the_scene_and_template_limits_hold():
    doc = default_studio()
    for _ in range(rules.MAX_SCENES - 5):
        doc = rules.create_scene(doc, "builtin", BREAK)
    with refused(422, "scenes"):
        rules.create_scene(doc, "builtin", BREAK)
    for _ in range(rules.MAX_TEMPLATES):
        doc = rules.save_template(doc, doc.scenes[0].id)
    with refused(422, "templates"):
        rules.save_template(doc, doc.scenes[0].id)


def test_replacing_a_scene_keeps_elements_inside_the_canvas_and_cleans_their_properties():
    doc = default_studio()
    target = doc.scenes[1].id
    elements = [
        element(id="a", x=-50, y=5000, width=10, height=10),
        element(id="b", x=1900, y=0, width=400, height=3000),
        element(id="c", type="narration", props={"lines": 99, "junk": True}),
        element(id="d", type="text", props={"text": "Hi", "size": 5, "align": "diagonal"}),
        element(id="e", type="image", props={"image_id": 7, "fit": "stretch"}),
        element(id="f", type="pitch", props={"pressure": False}),
        element(id="g", type="stats", props={"anything": 1}),
    ]
    doc = rules.replace_scene(doc, target, "  Renamed  ", elements)
    saved = {e.id: e for e in doc.scenes[1].elements}
    assert doc.scenes[1].name == "Renamed" and doc.scenes[1].template == LIVE_MATCH
    assert (saved["a"].x, saved["a"].y, saved["a"].width, saved["a"].height) == (0, CANVAS_H - 40, 40, 40)
    assert (saved["b"].x, saved["b"].width, saved["b"].height, saved["b"].y) == (CANVAS_W - 400, 400, CANVAS_H, 0)
    assert saved["c"].props == {"lines": 6}
    assert saved["d"].props == {"text": "Hi", "size": 12, "align": "center"}
    assert saved["e"].props == {"image_id": None, "fit": "contain"}
    assert saved["f"].props == {"pressure": False} and saved["g"].props == {}


@pytest.mark.parametrize("name, elements, field", [
    ("   ", [], "name"),
    ("x" * 61, [], "name"),
    ("Live", [element(id=f"e{i}") for i in range(41)], "elements"),
    ("Live", [element(id="same"), element(id="same")], "elements"),
    ("Live", [element(type="text", props={"text": "x" * 201})], "props.text"),
], ids=["blank-name", "long-name", "too-many", "duplicate-ids", "long-text"])
def test_a_scene_outside_the_limits_is_refused(name, elements, field):
    doc = default_studio()
    with refused(422, field):
        rules.replace_scene(doc, doc.scenes[0].id, name, elements)


def test_replacing_an_unknown_scene_is_not_found_and_leaves_the_others_alone():
    doc = default_studio()
    with refused(404, "scene"):
        rules.replace_scene(doc, "nope", "Live", [])
    changed = rules.replace_scene(doc, doc.scenes[2].id, "Desk", [])
    assert [s.elements for i, s in enumerate(changed.scenes) if i != 2] == [s.elements for i, s in enumerate(doc.scenes) if i != 2]
    assert doc.scenes[2].elements, "the original document is not mutated"


def test_the_active_scene_and_the_last_scene_cannot_be_deleted():
    doc = default_studio()
    with refused(409, "scene"):
        rules.delete_scene(doc, doc.active_scene_id)
    for scene in doc.scenes[1:]:
        doc = rules.delete_scene(doc, scene.id)
    assert len(doc.scenes) == 1
    with refused(409, "scene"):
        rules.delete_scene(doc, doc.scenes[0].id)
    with refused(404, "scene"):
        rules.delete_scene(doc, "nope")


def test_activating_a_scene_makes_it_the_program():
    doc = default_studio()
    live = scene_id(doc, LIVE_MATCH)
    assert rules.activate_scene(doc, live).active_scene_id == live
    with refused(404, "scene"):
        rules.activate_scene(doc, "nope")


def test_templates_can_be_deleted():
    doc = default_studio()
    doc = rules.save_template(doc, doc.scenes[0].id)
    assert rules.delete_template(doc, doc.templates[0].id).templates == []
    with refused(404, "template"):
        rules.delete_template(doc, "nope")


# --- ticker and settings ---------------------------------------------------------------------

def test_ticker_messages_are_trimmed_and_blank_ones_dropped():
    ticker = Ticker(enabled=True, speed=200, messages=["  Welcome  ", "", "   ", "Subscribe"], show_score=False, show_stats=True)
    saved = rules.set_ticker(default_studio(), ticker).ticker
    assert saved.messages == ["Welcome", "Subscribe"] and (saved.speed, saved.show_score) == (200, False)


def test_a_ticker_message_over_120_characters_is_refused():
    ticker = Ticker(enabled=True, speed=120, messages=["ok", "x" * 121], show_score=True, show_stats=True)
    with refused(422, "messages"):
        rules.set_ticker(default_studio(), ticker)


def test_settings_are_replaced_whole():
    doc = default_studio()
    settings = doc.settings.model_copy(update={"mode": "analyst", "language": "hi", "auto_banner": False})
    assert rules.set_settings(doc, settings).settings == settings


# --- banner ----------------------------------------------------------------------------------

def test_the_first_banner_shows_at_once_and_later_ones_wait_in_order():
    doc = rules.enqueue_banner(default_studio(), "  First  ", "custom", 8, NOW)
    assert (doc.banner.text, doc.banner.ends_at, doc.banner_queue) == ("First", NOW + 8, [])
    doc = rules.enqueue_banner(doc, "Second", "info", 5, NOW + 1, source_id="n1")
    doc = rules.enqueue_banner(doc, "Third", "custom", 5, NOW + 2)
    assert [b.text for b in doc.banner_queue] == ["Second", "Third"]
    assert doc.banner_queue[0].ends_at is None and doc.banner_queue[0].source_id == "n1"


def test_goals_jump_the_queue_but_keep_their_own_order():
    doc = rules.enqueue_banner(default_studio(), "On screen", "custom", 8, NOW)
    for text, kind in (("info 1", "info"), ("goal 1", "goal"), ("info 2", "info"), ("goal 2", "goal")):
        doc = rules.enqueue_banner(doc, text, kind, 8, NOW)
    assert [b.text for b in doc.banner_queue] == ["goal 1", "goal 2", "info 1", "info 2"]


def test_a_full_queue_drops_its_oldest_message_that_is_not_a_goal():
    doc = rules.enqueue_banner(default_studio(), "On screen", "custom", 8, NOW)
    doc = rules.enqueue_banner(doc, "goal", "goal", 8, NOW)
    for n in range(rules.MAX_QUEUE - 1):
        doc = rules.enqueue_banner(doc, f"info {n}", "info", 8, NOW)
    assert len(doc.banner_queue) == rules.MAX_QUEUE
    doc = rules.enqueue_banner(doc, "newest", "info", 8, NOW)
    texts = [b.text for b in doc.banner_queue]
    assert len(texts) == rules.MAX_QUEUE and texts[0] == "goal" and "info 0" not in texts and texts[-1] == "newest"


def test_clearing_the_banner_shows_the_next_one_or_nothing():
    doc = rules.enqueue_banner(default_studio(), "First", "custom", 8, NOW)
    doc = rules.enqueue_banner(doc, "Second", "custom", 5, NOW)
    doc = rules.clear_banner(doc, NOW + 3)
    assert (doc.banner.text, doc.banner.ends_at, doc.banner_queue) == ("Second", NOW + 8, [])
    assert rules.clear_banner(doc, NOW + 4).banner is None
    assert rules.clear_banner(default_studio(), NOW).banner is None


@pytest.mark.parametrize("text, duration, field", [("   ", 8, "text"), ("x" * 201, 8, "text"), ("ok", 2, "duration_s"), ("ok", 31, "duration_s")])
def test_banners_outside_the_limits_are_refused(text, duration, field):
    with refused(422, field):
        rules.enqueue_banner(default_studio(), text, "custom", duration, NOW)


# --- countdown and breaks --------------------------------------------------------------------

def test_a_start_countdown_cuts_to_starting_soon():
    doc = default_studio()
    doc = rules.activate_scene(doc, scene_id(doc, FULL_TIME))
    doc = rules.start_countdown(doc, NOW + 600, NOW, label="Kick-off")
    assert (doc.countdown.kind, doc.countdown.ends_at, doc.countdown.label) == ("start", NOW + 600, "Kick-off")
    assert doc.active_scene_id == scene_id(doc, STARTING_SOON)


@pytest.mark.parametrize("starts_at", [NOW, NOW - 5, NOW + 24 * 3600 + 1])
def test_a_start_time_in_the_past_or_too_far_ahead_is_refused(starts_at):
    with refused(422, "starts_at"):
        rules.start_countdown(default_studio(), starts_at, NOW)


def test_a_break_remembers_the_scene_and_returns_to_it():
    doc = default_studio()
    live = scene_id(doc, LIVE_MATCH)
    doc = rules.start_break(rules.activate_scene(doc, live), 5, NOW)
    assert (doc.active_scene_id, doc.previous_scene_id) == (scene_id(doc, BREAK), live)
    assert (doc.countdown.kind, doc.countdown.ends_at) == ("break", NOW + 300)
    ended = rules.end_countdown(doc)
    assert (ended.active_scene_id, ended.previous_scene_id, ended.countdown) == (live, None, None)


def test_a_break_started_during_a_break_keeps_the_first_scene_remembered():
    doc = default_studio()
    live = scene_id(doc, LIVE_MATCH)
    doc = rules.start_break(rules.activate_scene(doc, live), 5, NOW)
    doc = rules.start_break(doc, 10, NOW + 60)
    assert doc.previous_scene_id == live and doc.countdown.ends_at == NOW + 60 + 600


@pytest.mark.parametrize("minutes", [0, -1, 61])
def test_a_break_outside_one_to_sixty_minutes_is_refused(minutes):
    with refused(422, "minutes"):
        rules.start_break(default_studio(), minutes, NOW)


def test_switching_scenes_by_hand_during_a_break_means_the_break_ends_where_the_streamer_is():
    doc = default_studio()
    live, desk = scene_id(doc, LIVE_MATCH), scene_id(doc, ANALYST_DESK)
    doc = rules.start_break(rules.activate_scene(doc, live), 5, NOW)
    doc = rules.activate_scene(doc, desk)
    ended, _ = rules.expire(doc, NOW + 301)
    assert (ended.active_scene_id, ended.countdown) == (desk, None)


def test_deleting_the_remembered_scene_during_a_break_leaves_the_break_scene_up_afterwards():
    doc = default_studio()
    live = scene_id(doc, LIVE_MATCH)
    doc = rules.start_break(rules.activate_scene(doc, live), 5, NOW)
    doc = rules.delete_scene(doc, live)
    ended, _ = rules.expire(doc, NOW + 301)
    assert ended.active_scene_id == scene_id(doc, BREAK) and ended.countdown is None
    assert ended.active_scene_id in {s.id for s in ended.scenes}


def test_cancelling_a_start_countdown_stays_on_the_current_scene():
    doc = rules.start_countdown(default_studio(), NOW + 600, NOW)
    cancelled = rules.end_countdown(doc)
    assert cancelled.countdown is None and cancelled.active_scene_id == doc.active_scene_id
    untouched = default_studio()
    assert rules.end_countdown(untouched) is untouched, "ending nothing changes nothing"


# --- replay ----------------------------------------------------------------------------------

def test_a_replay_runs_for_eight_seconds_and_a_new_one_replaces_it():
    doc = rules.start_replay(default_studio(), moment(1), NOW)
    assert (doc.replay.match_id, doc.replay.moment_id, doc.replay.minute) == ("m-1", "m-1-k1", 23)
    assert (doc.replay.started_at, doc.replay.duration_s) == (NOW, rules.REPLAY_SECONDS)
    again = rules.start_replay(doc, moment(2), NOW + 3)
    assert (again.replay.moment_id, again.replay.started_at) == ("m-1-k2", NOW + 3)
    assert rules.stop_replay(again).replay is None


# --- deadlines -------------------------------------------------------------------------------

def test_the_next_deadline_is_the_earliest_of_banner_countdown_and_replay():
    doc = default_studio()
    assert rules.next_deadline(doc) is None
    doc = rules.start_countdown(doc, NOW + 600, NOW)
    doc = rules.enqueue_banner(doc, "Hi", "custom", 8, NOW)
    assert rules.next_deadline(doc) == NOW + 8
    doc = rules.start_replay(doc, moment(), NOW - 5)
    assert rules.next_deadline(doc) == NOW + 3


def test_nothing_expires_before_its_time():
    doc = rules.enqueue_banner(rules.start_break(default_studio(), 5, NOW), "Hi", "custom", 8, NOW)
    same, actions = rules.expire(doc, NOW + 7.9)
    assert same is doc and actions == []


def test_an_expired_banner_gives_way_to_the_next_and_the_last_one_leaves_the_screen_clear():
    doc = rules.enqueue_banner(default_studio(), "First", "custom", 8, NOW)
    doc = rules.enqueue_banner(doc, "Second", "custom", 5, NOW)
    doc, _ = rules.expire(doc, NOW + 8)
    assert (doc.banner.text, doc.banner.ends_at) == ("Second", NOW + 13)
    doc, _ = rules.expire(doc, NOW + 13)
    assert doc.banner is None and doc.banner_queue == []


def test_a_finished_replay_is_cleared():
    doc, _ = rules.expire(rules.start_replay(default_studio(), moment(), NOW), NOW + rules.REPLAY_SECONDS)
    assert doc.replay is None


def test_when_the_start_countdown_ends_the_match_starts_and_the_program_cuts_to_live():
    doc = rules.start_countdown(default_studio(), NOW + 600, NOW)
    ended, actions = rules.expire(doc, NOW + 600)
    assert actions == ["start_match"] and ended.countdown is None
    assert ended.active_scene_id == scene_id(ended, LIVE_MATCH)


def test_with_automatic_start_off_the_countdown_just_ends():
    doc = default_studio()
    doc = rules.set_settings(doc, doc.settings.model_copy(update={"auto_start": False}))
    doc = rules.start_countdown(doc, NOW + 600, NOW)
    ended, actions = rules.expire(doc, NOW + 600)
    assert actions == [] and ended.countdown is None and ended.active_scene_id == doc.active_scene_id


def test_everything_overdue_is_settled_in_one_pass():
    doc = rules.start_countdown(default_studio(), NOW + 60, NOW)
    doc = rules.enqueue_banner(doc, "Stale", "custom", 8, NOW)
    doc = rules.start_replay(doc, moment(), NOW)
    ended, actions = rules.expire(doc, NOW + 5000)
    assert (ended.banner, ended.replay, ended.countdown, actions) == (None, None, None, ["start_match"])


# --- loading and uploads ---------------------------------------------------------------------

def test_elements_of_an_unknown_type_are_dropped_from_a_loaded_file():
    raw = default_studio().model_dump()
    raw["scenes"][0]["elements"].append({**raw["scenes"][0]["elements"][0], "id": "zz", "type": "webcam"})
    raw["templates"] = [{"id": "t1", "name": "Old", "elements": [{"id": "q", "type": "hologram"}]}]
    cleaned = Studio.model_validate(rules.sanitize_raw(raw))
    assert "zz" not in {e.id for e in cleaned.scenes[0].elements}
    assert cleaned.templates[0].elements == []
    assert len(cleaned.scenes[0].elements) == len(default_studio().scenes[0].elements)


@pytest.mark.parametrize("content, expected", [
    (b"\x89PNG\r\n\x1a\n" + b"\x00" * 20, "image/png"),
    (b"\xff\xd8\xff\xe0" + b"\x00" * 20, "image/jpeg"),
    (b"RIFF\x24\x00\x00\x00WEBPVP8 ", "image/webp"),
    (b"<svg xmlns='http://www.w3.org/2000/svg'/>", None),
    (b"GIF89a" + b"\x00" * 20, None),
    (b"just some text", None),
    (b"RIFF\x24\x00\x00\x00WAVEfmt ", None),
    (b"", None),
], ids=["png", "jpeg", "webp", "svg", "gif", "text", "wav", "empty"])
def test_an_image_is_recognised_by_its_content_not_its_name(content, expected):
    assert rules.sniff_image(content) == expected
