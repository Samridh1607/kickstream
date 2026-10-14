import asyncio

import pytest

from kickstream.adapters.clocks import InstantClock
from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.contracts import MatchEvent, Player, RunningMatch, TeamSheet
from kickstream.control import MatchController
from kickstream.domain.teams import AWAY, HOME
from kickstream.live.runner import LiveMatch
from kickstream.ports.bus import STATUS
from kickstream.ports.match_source import (
    LiveSnapshot,
    PollPlan,
    ReplayMatch,
    SourceFailure,
    SourceUnavailable,
)


class StuckClock:
    """Lets the first status out, then never advances."""

    async def sleep(self, match_seconds):
        if match_seconds > 0:
            await asyncio.Event().wait()


def controller(clock_type, **sources):
    bus = InMemoryEventBus()
    statuses = bus.subscribe(STATUS, maxsize=5000)
    bus.subscribe("events", maxsize=5000)
    return MatchController(bus, lambda speed: clock_type(), HOME, AWAY, **sources), statuses


def _real_sheet(team_id, name, color):
    players = [Player(id=f"sb-{team_id}-{n}", name=f"Player {n}", number=n, position="MF") for n in (1, 2)]
    return TeamSheet(id=f"sb-{team_id}", name=name, short_name=name[:3].upper(), color=color, players=players)


REAL_HOME = _real_sheet(771, "France", "#0F6CBD")
REAL_AWAY = _real_sheet(785, "Croatia", "#C50F1F")


def three_events(match_id):
    def event(seq, minute, type_, team=None):
        return MatchEvent(
            id=f"{match_id}-{seq}",
            match_id=match_id,
            seq=seq,
            minute=minute,
            second=0,
            type=type_,
            team=team,
            x=50,
            y=50,
        )

    return [event(1, 0, "kickoff", "home"), event(2, 18, "goal", "home"), event(3, 94, "full_time")]


class FakeReplays:
    id, name, credit = "statsbomb", "StatsBomb Open Data", "Data: StatsBomb"

    def __init__(self, fail=False):
        self.fail = fail
        self.loaded = []

    async def load(self, ref, match_id):
        self.loaded.append((ref, match_id))
        if self.fail:
            raise SourceFailure("StatsBomb's open data could not be reached.")
        return ReplayMatch(
            home=REAL_HOME, away=REAL_AWAY, events=three_events(match_id), competition="Test Cup 2018"
        )


def snap(state, minute=0, score=(0, 0), home=REAL_HOME):
    return LiveSnapshot(
        state=state,
        minute=minute,
        score_home=score[0],
        score_away=score[1],
        home=home,
        away=REAL_AWAY,
        competition="Bundesliga",
        kickoff_at=0.0,
    )


class FakeLiveSource:
    id, name, credit = "openligadb", "OpenLigaDB", "Data: OpenLigaDB"
    poll = PollPlan(pre_match_s=600, soon_s=120, live_s=60, half_time_s=300)

    def __init__(self, script, available=True, setup=None):
        self.script = list(script)
        self.available, self.setup = available, setup
        self.refs = []

    async def fixtures(self, day):
        return []

    async def snapshot(self, ref):
        self.refs.append(ref)
        answer = self.script.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    def budget(self):
        return None


def stalling_live_match(polls_before_stalling=0):
    """A LiveMatch factory whose runner polls a few times, then waits forever."""
    sleeps = []

    async def sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) > polls_before_stalling:
            await asyncio.Event().wait()

    def build(bus, source, ref, match_id, first):
        return LiveMatch(bus, source, ref, match_id, first, sleep=sleep)

    return build


def drain(subscription):
    out = []
    while not subscription.queue.empty():
        out.append(subscription.queue.get_nowait().payload)
    return out


async def test_matches_get_sequential_ids_and_the_latest_is_current():
    control, _ = controller(InstantClock)
    assert control.current is None and not control.exists("m-1")
    first = await control.start(11, 30)
    assert (first, control.current) == ("m-1", "m-1") and control.exists("m-1")
    second = await control.start(12, 30)
    assert (second, control.current) == ("m-2", "m-2")
    assert control.exists("m-1") and control.exists("m-2") and not control.exists("m-3")
    await control.stop()


