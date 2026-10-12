import asyncio

from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.adapters.memory_store import InMemoryMatchStore
from kickstream.adapters.sse_broadcaster import InProcessBroadcaster
from kickstream.contracts import MatchStatus, Narrative, ViewerProfile
from kickstream.domain.teams import AWAY, HOME
from kickstream.gateway.personalize import to_envelope
from kickstream.gateway.recorder import Recorder
from kickstream.gateway.stream import stream_items
from kickstream.ports.bus import EVENTS, INSIGHTS, NARRATIVES, STATUS
from tests.factories import MATCH, event, moment, stats

STATUS_LIVE = MatchStatus(
    match_id=MATCH, state="live", minute=0, score_home=0, score_away=0, speed=30, home=HOME, away=AWAY
)
FAN_EN = ViewerProfile(mode="fan", language="en")


def narrative(mode="fan", language="en", team="home", player_id="nbr-9", n=1) -> Narrative:
    return Narrative(
        id=f"{MATCH}-k{n}-{mode}-{language}",
        match_id=MATCH,
        minute=10,
        moment_id=f"{MATCH}-k{n}",
        mode=mode,
        language=language,
        text="text",
        source="scripted",
        agent="scripted",
        evidence=[],
        team=team,
        player_id=player_id,
    )


def wired():
    bus, store, broadcaster = InMemoryEventBus(), InMemoryMatchStore(), InProcessBroadcaster()
    return bus, store, broadcaster, Recorder(bus, store, broadcaster)


def test_recorder_types_items_and_keeps_variant_fields():
    _, store, _, recorder = wired()
    recorder.record(MATCH, STATUS_LIVE)
    recorder.record(MATCH, event(1, "pass", "away", player_id="hbc-7", completed=True))
    recorder.record(MATCH, stats(minute=3))
    recorder.record(MATCH, moment(1, team="away", player_id="hbc-9"))
    item = recorder.record(MATCH, narrative("analyst", "hi", team="away", player_id="hbc-9"))

    assert [i.type for i in store.read(MATCH)] == [
        "match_status",
        "match_event",
        "stats",
        "key_moment",
        "narrative",
    ]
    assert [i.id for i in store.read(MATCH)] == [1, 2, 3, 4, 5]
    assert (item.language, item.mode, item.team_id, item.player_id, item.minute) == (
        "hi",
        "analyst",
        "hbc",
        "hbc-9",
        10,
    )
    assert store.read(MATCH)[1].team_id == "hbc"
    assert store.read(MATCH)[2].language is None and store.read(MATCH)[2].team_id is None


def test_recorder_ignores_payloads_it_does_not_know():
    _, store, _, recorder = wired()
    assert recorder.record(MATCH, FAN_EN) is None
    assert store.read(MATCH) == []


async def test_recorder_run_records_every_topic_and_broadcasts():
    bus, store, broadcaster, recorder = wired()
    feed = broadcaster.subscribe(MATCH)
    task = asyncio.create_task(recorder.run())
    await bus.publish(STATUS, MATCH, STATUS_LIVE)
    await bus.publish(EVENTS, MATCH, event(1, "kickoff", "home", player_id="nbr-8"))
    await bus.publish(INSIGHTS, MATCH, moment(1))
    await bus.publish(NARRATIVES, MATCH, narrative())
    received = [await asyncio.wait_for(anext(aiter(feed)), 1) for _ in range(4)]
    task.cancel()
    assert [i.type for i in received] == ["match_status", "match_event", "key_moment", "narrative"]
    assert received == store.read(MATCH)


def items():
    _, store, _, recorder = wired()
    recorder.record(MATCH, STATUS_LIVE)
    recorder.record(MATCH, event(1, "pass", "home", player_id="nbr-9", completed=True))
    recorder.record(MATCH, moment(1, team="home", player_id="nbr-9"))
    for mode in ("fan", "analyst"):
        for language in ("en", "es", "hi"):
            recorder.record(MATCH, narrative(mode, language))
    recorder.record(MATCH, narrative("fan", "en", team="away", player_id="hbc-9", n=2))
    return store.read(MATCH)


def test_only_the_viewers_variant_of_a_narrative_is_delivered():
    profile = ViewerProfile(mode="analyst", language="es")
    delivered = [e for e in (to_envelope(i, profile) for i in items()) if e is not None]
    narratives = [e for e in delivered if e.type == "narrative"]
    assert [(e.payload["mode"], e.payload["language"]) for e in narratives] == [("analyst", "es")]
    assert [e.type for e in delivered] == ["match_status", "match_event", "key_moment", "narrative"]
    assert [e.id for e in delivered] == sorted(e.id for e in delivered)
    assert delivered[0].payload["home"]["name"] == "Northbridge FC"


