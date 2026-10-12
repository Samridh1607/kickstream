import asyncio

import pytest

from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.analytics.stage import AnalyticsStage
from kickstream.analytics.state import AnalyticsConfig, MatchState, apply, attack_pressure, momentum
from kickstream.contracts import KeyMoment, PressureSnapshot, StatsSnapshot
from kickstream.domain.pitch import xg, zone_index
from kickstream.ports.bus import EVENTS, INSIGHTS

from tests.factories import MATCH, event

CFG = AnalyticsConfig()


def run(events):
    state, out = MatchState(MATCH), []
    for e in events:
        out.extend(apply(state, e, CFG))
    return state, out


def moments(out, kind=None):
    return [o for o in out if isinstance(o, KeyMoment) and (kind is None or o.kind == kind)]


def last_stats(out):
    return [o for o in out if isinstance(o, StatsSnapshot)][-1]


def test_possession_and_pass_accuracy_come_from_passes():
    events = [event(i, "pass", "home", completed=i != 3) for i in (1, 2, 3)]
    events += [event(4, "pass", "away", completed=True), event(5, "half_time", minute=45)]
    snapshot = last_stats(run(events)[1])
    assert snapshot.home.possession == 75.0 and snapshot.away.possession == 25.0
    assert snapshot.home.passes == 3 and snapshot.home.pass_accuracy == pytest.approx(66.7)
    assert snapshot.away.pass_accuracy == 100.0


def test_possession_is_even_before_any_touch():
    snapshot = last_stats(run([event(1, "kickoff", "home")])[1])
    assert snapshot.home.possession == 50.0 and snapshot.away.possession == 50.0


def test_shots_accumulate_xg_and_only_goal_or_saved_count_on_target():
    events = [
        event(1, "shot", "home", x=90, y=50, outcome="saved"),
        event(2, "shot", "home", x=75, y=30, outcome="off_target"),
        event(3, "shot", "away", x=10, y=50, outcome="blocked"),
        event(4, "half_time", minute=45),
    ]
    snapshot = last_stats(run(events)[1])
    assert (snapshot.home.shots, snapshot.home.shots_on_target) == (2, 1)
    assert snapshot.home.xg == pytest.approx(round(xg(90, 50) + xg(75, 30), 2))
    assert snapshot.away.xg == pytest.approx(round(xg(90, 50), 2))


def test_goal_produces_a_key_moment_with_score_and_evidence():
    events = [
        event(1, "shot", "away", minute=12, x=8, y=50, outcome="goal", player_id="hbc-9"),
        event(2, "goal", "away", minute=12, x=0, y=50, player_id="hbc-9"),
        event(3, "half_time", minute=45),
    ]
    out = run(events)[1]
    [goal] = moments(out)
    assert (goal.id, goal.kind, goal.team, goal.minute) == (f"{MATCH}-k1", "goal", "away", 12)
    assert (goal.score_home, goal.score_away) == (0, 1)
    assert (goal.player_id, goal.event_id) == ("hbc-9", f"{MATCH}-e2")
    assert {f.label for f in goal.facts} == {"xg", "shots", "possession"}
    assert last_stats(out).away.goals == 1


def test_big_chance_needs_high_xg_and_no_goal():
    close = event(1, "shot", "home", x=95, y=50, outcome="saved", player_id="nbr-9")
    far = event(2, "shot", "home", x=60, y=50, outcome="saved")
    [chance] = moments(run([close, far])[1])
    assert chance.kind == "big_chance" and chance.player_id == "nbr-9"
    assert chance.facts[0].label == "xg" and chance.facts[0].value == pytest.approx(round(xg(95, 50), 2))
    assert moments(run([event(1, "shot", "home", x=95, y=50, outcome="goal")])[1]) == []


def test_red_card_reports_players_left_on_the_pitch():
    [card] = moments(run([event(1, "red_card", "away", minute=30, player_id="hbc-4")])[1])
    assert (card.kind, card.team, card.player_id) == ("red_card", "away", "hbc-4")
    assert {f.label: f.value for f in card.facts}["players_on_pitch"] == 10