async def test_replacing_a_running_match_tells_its_viewers_it_was_abandoned():
    control, statuses = controller(StuckClock)
    await control.start(11, 30)
    await asyncio.sleep(0.05)
    await control.start(11, 30)
    await asyncio.sleep(0.05)
    seen = [(s.match_id, s.state) for s in drain(statuses)]
    assert seen == [("m-1", "live"), ("m-1", "abandoned"), ("m-2", "live")]
    await control.stop()


async def test_the_new_match_is_current_by_the_time_viewers_hear_of_the_abandonment():
    control, statuses = controller(StuckClock)
    await control.start(11, 30)
    await asyncio.sleep(0.05)
    current_when_heard = []
    original = control._bus.publish

    async def spy(topic, match_id, payload):
        if getattr(payload, "state", None) == "abandoned":
            current_when_heard.append(control.current)
        await original(topic, match_id, payload)

    control._bus.publish = spy
    await control.start(11, 30)
    assert current_when_heard == ["m-2"]
    await control.stop()


async def test_a_finished_match_is_not_marked_abandoned():
    control, statuses = controller(InstantClock)
    await control.start(11, 30)
    await asyncio.wait_for(control.wait(), 20)
    await control.start(11, 30)
    await asyncio.wait_for(control.wait(), 20)
    states = [(s.match_id, s.state) for s in drain(statuses)]
    assert ("m-1", "finished") in states and ("m-1", "abandoned") not in states
    await control.stop()


async def test_stop_is_safe_to_call_with_nothing_running():
    control, _ = controller(InstantClock)
    await control.stop()
    await control.wait()


def _playing():
    return [t for t in asyncio.all_tasks() if "Simulator.play" in repr(t.get_coro()) and not t.done()]


async def test_two_starts_at_once_leave_exactly_one_match_playing():
    control, _ = controller(StuckClock)
    await control.start(11, 30)
    await asyncio.sleep(0.05)
    ids = await asyncio.gather(control.start(11, 30), control.start(11, 30))
    await asyncio.sleep(0.05)
    assert sorted(ids) == ["m-2", "m-3"]
    assert len(_playing()) == 1
    await control.stop()
    assert _playing() == [], "no match is left running that nothing can stop"


async def test_match_ids_carry_the_given_prefix():
    bus = InMemoryEventBus()
    control = MatchController(bus, lambda speed: InstantClock(), HOME, AWAY, prefix="mab12")
    assert await control.start(11, 30) == "mab12-1"
    assert control.exists("mab12-1") and control.current == "mab12-1"
    await control.stop()


async def test_a_simulated_match_starts_with_no_arguments():
    control, statuses = controller(StuckClock)
    assert await control.start() == "m-1"
    await asyncio.sleep(0.05)
    assert [(s.source, s.speed) for s in drain(statuses)] == [("simulated", 30.0)]
    await control.stop()


async def test_a_statsbomb_match_plays_with_its_own_teams():
    replays = FakeReplays()
    control, statuses = controller(InstantClock, replays={"statsbomb": replays})
    match_id = await control.start(speed=600, source="statsbomb", ref="43/3/8658")
    await asyncio.wait_for(control.wait(), 5)
    assert (match_id, replays.loaded) == ("m-1", [("43/3/8658", "m-1")])
    assert control.teams == (REAL_HOME, REAL_AWAY)
    seen = drain(statuses)
    assert {s.source for s in seen} == {"statsbomb"}
    assert {(s.credit, s.competition, s.speed) for s in seen} == {("Data: StatsBomb", "Test Cup 2018", 600)}
    assert (seen[-1].state, seen[-1].score_home, seen[-1].home) == ("finished", 1, REAL_HOME)


