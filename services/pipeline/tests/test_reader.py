import asyncio
import json

from kickstream.adapters.clocks import InstantClock
from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.app import Settings, build_pipeline
from kickstream.contracts import MatchEvent, MatchStatus
from kickstream.domain.teams import AWAY, HOME
from kickstream.ports.bus import EVENTS, STATUS
from kickstream.simulator.reader import EventReader, write_sample

PASSER = HOME.players[5].id


async def _lines(*lines: str):
    for line in lines:
        yield line


def _line(**fields) -> str:
    return json.dumps(fields) + "\n"


async def test_the_reader_publishes_each_detector_event_with_its_speed_fields_and_numbers_them():
    bus = InMemoryEventBus()
    seen = bus.subscribe(EVENTS, STATUS)
    feed = _lines(
        _line(minute=0, second=0, type="kickoff", x=50.0, y=50.0),
        _line(
            id="detector-own-id",
            minute=3,
            second=5,
            type="pass",
            team="home",
            player_id=PASSER,
            x=40.0,
            y=50.0,
            completed=True,
            pass_distance=21.4,
            pass_difficulty=3,
            ball_speed=19.6,
        ),
        "not json\n",
        "\n",
        _line(
            minute=12,
            second=0,
            type="shot",
            team="home",
            player_id=PASSER,
            x=88.0,
            y=50.0,
            outcome="goal",
            shot_speed=31.2,
        ),
        _line(minute=12, second=0, type="goal", team="home", player_id=PASSER, x=100.0, y=50.0),
        _line(minute=90, second=0, type="full_time", x=50.0, y=50.0),
        _line(minute=91, second=0, type="kickoff", x=50.0, y=50.0),
    )
    reader = EventReader(bus, feed)
    await reader.follow("m-1", HOME, AWAY)

    messages = []
    while not seen.queue.empty():
        messages.append(seen.queue.get_nowait().payload)
    events = [m for m in messages if isinstance(m, MatchEvent)]
    assert [e.type for e in events] == ["kickoff", "pass", "shot", "goal", "full_time"]
    assert [(e.id, e.seq, e.match_id) for e in events][:2] == [("m-1-e1", 1, "m-1"), ("m-1-e2", 2, "m-1")]
    passed = events[1]
    assert (passed.pass_distance, passed.pass_difficulty, passed.ball_speed) == (21.4, 3, 19.6)
    assert events[2].shot_speed == 31.2
    statuses = [m for m in messages if isinstance(m, MatchStatus)]
    assert (
        statuses[-1].state == "finished"
        and statuses[-1].score_home == 1
        and statuses[-1].source == "detector"
    )
    assert reader.skipped == 1 and "1 line" in reader.problem


async def test_a_detector_file_flows_through_the_pipeline_into_pass_quality_stats(tmp_path):
    feed = tmp_path / "feed.jsonl"
    write_sample(feed)
    settings = Settings(
        None,
        None,
        None,
        cache_dir=tmp_path / "cache",
        data_dir=tmp_path / "data",
        detector_file=feed,
        live_poll_s=0.01,
    )
    pipeline = build_pipeline(settings, clock_factory=lambda speed: InstantClock())
    pipeline.start()
    match_id = await pipeline.controller.start(source="detector")
    await asyncio.wait_for(pipeline.controller.wait(), 30)
    for _ in range(100):
        stats = [item.payload for item in pipeline.store.read(match_id) if item.type == "stats"]
        if stats and stats[-1].home.pass_distance:
            break
        await asyncio.sleep(0.05)
    await pipeline.stop()
    events = [item.payload for item in pipeline.store.read(match_id) if item.type == "match_event"]
    assert any(e.ball_speed for e in events) and any(e.shot_speed for e in events)
    assert stats[-1].home.pass_distance > 0 and stats[-1].home.pass_difficulty > 0


async def test_without_a_detector_file_the_source_is_refused(tmp_path):
    pipeline = build_pipeline(
        Settings(None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data")
    )
    try:
        await pipeline.controller.start(source="detector")
    except Exception as exc:  # noqa: BLE001
        assert "KICKSTREAM_DETECTOR_FILE" in str(exc)
    else:
        raise AssertionError("the detector source started without a file")
    await pipeline.stop()