def test_pressure_lands_in_the_event_zone_and_halves_every_five_minutes():
    state, _ = run([event(1, "pass", "home", x=90, y=50, completed=True)])
    zone = zone_index(90, 50)
    assert state.grid["home"][zone] == 1.0 and sum(state.grid["away"]) == 0
    apply(state, event(2, "foul", "away", minute=5), CFG)
    assert state.grid["home"][zone] == pytest.approx(0.5)


def test_momentum_is_signed_toward_the_side_pressing_in_the_final_third():
    state, _ = run([event(i, "pass", "home", second=i, x=90, completed=True) for i in range(1, 11)])
    assert attack_pressure(state, "home") > 9 and attack_pressure(state, "away") == 0
    assert momentum(state) > 0.5
    state, _ = run([event(i, "pass", "away", second=i, x=10, completed=True) for i in range(1, 11)])
    assert momentum(state) < -0.5


def _passes(side, x, start_minute, end_minute, first_seq):
    events, seq = [], first_seq
    for minute in range(start_minute, end_minute):
        for second in range(0, 60, 10):
            events.append(event(seq, "pass", side, minute=minute, second=second, x=x, completed=True))
            seq += 1
    return events


def test_sustained_pressure_fires_once_while_the_cooldown_runs():
    out = run(_passes("home", 90, 0, 8, 1))[1]
    [pressure] = moments(out, "sustained_pressure")
    assert pressure.team == "home" and pressure.player_id is None
    assert {f.label for f in pressure.facts} == {"pressure", "shots"}


def test_momentum_swing_fires_when_control_changes_sides():
    home_spell = _passes("home", 90, 0, 4, 1)
    away_spell = _passes("away", 10, 4, 14, len(home_spell) + 1)
    swings = moments(run(home_spell + away_spell)[1], "momentum_swing")
    assert len(swings) == 1 and swings[0].team == "away"
    assert {f.label for f in swings[0].facts} == {"momentum", "pressure"}


def test_snapshots_are_emitted_once_per_minute_and_at_period_ends():
    events = [event(1, "pass", "home", minute=0, completed=True), event(2, "pass", "home", minute=0, second=30, completed=True),
              event(3, "pass", "home", minute=1, completed=True), event(4, "half_time", minute=45),
              event(5, "full_time", minute=90)]
    out = run(events)[1]
    snapshots = [o for o in out if isinstance(o, StatsSnapshot)]
    assert [(s.minute, s.period_end) for s in snapshots] == [(0, None), (1, None), (45, "half_time"), (90, "full_time")]
    assert [s.id for s in snapshots] == [f"{MATCH}-s1", f"{MATCH}-s3", f"{MATCH}-s4", f"{MATCH}-s5"]
    heat = [o for o in out if isinstance(o, PressureSnapshot)]
    assert len(heat) == 4 and len(heat[0].home) == heat[0].cols * heat[0].rows == 24


def test_key_moments_precede_the_snapshot_for_the_same_event():
    out = apply(MatchState(MATCH), event(1, "goal", "home", minute=3), CFG)
    assert [type(o).__name__ for o in out] == ["KeyMoment", "StatsSnapshot", "PressureSnapshot"]


async def test_stage_publishes_insights_per_match():
    bus = InMemoryEventBus()
    insights = bus.subscribe(INSIGHTS)
    task = asyncio.create_task(AnalyticsStage(bus).run())
    await bus.publish(EVENTS, MATCH, event(1, "goal", "home", minute=3))
    await bus.publish(EVENTS, "m-2", event(1, "kickoff", "home").model_copy(update={"match_id": "m-2", "id": "m-2-e1"}))
    received = [await asyncio.wait_for(anext(aiter(insights)), 1) for _ in range(5)]
    task.cancel()
    assert [(m.match_id, type(m.payload).__name__) for m in received] == [
        (MATCH, "KeyMoment"), (MATCH, "StatsSnapshot"), (MATCH, "PressureSnapshot"),
        ("m-2", "StatsSnapshot"), ("m-2", "PressureSnapshot")]
    assert received[3].payload.home.goals == 0