async def test_a_failed_load_leaves_the_running_match_and_uses_no_id():
    control, statuses = controller(StuckClock, replays={"statsbomb": FakeReplays(fail=True)})
    await control.start(11, 30)
    await asyncio.sleep(0.05)
    with pytest.raises(SourceFailure, match="could not be reached"):
        await control.start(source="statsbomb", ref="43/3/1")
    assert control.current == "m-1" and not control.exists("m-2")
    assert control.teams == (HOME, AWAY)
    assert control.running().source == "simulated"
    assert [s.state for s in drain(statuses)] == ["live"]
    assert await control.start(11, 30) == "m-2"
    await control.stop()


async def test_a_replay_replaces_the_running_match_and_announces_it_abandoned():
    control, statuses = controller(StuckClock, replays={"statsbomb": FakeReplays()})
    await control.start(11, 30)
    await asyncio.sleep(0.05)
    await control.start(source="statsbomb", ref="43/3/8658")
    await asyncio.sleep(0.05)
    seen = [(s.match_id, s.state, s.source) for s in drain(statuses)]
    assert seen == [
        ("m-1", "live", "simulated"),
        ("m-1", "abandoned", "simulated"),
        ("m-2", "live", "statsbomb"),
    ]
    await control.stop()


async def test_teams_are_the_defaults_before_any_match():
    control, _ = controller(InstantClock, replays={"statsbomb": FakeReplays()})
    assert control.teams == (HOME, AWAY)
    await control.start(source="statsbomb", ref="43/3/8658")
    await asyncio.wait_for(control.wait(), 5)
    await control.start(11, 30)
    assert control.teams == (HOME, AWAY)
    await control.stop()


async def test_running_names_the_match_and_its_source():
    control, _ = controller(StuckClock, replays={"statsbomb": FakeReplays()})
    assert control.running() is None
    await control.start(11, 30)
    assert control.running() == RunningMatch(
        match_id="m-1", source="simulated", title="Northbridge FC vs Harbour City"
    )
    await control.start(source="statsbomb", ref="43/3/8658")
    assert control.running() == RunningMatch(
        match_id="m-2", source="statsbomb", ref="43/3/8658", title="France vs Croatia"
    )
    await control.stop()
    assert control.running() is None


async def test_a_finished_match_is_no_longer_running():
    control, _ = controller(InstantClock)
    await control.start(11, 30)
    await asyncio.wait_for(control.wait(), 20)
    assert control.running() is None


@pytest.mark.parametrize("source", ["sportapi", "statsbomb", "api_football", "openligadb"])
async def test_a_source_the_controller_does_not_have_is_unavailable(source):
    control, statuses = controller(StuckClock)
    await control.start(11, 30)
    await asyncio.sleep(0.05)
    with pytest.raises(SourceUnavailable, match=source):
        await control.start(source=source, ref="1")
    assert control.current == "m-1" and control.running().source == "simulated"
    assert [s.state for s in drain(statuses)] == ["live"]
    await control.stop()


async def test_a_replay_needs_a_match():
    replays = FakeReplays()
    control, _ = controller(StuckClock, replays={"statsbomb": replays})
    with pytest.raises(SourceFailure, match="Choose"):
        await control.start(source="statsbomb")
    assert replays.loaded == [] and control.current is None


async def test_a_live_match_is_followed_until_full_time():
    scorer = Player(id="ol-771-9", name="Scorer", number=9, position="FW")
    with_scorer = REAL_HOME.model_copy(update={"players": [*REAL_HOME.players, scorer]})
    source = FakeLiveSource(
        [
            snap("pre_match"),
            snap("live", 12, (1, 0), home=with_scorer),
            snap("finished", 93, (1, 0), home=with_scorer),
        ]
    )
    control, statuses = controller(StuckClock, live={"openligadb": source}, live_poll_s=0)
    match_id = await control.start(speed=600, source="openligadb", ref="4711")
    assert control.teams == (REAL_HOME, REAL_AWAY)
    await asyncio.wait_for(control.wait(), 5)
    assert (match_id, source.refs) == ("m-1", ["4711"] * 3)
    seen = drain(statuses)
    assert [(s.state, s.minute) for s in seen] == [("pre_match", 0), ("live", 12), ("finished", 93)]
    assert {(s.source, s.detail, s.credit, s.speed) for s in seen} == {
        ("openligadb", "key_events", "Data: OpenLigaDB", 1.0)
    }
    assert control.teams == (with_scorer, REAL_AWAY)
    assert control.running() is None


