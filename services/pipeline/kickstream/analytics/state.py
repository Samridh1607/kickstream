"""Per-match analytics folded over events. `apply` depends only on its arguments."""

from dataclasses import dataclass, field

from kickstream.contracts import KeyMoment, MatchEvent, PressureSnapshot, StatFact, StatsSnapshot, TeamStats
from kickstream.domain.momentum import SWING_STRENGTH
from kickstream.domain.pitch import COLS, ROWS, attacking_third, attacking_x, xg, zone_index
from kickstream.domain.types import SIDES, Side

_PRESSURE_WEIGHT = {"pass": 1.0, "corner": 3.0, "shot": 4.0, "goal": 5.0}


@dataclass(frozen=True)
class AnalyticsConfig:
    big_chance_xg: float = 0.30
    swing_strength: float = SWING_STRENGTH
    swing_window_min: int = 10  # control must change sides within this many minutes
    swing_cooldown_min: int = 8
    pressure_level: float = 12.0  # attacking-third pressure that counts as high
    pressure_minutes: int = 4  # how long it must be held
    pressure_cooldown_min: int = 10
    half_life_s: float = 300.0  # pressure decay


@dataclass
class _Tally:
    goals: int = 0
    shots: int = 0
    on_target: int = 0
    passes: int = 0
    completed: int = 0
    fouls: int = 0
    yellow: int = 0
    red: int = 0
    xg: float = 0.0
    touches: int = 0
    pass_distance: float = 0.0
    pass_difficulty: float = 0.0


def _per_side(factory):
    return field(default_factory=lambda: {side: factory() for side in SIDES})


@dataclass
class MatchState:
    match_id: str
    tally: dict[Side, _Tally] = _per_side(_Tally)
    grid: dict[Side, list[float]] = _per_side(lambda: [0.0] * (COLS * ROWS))
    clock: float = 0.0
    snapshot_minute: int = -1
    moment_count: int = 0
    strong_sign: int = 0
    strong_minute: int = -99
    last_swing_minute: int = -99
    pressure_since: dict[Side, int | None] = _per_side(lambda: None)
    last_pressure_minute: dict[Side, int] = _per_side(lambda: -99)
    located_seen: bool = False


def attack_pressure(state: MatchState, side: Side) -> float:
    return sum(state.grid[side][zone] for zone in attacking_third(side))


def momentum(state: MatchState) -> float:
    home, away = attack_pressure(state, "home"), attack_pressure(state, "away")
    return (home - away) / (home + away + 5.0)


def _possession(state: MatchState, side: Side) -> float:
    total = sum(tally.touches for tally in state.tally.values())
    return 50.0 if total == 0 else round(state.tally[side].touches / total * 100, 1)


def _team_stats(state: MatchState, side: Side) -> TeamStats:
    tally = state.tally[side]
    accuracy = 0.0 if tally.passes == 0 else round(tally.completed / tally.passes * 100, 1)
    distance = 0.0 if tally.passes == 0 else round(tally.pass_distance / tally.passes, 1)
    difficulty = 0.0 if tally.passes == 0 else round(tally.pass_difficulty / tally.passes, 1)
    return TeamStats(
        goals=tally.goals,
        possession=_possession(state, side),
        shots=tally.shots,
        shots_on_target=tally.on_target,
        passes=tally.passes,
        pass_accuracy=accuracy,
        fouls=tally.fouls,
        yellow_cards=tally.yellow,
        red_cards=tally.red,
        xg=round(tally.xg, 2),
        pass_distance=distance,
        pass_difficulty=difficulty,
    )


def _moment(
    state: MatchState,
    event: MatchEvent,
    kind: str,
    team: Side,
    facts: list[tuple[str, float]],
    *,
    from_event: bool,
) -> KeyMoment:
    state.moment_count += 1
    return KeyMoment(
        id=f"{state.match_id}-k{state.moment_count}",
        match_id=state.match_id,
        minute=event.minute,
        kind=kind,
        team=team,
        player_id=event.player_id if from_event else None,
        event_id=event.id if from_event else None,
        score_home=state.tally["home"].goals,
        score_away=state.tally["away"].goals,
        facts=[StatFact(label=label, value=round(value, 2)) for label, value in facts],
    )


def _chance(event: MatchEvent, side: Side) -> float:
    if event.xg is not None:
        return event.xg
    return xg(attacking_x(side, event.x), event.y) if event.located else 0.0


