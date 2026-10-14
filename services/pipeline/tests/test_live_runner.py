from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.contracts import MatchEvent, MatchStatus, StatsSnapshot
from kickstream.domain.teams import AWAY, HOME
from kickstream.live.runner import LiveMatch
from kickstream.ports.bus import EVENTS, INSIGHTS, STATUS
from kickstream.ports.match_source import LiveSnapshot, PollPlan, SourceFailure

KICKOFF_AT = 1800.0
PLAN = PollPlan(pre_match_s=600, soon_s=120, live_s=90, half_time_s=300)


def snap(state, minute=0, score=(0, 0)):
    return LiveSnapshot(
        state=state,
        minute=minute,
        score_home=score[0],
        score_away=score[1],
        home=HOME,
        away=AWAY,
        competition="Bundesliga",
        kickoff_at=KICKOFF_AT,
    )


class FakeClock:
    def __init__(self):
        self.at = 0.0
        self.sleeps = []
        self.problems = []
        self.runner = None

    async def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.problems.append(self.runner.problem)
        self.at += seconds

    def now(self):
        return self.at


class FakeLiveSource:
    id = "openligadb"
    name = "OpenLigaDB"
    credit = "Data: OpenLigaDB"
    available = True
    setup = None
    poll = PLAN

    def __init__(self, script):
        self.script = list(script)
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


def _runner(source, first, clock, **kwargs):
    bus = InMemoryEventBus()
    subscription = bus.subscribe(STATUS, EVENTS, INSIGHTS, maxsize=500)
    runner = LiveMatch(bus, source, "4711", "m-1", first, sleep=clock.sleep, now=clock.now, **kwargs)
    clock.runner = runner
    return runner, subscription


def _drain(subscription):
    messages = []
    while not subscription.queue.empty():
        messages.append(subscription.queue.get_nowait())
    return messages


async def test_it_polls_on_the_sources_schedule_and_stops_at_full_time():
    clock = FakeClock()
    source = FakeLiveSource(
        [
            snap("pre_match"),
            snap("pre_match"),
            snap("live", 1),
            snap("half_time", 46, (1, 0)),
            snap("live", 46, (1, 0)),
            snap("finished", 93, (1, 0)),
        ]
    )
    runner, subscription = _runner(source, snap("pre_match"), clock)
    await runner.run()

    assert clock.sleeps == [600, 600, 120, 90, 300, 90]
    assert source.refs == ["4711"] * 6 and source.script == []
    messages = _drain(subscription)
    topics = {type(m.payload): m.topic for m in messages}
    assert topics == {MatchStatus: STATUS, MatchEvent: EVENTS, StatsSnapshot: INSIGHTS}
    events = [m.payload.type for m in messages if m.topic == EVENTS]
    assert events == ["kickoff", "half_time", "kickoff", "full_time"]
    assert all(m.match_id == "m-1" for m in messages)
    assert (runner.status.state, runner.status.score_home, runner.status.source) == (
        "finished",
        1,
        "openligadb",
    )
    assert runner.problem is None


async def test_failures_back_off_and_the_last_state_is_kept():
    clock = FakeClock()
    source = FakeLiveSource(
        [
            SourceFailure("OpenLigaDB could not be reached. Check the connection."),
            SourceFailure("OpenLigaDB could not be reached. Check the connection."),
            snap("live", 14),
            snap("finished", 92),
        ]
    )
    runner, subscription = _runner(source, snap("live", 10), clock)
    await runner.run()

    assert clock.sleeps == [90, 180, 300, 90]
    assert clock.problems == [None, *["OpenLigaDB could not be reached. Check the connection."] * 2, None]
    assert runner.problem is None and runner.status.state == "finished"
    minutes = [m.payload.minute for m in _drain(subscription) if m.topic == STATUS]
    assert minutes == [10, 14, 92]


async def test_a_spent_budget_waits_until_it_resets():
    clock = FakeClock()
    message = "Today's 100 free API-Football requests are used up. Following resumes after midnight UTC."
    source = FakeLiveSource([SourceFailure(message, retry_after=3600), snap("finished", 90)])
    runner, _ = _runner(source, snap("live", 30), clock)
    await runner.run()

    assert clock.sleeps == [90, 3600]
    assert clock.problems == [None, message]


async def test_poll_s_overrides_the_schedule():
    clock = FakeClock()
    source = FakeLiveSource(
        [
            snap("pre_match"),
            snap("live", 1),
            snap("half_time", 45),
            SourceFailure("down"),
            snap("finished", 90),
        ]
    )
    runner, _ = _runner(source, snap("pre_match"), clock, poll_s=0.5)
    await runner.run()
    assert clock.sleeps == [0.5, 0.5, 0.5, 0.5, 1.0]


async def test_a_finished_first_snapshot_publishes_once_and_never_polls():
    clock = FakeClock()
    source = FakeLiveSource([])
    runner, subscription = _runner(source, snap("finished", 90, (2, 2)), clock)
    await runner.run()
    assert clock.sleeps == [] and source.refs == []
    assert runner.status.state == "finished"
    assert [m.payload.type for m in _drain(subscription) if m.topic == EVENTS] == ["kickoff", "full_time"]
