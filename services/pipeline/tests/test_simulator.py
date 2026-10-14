from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.contracts import MatchEvent
from kickstream.domain.teams import AWAY, HOME
from kickstream.ports.bus import EVENTS, STATUS
from kickstream.simulator.generate import generate
from kickstream.simulator.stage import Simulator

MATCH = "m-1"


def _match(seed=11):
    return generate(MATCH, seed, HOME, AWAY)


def test_same_seed_gives_the_same_match_and_different_seeds_differ():
    assert [e.model_dump() for e in _match(11)] == [e.model_dump() for e in _match(11)]
    assert [e.model_dump() for e in _match(11)] != [e.model_dump() for e in _match(12)]


def test_match_has_a_complete_ordered_structure():
    events = _match()
    assert 300 <= len(events) <= 900
    assert events[0].type == "kickoff" and events[0].minute == 0
    assert events[-1].type == "full_time" and events[-1].minute == 90
    assert [e.seq for e in events] == list(range(1, len(events) + 1))
    assert len({e.id for e in events}) == len(events)
    times = [e.minute * 60 + e.second for e in events]
    assert times == sorted(times)
    halves = [e for e in events if e.type == "half_time"]
    assert len(halves) == 1 and halves[0].minute == 45


def test_every_event_is_on_the_pitch_and_names_a_real_player():
    known = {p.id for p in HOME.players} | {p.id for p in AWAY.players}
    for e in _match():
        assert 0 <= e.x <= 100 and 0 <= e.y <= 100
        if e.type not in ("half_time", "full_time"):
            assert e.team in ("home", "away")
            assert e.player_id in known
            prefix = HOME.id if e.team == "home" else AWAY.id
            assert e.player_id.startswith(prefix + "-")


def test_goals_follow_scoring_shots():
    events = _match()
    for index, e in enumerate(events):
        if e.type == "shot":
            assert e.outcome in ("goal", "saved", "off_target", "blocked")
        if e.type == "shot" and e.outcome == "goal":
            follow = events[index + 1]
            assert (follow.type, follow.team, follow.player_id) == ("goal", e.team, e.player_id)
    assert sum(e.type == "goal" for e in events) == sum(
        e.type == "shot" and e.outcome == "goal" for e in events
    )


def test_passes_record_completion_and_substitutions_come_from_the_bench():
    events = _match()
    assert all(e.completed is not None for e in events if e.type == "pass")
    for side, sheet in (("home", HOME), ("away", AWAY)):
        subs = [e for e in events if e.type == "substitution" and e.team == side]
        assert len(subs) <= 3
        bench = {p.id for p in sheet.players[11:]}
        assert all(e.player_in_id in bench for e in subs)
        assert len({e.player_in_id for e in subs}) == len(subs)


class RecordingClock:
    def __init__(self):
        self.slept = 0.0

    async def sleep(self, match_seconds):
        assert match_seconds >= 0
        self.slept += match_seconds


async def test_play_publishes_events_in_order_and_tracks_status():
    events = _match()
    bus, clock = InMemoryEventBus(), RecordingClock()
    subscription = bus.subscribe(EVENTS, STATUS, maxsize=5000)
    simulator = Simulator(bus, clock)
    await simulator.play(MATCH, events, HOME, AWAY, speed=30)
    messages = []
    while not subscription.queue.empty():
        messages.append(subscription.queue.get_nowait())

    published = [m.payload for m in messages if m.topic == EVENTS]
    statuses = [m.payload for m in messages if m.topic == STATUS]
    assert [e.id for e in published] == [e.id for e in events]
    assert clock.slept == 5400

    home_goals = sum(e.type == "goal" and e.team == "home" for e in events)
    away_goals = sum(e.type == "goal" and e.team == "away" for e in events)
    assert (statuses[0].state, statuses[0].score_home, statuses[0].score_away) == ("live", 0, 0)
    assert statuses[0].home == HOME and statuses[0].speed == 30
    assert "half_time" in [s.state for s in statuses]
    assert [s.state for s in statuses].index("half_time") < len(statuses) - 1
    final = statuses[-1]
    assert (final.state, final.minute, final.score_home, final.score_away) == (
        "finished",
        90,
        home_goals,
        away_goals,
    )
    assert simulator.status == final


async def test_a_simulated_status_names_its_source_and_has_no_credit():
    bus = InMemoryEventBus()
    statuses = bus.subscribe(STATUS, maxsize=5000)
    await Simulator(bus, RecordingClock()).play(MATCH, _match()[:3], HOME, AWAY, speed=30)
    first = statuses.queue.get_nowait().payload
    assert (first.source, first.detail, first.credit, first.competition) == ("simulated", "full", None, None)


def _replay_frame():
    """A replay's bare frame, timed as StatsBomb times it: the second half restarts at 45:00."""
    times = [("kickoff", 0, 0), ("half_time", 48, 26), ("kickoff", 45, 0), ("full_time", 94, 0)]
    return [
        MatchEvent(
            id=f"{MATCH}-{seq}", match_id=MATCH, seq=seq, minute=minute, second=second, type=type_, x=50, y=50
        )
        for seq, (type_, minute, second) in enumerate(times, start=1)
    ]


async def test_a_replay_whose_clock_restarts_for_the_second_half_never_sleeps_backwards():
    clock = RecordingClock()
    await Simulator(InMemoryEventBus(), clock).play(MATCH, _replay_frame(), HOME, AWAY, speed=30)
    assert clock.slept == 48 * 60 + 26 + 49 * 60


async def test_a_replay_status_names_its_source_detail_and_credit():
    events = _replay_frame()
    bus = InMemoryEventBus()
    statuses = bus.subscribe(STATUS, maxsize=5000)
    simulator = Simulator(bus, RecordingClock())
    await simulator.play(
        MATCH,
        events,
        HOME,
        AWAY,
        speed=30,
        source="statsbomb",
        credit="Data: StatsBomb",
        competition="FIFA World Cup 2018",
    )
    published = []
    while not statuses.queue.empty():
        published.append(statuses.queue.get_nowait().payload)
    assert [s.state for s in published] == ["live", "half_time", "live", "finished"]
    for status in published:
        assert (status.source, status.detail, status.credit, status.competition) == (
            "statsbomb",
            "full",
            "Data: StatsBomb",
            "FIFA World Cup 2018",
        )