async def test_a_refused_fixture_changes_nothing():
    refusal = SourceFailure("API-Football refused fixture 1: check the key. Try again later.")
    source = FakeLiveSource([refusal])
    control, statuses = controller(StuckClock, live={"openligadb": source})
    await control.start(11, 30)
    await asyncio.sleep(0.05)
    with pytest.raises(SourceFailure, match="refused fixture 1"):
        await control.start(source="openligadb", ref="1")
    assert control.current == "m-1" and not control.exists("m-2")
    assert control.teams == (HOME, AWAY) and control.running().source == "simulated"
    assert [s.state for s in drain(statuses)] == ["live"]
    assert await control.start(11, 30) == "m-2"
    await control.stop()


async def test_a_live_source_without_its_key_is_unavailable_and_says_how_to_fix_it():
    setup = "Add KICKSTREAM_API_FOOTBALL_KEY to .env and restart Kickstream."
    source = FakeLiveSource([snap("live", 10)], available=False, setup=setup)
    control, statuses = controller(StuckClock, live={"openligadb": source})
    await control.start(11, 30)
    await asyncio.sleep(0.05)
    with pytest.raises(SourceUnavailable, match="KICKSTREAM_API_FOOTBALL_KEY"):
        await control.start(source="openligadb", ref="4711")
    assert source.refs == [] and control.current == "m-1"
    assert [s.state for s in drain(statuses)] == ["live"]
    await control.stop()


async def test_a_live_match_needs_a_fixture():
    source = FakeLiveSource([snap("live", 10)])
    control, _ = controller(StuckClock, live={"openligadb": source})
    with pytest.raises(SourceFailure, match="Choose"):
        await control.start(source="openligadb")
    assert source.refs == [] and control.current is None


async def test_replacing_a_live_match_announces_it_abandoned():
    source = FakeLiveSource([snap("live", 10)])
    control, statuses = controller(StuckClock, live={"openligadb": source}, live_match=stalling_live_match())
    await control.start(source="openligadb", ref="4711")
    await asyncio.sleep(0.05)
    await control.start(11, 30)
    await asyncio.sleep(0.05)
    seen = [(s.match_id, s.state, s.source) for s in drain(statuses)]
    assert seen == [
        ("m-1", "live", "openligadb"),
        ("m-1", "abandoned", "openligadb"),
        ("m-2", "live", "simulated"),
    ]
    assert control.teams == (HOME, AWAY)
    await control.stop()


async def test_stopping_a_live_match_announces_it_abandoned_and_keeps_its_teams():
    source = FakeLiveSource([snap("half_time", 45)])
    control, statuses = controller(StuckClock, live={"openligadb": source}, live_match=stalling_live_match())
    await control.start(source="openligadb", ref="4711")
    await asyncio.sleep(0.05)
    await control.stop()
    assert [(s.state, s.minute) for s in drain(statuses)] == [("half_time", 45), ("abandoned", 45)]
    assert control.running() is None and control.teams == (REAL_HOME, REAL_AWAY)


async def test_running_reports_the_live_sources_problem():
    message = "OpenLigaDB could not be reached. Check the connection."
    source = FakeLiveSource([snap("live", 10), SourceFailure(message)])
    control, _ = controller(
        StuckClock, live={"openligadb": source}, live_match=stalling_live_match(polls_before_stalling=1)
    )
    await control.start(source="openligadb", ref="4711")
    await asyncio.sleep(0.05)
    assert control.running() == RunningMatch(
        match_id="m-1", source="openligadb", ref="4711", title="France vs Croatia", problem=message
    )
    await control.stop()
    assert control.running() is None
