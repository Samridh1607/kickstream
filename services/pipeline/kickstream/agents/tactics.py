"""Tactical Analyst: pressure, rhythm and the patterns each side is playing, once a match minute."""

from collections import deque

from kickstream.agents.base import POSSESSION, Declared
from kickstream.contracts import PlayEvent, TacticalInsight, TeamTactics
from kickstream.domain.momentum import in_control
from kickstream.domain.pitch import attacking_x
from kickstream.domain.types import SIDES, Side, other

WINDOW_MIN = 10  # what "lately" means for patterns
RHYTHM_MIN = 3  # rhythm is felt over a shorter stretch
PRESSURE_FULL = 0.6  # danger per minute that counts as full pressure
MIN_PLAYS = 12  # touches a side needs in the window before a pattern is named
HIGH_REGAINS = 5
OVERLOAD_SHARE = 0.45
CENTRAL_SHARE = 0.5
COUNTER_SHARE = 0.4  # of a side's touches made straight after winning the ball
PATIENT_SEQUENCE = 5.0
DIRECT_SEQUENCE = 2.2
LOW_BLOCK_TILT = 25.0
MAX_PATTERNS = 4
LANES = ("left", "centre", "right")

PATTERN_PHRASES = {
    "high_press": "winning the ball high up the pitch",
    "wing_overload_left": "overloading the left wing",
    "wing_overload_right": "overloading the right wing",
    "central_play": "playing through the middle",
    "counter_attack": "breaking on the counter",
    "patient_build_up": "building patiently",
    "direct_play": "playing direct",
    "low_block": "sitting deep in a low block",
}


def rhythm_of(passes_per_minute: float) -> str:
    if passes_per_minute < 5.0:
        return "slow"
    if passes_per_minute < 6.5:
        return "steady"
    return "fast" if passes_per_minute < 8.0 else "frantic"


def control_or_chaos(names: dict[Side, str], control: Side | None, rhythm: str) -> tuple[str, str] | None:
    """One labelled fact: who holds control, or chaos when the game is frantic and nobody does."""
    if control is not None:
        return "control", f"{names[control]} are in control"
    if rhythm == "frantic":
        return "chaos", "the rhythm is frantic and neither side is in control"
    return None


