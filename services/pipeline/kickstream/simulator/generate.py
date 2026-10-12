"""Generate a full synthetic match. The same seed always produces the same events.

Positions are tracked as `ax`, the distance along the attacking direction of the side
in possession (0-100), and converted to pitch coordinates when an event is emitted.
"""

import random
from dataclasses import dataclass, field

from kickstream.contracts import MatchEvent, TeamSheet
from kickstream.domain.pitch import xg
from kickstream.domain.types import SIDES, Side, other

HALF = 2700.0
FULL = 5400.0
_SHOT_WEIGHT = {"FW": 5, "MF": 3, "DF": 1}


def _clamp(value: float, low: float = 3.0, high: float = 97.0) -> float:
    return max(low, min(high, value))


@dataclass
class _Sim:
    match_id: str
    rng: random.Random
    sheets: dict[Side, TeamSheet]
    events: list[MatchEvent] = field(default_factory=list)
    on_pitch: dict[Side, list[str]] = field(default_factory=dict)
    bench: dict[Side, list[str]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for side, sheet in self.sheets.items():
            ids = [player.id for player in sheet.players]
            self.on_pitch[side], self.bench[side] = ids[:11], ids[11:]

    def _position(self, side: Side, player_id: str) -> str:
        return next(p.position for p in self.sheets[side].players if p.id == player_id)

    def keeper(self, side: Side) -> str:
        keepers = [p for p in self.on_pitch[side] if self._position(side, p) == "GK"]
        return keepers[0] if keepers else self.on_pitch[side][0]

    def outfield(self, side: Side) -> list[str]:
        return [p for p in self.on_pitch[side] if self._position(side, p) != "GK"]

    def passer(self, side: Side) -> str:
        return self.rng.choice(self.outfield(side))

    def shooter(self, side: Side) -> str:
        players = self.outfield(side)
        return self.rng.choices(players, [_SHOT_WEIGHT[self._position(side, p)] for p in players])[0]

    def emit(self, t: float, type_: str, side: Side | None = None, player_id: str | None = None,
             ax: float = 50.0, y: float = 50.0, **extra) -> None:
        seq = len(self.events) + 1
        x = 100.0 - ax if side == "away" else ax
        self.events.append(MatchEvent(
            id=f"{self.match_id}-e{seq}", match_id=self.match_id, seq=seq, minute=int(t // 60), second=int(t % 60),
            type=type_, team=side, player_id=player_id, x=round(x, 1), y=round(y, 1), **extra))

    def substitute(self, t: float, side: Side) -> None:
        if not self.bench[side] or not self.outfield(side):
            return
        leaving = self.rng.choice(self.outfield(side))
        arriving = self.bench[side].pop(0)
        self.on_pitch[side][self.on_pitch[side].index(leaving)] = arriving
        self.emit(t, "substitution", side, leaving, 50.0, 0.0, player_in_id=arriving)

    def send_off(self, side: Side, player_id: str) -> None:
        if len(self.outfield(side)) > 7:
            self.on_pitch[side].remove(player_id)


def _pass(sim: _Sim, t: float, side: Side, ax: float, y: float) -> tuple[Side, float, float]:
    completed = sim.rng.random() < 0.82
    sim.emit(t, "pass", side, sim.passer(side), ax, y, completed=completed)
    if completed:
        return side, _clamp(ax + sim.rng.uniform(-8.0, 18.0)), _clamp(y + sim.rng.uniform(-25.0, 25.0))
    return other(side), _clamp(100.0 - ax), y


def _foul(sim: _Sim, t: float, side: Side, ax: float, y: float) -> None:
    defending = other(side)
    offender = sim.passer(defending)
    sim.emit(t, "foul", defending, offender, 100.0 - ax, y)
    card = sim.rng.random()
    if card < 0.015:
        sim.emit(t, "red_card", defending, offender, 100.0 - ax, y)
        sim.send_off(defending, offender)
    elif card < 0.14:
        sim.emit(t, "yellow_card", defending, offender, 100.0 - ax, y)


def _corner(sim: _Sim, t: float, side: Side) -> tuple[Side, float, float, float]:
    sim.emit(t, "corner", side, sim.passer(side), 99.0, sim.rng.choice((1.0, 99.0)))
    return side, 88.0, sim.rng.uniform(35.0, 65.0), t


def _shot(sim: _Sim, t: float, side: Side, ax: float, y: float) -> tuple[Side, float, float, float]:
    rng, shooter, defending = sim.rng, sim.shooter(side), other(side)
    if rng.random() < xg(ax, y):
        sim.emit(t, "shot", side, shooter, ax, y, outcome="goal")
        sim.emit(t, "goal", side, shooter, 100.0, 50.0)
        boundary = HALF if t < HALF else FULL
        restart = max(t, min(t + 45.0, boundary - 1.0))
        sim.emit(restart, "kickoff", defending, sim.passer(defending))
        return defending, 50.0, 50.0, restart
    kind = rng.random()
    if kind < 0.40:
        sim.emit(t, "shot", side, shooter, ax, y, outcome="saved")
        sim.emit(t, "save", defending, sim.keeper(defending), 3.0, 50.0)
        if rng.random() < 0.30:
            return _corner(sim, t, side)
        return defending, 12.0, 50.0, t
    if kind < 0.75:
        sim.emit(t, "shot", side, shooter, ax, y, outcome="off_target")
        return defending, 10.0, 50.0, t
    sim.emit(t, "shot", side, shooter, ax, y, outcome="blocked")
    if rng.random() < 0.30:
        return _corner(sim, t, side)
    return defending, _clamp(100.0 - ax), y, t


def generate(match_id: str, seed: int, home: TeamSheet, away: TeamSheet) -> list[MatchEvent]:
    rng = random.Random(seed)
    sim = _Sim(match_id, rng, {"home": home, "away": away})
    sub_times = {side: sorted(rng.uniform(58 * 60, 82 * 60) for _ in range(3)) for side in SIDES}
    side: Side = "home"
    ax, y, t = 50.0, 50.0, 0.0
    second_half = False
    sim.emit(t, "kickoff", side, sim.passer(side))

    while True:
        t += rng.uniform(4.0, 13.0)
        if not second_half and t >= HALF:
            sim.emit(HALF, "half_time")
            second_half, side, ax, y, t = True, "away", 50.0, 50.0, HALF
            sim.emit(t, "kickoff", side, sim.passer(side))
            continue
        if t >= FULL:
            break
        for team in SIDES:
            while sub_times[team] and sub_times[team][0] <= t:
                sub_times[team].pop(0)
                sim.substitute(t, team)
        if ax >= 68.0 and rng.random() < 0.22:
            side, ax, y, t = _shot(sim, t, side, ax, y)
        elif rng.random() < 0.06:
            _foul(sim, t, side, ax, y)
            ax = _clamp(ax + rng.uniform(0.0, 6.0))
        else:
            side, ax, y = _pass(sim, t, side, ax, y)

    sim.emit(FULL, "full_time")
    return sim.events