def test_favorites_highlight_key_moments_and_narratives_only():
    def highlighted(profile):
        return [(e.type, e.highlighted) for e in (to_envelope(i, profile) for i in items()) if e is not None]

    plain = [
        ("match_status", False),
        ("match_event", False),
        ("key_moment", False),
        ("narrative", False),
        ("narrative", False),
    ]
    assert highlighted(FAN_EN) == plain
    by_club = highlighted(ViewerProfile(mode="fan", language="en", club="nbr"))
    assert by_club == [
        ("match_status", False),
        ("match_event", False),
        ("key_moment", True),
        ("narrative", True),
        ("narrative", False),
    ]
    assert highlighted(ViewerProfile(mode="fan", language="en", player="hbc-9"))[-1] == ("narrative", True)
    assert highlighted(ViewerProfile(mode="fan", language="en", club="hbc", player="nbr-9"))[2:] == [
        ("key_moment", True),
        ("narrative", True),
        ("narrative", True),
    ]


def test_a_favorite_that_is_not_in_this_match_highlights_nothing():
    stale = ViewerProfile(mode="fan", language="en", club="old-club", player="old-club-10")
    delivered = [e for e in (to_envelope(i, stale) for i in items()) if e is not None]
    assert len(delivered) == 5 and not any(e.highlighted for e in delivered)


async def test_stream_replays_then_continues_live_without_gaps_or_duplicates():
    _, store, broadcaster, recorder = wired()
    recorder.record(MATCH, STATUS_LIVE)
    recorder.record(MATCH, event(1, "kickoff", "home", player_id="nbr-8"))
    stream = stream_items(store, broadcaster, MATCH, FAN_EN)
    first, second = await anext(stream), await anext(stream)
    recorder.record(MATCH, narrative("fan", "es"))
    recorder.record(MATCH, narrative("fan", "en"))
    third = await asyncio.wait_for(anext(stream), 1)
    await stream.aclose()
    assert [first.id, second.id, third.id] == [1, 2, 4]
    assert third.payload["language"] == "en"


async def test_stream_resumes_after_a_given_id():
    _, store, broadcaster, recorder = wired()
    recorder.record(MATCH, STATUS_LIVE)
    for seq in (1, 2, 3):
        recorder.record(MATCH, event(seq, "pass", "home", player_id="nbr-8", completed=True))
    stream = stream_items(store, broadcaster, MATCH, FAN_EN, after_id=2)
    assert [(await anext(stream)).id, (await anext(stream)).id] == [3, 4]
    await stream.aclose()

    caught_up = stream_items(store, broadcaster, MATCH, FAN_EN, after_id=4)
    pending = asyncio.create_task(anext(caught_up))
    await asyncio.sleep(0.01)
    assert not pending.done(), "nothing to replay; waits for live items"
    pending.cancel()


async def test_an_id_from_beyond_this_log_replays_from_the_start():
    """A browser reconnecting with an ID from an older, longer log must not get silence."""
    _, store, broadcaster, recorder = wired()
    recorder.record(MATCH, STATUS_LIVE)
    recorder.record(MATCH, event(1, "kickoff", "home", player_id="nbr-8"))
    stream = stream_items(store, broadcaster, MATCH, FAN_EN, after_id=5000)
    first = await asyncio.wait_for(anext(stream), 1)
    second = await asyncio.wait_for(anext(stream), 1)
    assert [first.id, second.id] == [1, 2]
    recorder.record(MATCH, event(2, "pass", "home", player_id="nbr-8", completed=True))
    assert (await asyncio.wait_for(anext(stream), 1)).id == 3
    await stream.aclose()


async def test_a_viewer_that_falls_behind_is_ended_and_can_resume_with_nothing_lost():
    _, store, broadcaster, recorder = wired()
    recorder.record(MATCH, STATUS_LIVE)
    stream = stream_items(store, broadcaster, MATCH, FAN_EN)
    seen = [(await anext(stream)).id]
    for seq in range(1, 601):
        recorder.record(MATCH, event(seq, "pass", "home", player_id="nbr-8", completed=True))
    seen += [envelope.id async for envelope in stream]
    assert seen == [1], "the feed overflowed before the viewer read from it, so the stream ended"

    resumed = stream_items(store, broadcaster, MATCH, FAN_EN, after_id=seen[-1])
    seen += [(await anext(resumed)).id for _ in range(600)]
    await resumed.aclose()
    assert seen == list(range(1, 602))


async def test_closing_a_stream_releases_its_feed():
    _, store, broadcaster, recorder = wired()
    recorder.record(MATCH, STATUS_LIVE)
    stream = stream_items(store, broadcaster, MATCH, FAN_EN)
    await anext(stream)
    await stream.aclose()
    assert broadcaster._feeds[MATCH] == []