class TacticalAnalyst:
    declared = Declared(
        id="tactical_analyst",
        name="Tactical Analyst",
        description="Detects pressure, rhythm, and tactical patterns.",
        instructions=(
            "Once a match minute, look at the last ten minutes of play. For each side measure attacking "
            "pressure, passing tempo, field tilt, the usual length of a move and which flank it uses, then "
            "name the patterns the numbers support. Call the rhythm of the game from the last three minutes. "
            "Name a pattern only when its threshold is met."
        ),
        triggers=("play",),
        tools=(
            ("window", "Keeps the last ten minutes of structured events."),
            ("field_tilt", "Each side's share of touches in the final third."),
            ("regains", "Counts the times a side won the ball in the opponent's half."),
            ("patterns", "Tests each named pattern against its threshold."),
        ),
        outputs=("tactics",),
        upstream=("event_interpreter",),
    )
    accepts = (PlayEvent,)

    def __init__(self, names: dict[Side, str]) -> None:
        self.note = ""
        self._names = names
        self._plays: deque[PlayEvent] = deque()
        self._regains: deque[tuple[int, Side]] = deque()
        self._sequences: deque[tuple[int, Side, int]] = deque()  # minute it ended, side, length
        self._open: tuple[int, Side, int] | None = None  # the sequence being played: number, side, length
        self._minute = 0
        self.momentum: float | None = None  # the analytics' latest, set by the orchestrator

    def handle(self, play: PlayEvent) -> list[TacticalInsight]:
        due = play.minute > self._minute
        insight = self._insight(play.match_id, play.minute) if due else None
        self._minute = max(self._minute, play.minute)
        self._take(play)
        return [insight] if insight else []

    def _take(self, play: PlayEvent) -> None:
        if play.type not in POSSESSION or play.team is None or not play.located:
            return
        self._plays.append(play)
        if self._open is None or self._open[0] != play.sequence:
            if self._open is not None:
                self._sequences.append((play.minute, self._open[1], self._open[2]))
            if play.phase == "transition" and attacking_x(play.team, play.x) >= 50.0:
                self._regains.append((play.minute, play.team))
        self._open = (play.sequence, play.team, play.sequence_length)
        horizon = play.minute - WINDOW_MIN
        while self._plays and self._plays[0].minute < horizon:
            self._plays.popleft()
        while self._regains and self._regains[0][0] < horizon:
            self._regains.popleft()
        while self._sequences and self._sequences[0][0] < horizon:
            self._sequences.popleft()

    def _team(self, side: Side, minutes: float) -> TeamTactics:
        mine = [play for play in self._plays if play.team == side]
        theirs = [play for play in self._plays if play.team == other(side)]
        final_third = sum(play.zone == "attacking_third" for play in mine)
        their_final_third = sum(play.zone == "attacking_third" for play in theirs)
        both = final_third + their_final_third
        tilt = 50.0 if both == 0 else final_third / both * 100
        lengths = [length for _, owner, length in self._sequences if owner == side]
        average = sum(lengths) / len(lengths) if lengths else 0.0
        lanes = [sum(play.lane == lane for play in mine) / len(mine) if mine else 1 / 3 for lane in LANES]
        tempo = sum(play.type == "pass" for play in mine) / minutes
        pressure = min(100.0, sum(play.danger for play in mine) / minutes / PRESSURE_FULL * 100)
        deep = sum(play.zone == "defensive_third" for play in mine) / len(mine) if mine else 0.0

        return TeamTactics(
            pressure=round(pressure, 1),
            tempo=round(tempo, 2),
            field_tilt=round(tilt, 1),
            avg_sequence=round(average, 2),
            lanes=[round(share, 3) for share in lanes],
            patterns=self._patterns(side, mine, lanes, lengths, average, tilt if both else None, deep),
        )

    def _patterns(self, side: Side, mine: list[PlayEvent], lanes, lengths, average, tilt, deep) -> list[str]:
        if len(mine) < MIN_PLAYS:
            return []
        patterns = []
        if sum(owner == side for _, owner in self._regains) >= HIGH_REGAINS:
            patterns.append("high_press")
        if sum(play.phase == "transition" for play in mine) / len(mine) >= COUNTER_SHARE:
            patterns.append("counter_attack")
        if lanes[0] >= OVERLOAD_SHARE:
            patterns.append("wing_overload_left")
        if lanes[2] >= OVERLOAD_SHARE:
            patterns.append("wing_overload_right")
        if lanes[1] >= CENTRAL_SHARE:
            patterns.append("central_play")
        if lengths and average >= PATIENT_SEQUENCE:
            patterns.append("patient_build_up")
        if lengths and average <= DIRECT_SEQUENCE:
            patterns.append("direct_play")
        if tilt is not None and tilt <= LOW_BLOCK_TILT and deep >= 0.5:
            patterns.append("low_block")
        return patterns[:MAX_PATTERNS]

    def _insight(self, match_id: str, minute: int) -> TacticalInsight:
        minutes = float(max(1, min(WINDOW_MIN, minute)))
        teams = {side: self._team(side, minutes) for side in SIDES}
        recent = sum(play.type == "pass" and play.minute >= minute - RHYTHM_MIN for play in self._plays)
        rhythm = rhythm_of(recent / max(1, min(RHYTHM_MIN, minute)))
        control = in_control(self.momentum) if self.momentum is not None else None
        summary = self._summary(teams, rhythm, control)
        self.note = summary
        return TacticalInsight(
            id=f"{match_id}-t{minute}",
            match_id=match_id,
            minute=minute,
            home=teams["home"],
            away=teams["away"],
            rhythm=rhythm,
            summary=summary,
            momentum=None if self.momentum is None else round(self.momentum, 3),
            control=control,
        )

    def _summary(self, teams: dict[Side, TeamTactics], rhythm: str, control: Side | None = None) -> str:
        parts = []
        for side in SIDES:
            phrases = [PATTERN_PHRASES[pattern] for pattern in teams[side].patterns[:2]]
            if phrases:
                parts.append(f"{self._names[side]} are {' and '.join(phrases)}")
        if not parts:
            leading = max(SIDES, key=lambda side: teams[side].field_tilt)
            parts.append(
                f"{self._names[leading]} have {teams[leading].field_tilt:.0f}% of the final-third play"
            )
        summary = f"{'; '.join(parts)}. The rhythm is {rhythm}."
        fact = control_or_chaos(self._names, control, rhythm)
        return summary if fact is None else f"{summary} {fact[0].capitalize()}: {fact[1]}."