def _record(state: MatchState, event: MatchEvent, cfg: AnalyticsConfig) -> list[KeyMoment]:
    state.located_seen = state.located_seen or bool(event.located)
    side = event.team
    if side is None:
        return []
    tally = state.tally[side]
    weight = _PRESSURE_WEIGHT.get(event.type)
    if weight is not None and event.located:
        state.grid[side][zone_index(event.x, event.y)] += weight

    if event.type == "pass":
        tally.passes += 1
        tally.touches += 1
        tally.completed += 1 if event.completed else 0
        tally.pass_distance += event.pass_distance or 0.0
        tally.pass_difficulty += event.pass_difficulty or 0
    elif event.type == "shot":
        chance = _chance(event, side)
        tally.shots += 1
        tally.touches += 1
        tally.xg += chance
        tally.on_target += 1 if event.outcome in ("goal", "saved") else 0
        if chance >= cfg.big_chance_xg and event.outcome != "goal":
            return [
                _moment(
                    state,
                    event,
                    "big_chance",
                    side,
                    [("xg", chance), ("shots", tally.shots)],
                    from_event=True,
                )
            ]
    elif event.type == "goal":
        tally.goals += 1
        facts = (
            [("xg", tally.xg), ("shots", tally.shots), ("possession", _possession(state, side))]
            if state.located_seen
            else []
        )
        return [_moment(state, event, "goal", side, facts, from_event=True)]
    elif event.type == "foul":
        tally.fouls += 1
    elif event.type == "yellow_card":
        tally.yellow += 1
    elif event.type == "red_card":
        tally.red += 1
        facts = [("players_on_pitch", 11 - tally.red)]
        if state.located_seen:
            facts.append(("fouls", tally.fouls))
        return [_moment(state, event, "red_card", side, facts, from_event=True)]
    return []


def _swing(state: MatchState, event: MatchEvent, cfg: AnalyticsConfig) -> list[KeyMoment]:
    value = momentum(state)
    sign = 1 if value >= cfg.swing_strength else -1 if value <= -cfg.swing_strength else 0
    if sign == 0:
        return []
    changed = state.strong_sign not in (0, sign)
    recent = event.minute - state.strong_minute <= cfg.swing_window_min
    rested = event.minute - state.last_swing_minute >= cfg.swing_cooldown_min
    state.strong_sign, state.strong_minute = sign, event.minute
    if not (changed and recent and rested):
        return []
    state.last_swing_minute = event.minute
    team: Side = "home" if sign > 0 else "away"
    facts = [("momentum", abs(value)), ("pressure", attack_pressure(state, team))]
    return [_moment(state, event, "momentum_swing", team, facts, from_event=False)]


def _sustained(state: MatchState, event: MatchEvent, cfg: AnalyticsConfig) -> list[KeyMoment]:
    found = []
    for side in SIDES:
        level = attack_pressure(state, side)
        if level < cfg.pressure_level:
            state.pressure_since[side] = None
            continue
        if state.pressure_since[side] is None:
            state.pressure_since[side] = event.minute
        held = event.minute - state.pressure_since[side] >= cfg.pressure_minutes
        rested = event.minute - state.last_pressure_minute[side] >= cfg.pressure_cooldown_min
        if held and rested:
            state.last_pressure_minute[side] = event.minute
            state.pressure_since[side] = event.minute
            facts = [("pressure", level), ("shots", state.tally[side].shots)]
            found.append(_moment(state, event, "sustained_pressure", side, facts, from_event=False))
    return found


def apply(
    state: MatchState, event: MatchEvent, cfg: AnalyticsConfig, *, snapshots: bool = True
) -> list[KeyMoment | StatsSnapshot | PressureSnapshot]:
    at = event.minute * 60 + event.second
    decay = 0.5 ** (max(0.0, at - state.clock) / cfg.half_life_s)
    state.clock = at
    for side in SIDES:
        state.grid[side] = [value * decay for value in state.grid[side]]

    out: list = [*_record(state, event, cfg), *_swing(state, event, cfg), *_sustained(state, event, cfg)]
    if not snapshots:
        return out

    period_end = event.type if event.type in ("half_time", "full_time") else None
    if event.minute > state.snapshot_minute or period_end:
        state.snapshot_minute = event.minute
        out.append(
            StatsSnapshot(
                id=f"{state.match_id}-s{event.seq}",
                match_id=state.match_id,
                minute=event.minute,
                home=_team_stats(state, "home"),
                away=_team_stats(state, "away"),
                momentum=round(momentum(state), 3),
                period_end=period_end,
            )
        )
        out.append(
            PressureSnapshot(
                id=f"{state.match_id}-p{event.seq}",
                match_id=state.match_id,
                minute=event.minute,
                cols=COLS,
                rows=ROWS,
                home=[round(v, 2) for v in state.grid["home"]],
                away=[round(v, 2) for v in state.grid["away"]],
            )
        )
    return out
