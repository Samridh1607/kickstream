import asyncio
from collections import Counter

from kickstream.adapters.clocks import InstantClock
from kickstream.app import Settings, build_pipeline
from kickstream.contracts import Overlay, ViewerProfile
from kickstream.domain.demo import DEMO_SEED
from kickstream.domain.types import VARIANTS
from kickstream.gateway.personalize import to_envelope
from tests.factories import FakeWriter


async def _play(tmp_path, writer=None):
    pipeline = build_pipeline(
        Settings(None, None, None, cache_dir=tmp_path),
        clock_factory=lambda speed: InstantClock(),
        writer=writer,
    )
    pipeline.start()
    match_id = await pipeline.controller.start(DEMO_SEED, 600)
    await asyncio.wait_for(pipeline.controller.wait(), 30)
    for _ in range(300):
        cards = [
            i for i in pipeline.store.read(match_id) if i.type == "overlay" and i.payload.kind == "recap_card"
        ]
        if len(cards) == 6:
            break
        await asyncio.sleep(0.1)
    else:
        raise AssertionError("pipeline did not drain")
    log = pipeline.store.read(match_id)
    await pipeline.stop()
    return log


async def test_one_match_flows_through_all_five_stages(tmp_path):
    log = await _play(tmp_path)
    by_type = Counter(item.type for item in log)
    assert [item.id for item in log] == list(range(1, len(log) + 1))
    assert set(by_type) == {
        "match_status",
        "match_event",
        "stats",
        "pressure",
        "key_moment",
        "narrative",
        "recap",
        "overlay",
    }

    moments = [item.payload for item in log if item.type == "key_moment"]
    narratives = [item.payload for item in log if item.type == "narrative"]
    assert 10 <= len(moments) <= 20
    for moment in moments:
        variants = {(n.mode, n.language) for n in narratives if n.moment_id == moment.id}
        assert variants == set(VARIANTS), f"{moment.id} is missing a variant"
    assert {n.source for n in narratives} == {"scripted"}

    recaps = [item.payload for item in log if item.type == "recap"]
    assert Counter(r.period for r in recaps) == {"half_time": 6, "full_time": 6}

    overlays = [item.payload for item in log if item.type == "overlay"]
    assert {o.kind for o in overlays} == {"lower_third", "stat_card", "pressure_map", "recap_card"}
    for overlay in overlays:
        assert Overlay.model_validate_json(overlay.model_dump_json()) == overlay

    goals = Counter(
        item.payload.team for item in log if item.type == "match_event" and item.payload.type == "goal"
    )
    final = [item.payload for item in log if item.type == "match_status"][-1]
    assert (final.state, final.score_home, final.score_away) == ("finished", goals["home"], goals["away"])
    full_time = next(r for r in recaps if r.period == "full_time")
    assert (full_time.score_home, full_time.score_away) == (final.score_home, final.score_away)


async def test_each_viewer_sees_exactly_one_narrative_per_key_moment(tmp_path):
    log = await _play(tmp_path)
    moment_ids = [item.payload.id for item in log if item.type == "key_moment"]
    for mode, language in VARIANTS:
        profile = ViewerProfile(mode=mode, language=language)
        seen = [
            e for e in (to_envelope(item, profile) for item in log) if e is not None and e.type == "narrative"
        ]
        assert [e.payload["moment_id"] for e in seen] == moment_ids
        assert {(e.payload["mode"], e.payload["language"]) for e in seen} == {(mode, language)}


async def test_with_a_writer_configured_goals_and_recaps_are_agent_written(tmp_path):
    log = await _play(tmp_path, writer=FakeWriter())
    narratives = [item.payload for item in log if item.type == "narrative"]
    goal_ids = {item.payload.id for item in log if item.type == "key_moment" and item.payload.kind == "goal"}
    assert goal_ids and {n.source for n in narratives if n.moment_id in goal_ids} == {"agent"}
    assert {item.payload.source for item in log if item.type == "recap"} == {"agent"}
    assert any(tmp_path.iterdir()), "agent output is cached on disk"
