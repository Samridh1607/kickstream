"""Prediction Agent: who wins from here, who scores next, what the side on the ball does next, and where
the danger is. Everything is estimated from the events seen so far in this match; nothing is known ahead.
"""

import math

from kickstream.agents.base import POSSESSION, Declared, clock, fade
from kickstream.contracts import NextAction, PlayEvent, Prediction
from kickstream.domain.pitch import COLS, ROWS, attacking_x, xg, zone_index
from kickstream.domain.types import SIDES, Side, other

MATCH_MINUTES = 90
BASE_GOALS = 1.35  # goals a side is expected to score in a match before anything is seen
TRUST_BY = 45  # minute by which this match's own numbers are fully trusted
MOMENTUM_WEIGHT = 0.25
RED_CARD_FACTOR = 0.8
NEXT_GOAL_MIN = 10
MAX_GOALS = 8
ACTIONS = ("pass", "shot", "turnover")
# What a side does next from each third before this match has shown anything: pass, shot, lose it.
PRIOR = {
    "defensive_third": (7.0, 0.0, 2.0),
    "middle_third": (7.0, 0.3, 2.0),
    "attacking_third": (5.0, 2.0, 2.0),
}


def poisson(mean: float, most: int = MAX_GOALS) -> list[float]:
    return [math.exp(-mean) * mean**goals / math.factorial(goals) for goals in range(most + 1)]


def outcome_odds(lead: int, home_mean: float, away_mean: float) -> tuple[float, float, float]:
    """Home win, draw, away win, given the home side's lead now and the goals each is still expected to score."""
    win = draw = loss = 0.0
    for home_goals, home_chance in enumerate(poisson(home_mean)):
        for away_goals, away_chance in enumerate(poisson(away_mean)):
            chance = home_chance * away_chance
            margin = lead + home_goals - away_goals
            if margin > 0:
                win += chance
            elif margin == 0:
                draw += chance
            else:
                loss += chance
    total = win + draw + loss
    return win / total, draw / total, loss / total


class PredictionAgent:
    declared = Declared(
        id="prediction",
        name="Prediction Agent",
        description="Forecasts likely next moves or danger areas.",
        instructions=(
            "Once a match minute, forecast from what this match has shown so far. Estimate each side's "
            "scoring rate from its expected goals, its momentum and the players it has left, then give the "
            "odds of a home win, a draw and an away win, and each side's chance of scoring in the next ten "
            "minutes. From how moves have continued from each third, give the odds that the side on the ball "
            "passes, shoots or loses it. Mark the zones the danger has been coming from. State odds, never "
            "certainties."
        ),
        triggers=("play",),
        tools=(
            (
                "scoring_rate",
                "Blends a league-average rate with this match's expected goals, momentum and red cards.",
            ),
            ("poisson", "Turns the two scoring rates and the score into win, draw and loss odds."),
            ("transitions", "Counts what followed each touch in each third of this match."),
            ("danger_grid", "A fading map of where dangerous touches have been."),
        ),
        outputs=("prediction",),
        upstream=("event_interpreter",),
    )
    accepts = (PlayEvent,)

    def __init__(self) -> None:
        self.note = ""
        self._minute = 0
        self._clock = 0
        self._goals = {side: 0 for side in SIDES}
        self._xg = {side: 0.0 for side in SIDES}
        self._reds = {side: 0 for side in SIDES}
        self._danger = {side: [0.0] * (COLS * ROWS) for side in SIDES}
        self._seen = {zone: [0.0, 0.0, 0.0] for zone in PRIOR}
        self._last: PlayEvent | None = None  # the latest touch by the side in possession
        self._located = False

    def handle(self, play: PlayEvent) -> list[Prediction]:
        self._take(play)
        if play.minute <= self._minute:
            return []
        self._minute = play.minute
        return [self._predict(play.match_id, play.minute)]

    def _take(self, play: PlayEvent) -> None:
        at = clock(play.minute, play.second)
        for side in SIDES:
            self._danger[side] = fade(self._danger[side], at - self._clock)
        self._clock = at
        self._located = self._located or bool(play.located)
        side = play.team
        if side is None:
            return
        if play.type == "red_card":
            self._reds[side] += 1
        if play.type not in POSSESSION:
            return
        if play.type == "goal":
            self._goals[side] += 1
        elif play.type == "shot" and play.xg is not None:
            self._xg[side] += play.xg
        elif play.type == "shot" and play.located:
            self._xg[side] += xg(attacking_x(side, play.x), play.y)
        if not play.located:
            return
        self._danger[side][zone_index(play.x, play.y)] += play.danger
        if self._last is not None:
            followed = (
                "turnover" if side != self._last.team else "shot" if play.type in ("shot", "goal") else "pass"
            )
            self._seen[self._last.zone][ACTIONS.index(followed)] += 1
        self._last = play

    def _momentum(self) -> float:
        home, away = sum(self._danger["home"]), sum(self._danger["away"])
        return (home - away) / (home + away + 1.0)

    def _rate(self, side: Side, minute: int) -> float:
        """Goals a minute this side is expected to score from here."""
        base = rate = BASE_GOALS / MATCH_MINUTES
        if self._located:
            trust = min(1.0, minute / TRUST_BY)
            seen = self._xg[side] / max(1, minute)
            rate = (1 - trust) * base + trust * (0.5 * base + 0.5 * seen)
            swing = self._momentum() if side == "home" else -self._momentum()
            rate *= 1 + MOMENTUM_WEIGHT * swing
        rate *= RED_CARD_FACTOR ** self._reds[side]
        rate /= RED_CARD_FACTOR ** self._reds[other(side)]
        return max(rate, 0.0005)

    def _next_actions(self) -> list[NextAction]:
        if self._last is None:
            return []
        weights = [
            seen + prior
            for seen, prior in zip(self._seen[self._last.zone], PRIOR[self._last.zone], strict=True)
        ]
        total = sum(weights)
        return [
            NextAction(action=action, probability=round(weight / total, 3))
            for action, weight in zip(ACTIONS, weights, strict=True)
        ]

    def _predict(self, match_id: str, minute: int) -> Prediction:
        remaining = max(0, MATCH_MINUTES - minute)
        rates = {side: self._rate(side, minute) for side in SIDES}
        win, draw, loss = outcome_odds(
            self._goals["home"] - self._goals["away"], rates["home"] * remaining, rates["away"] * remaining
        )
        soon = min(NEXT_GOAL_MIN, remaining)
        merged = [home + away for home, away in zip(self._danger["home"], self._danger["away"], strict=True)]
        peak = max(merged) or 1.0
        self.note = f"home {win:.0%}, draw {draw:.0%}, away {loss:.0%}"
        return Prediction(
            id=f"{match_id}-f{minute}",
            match_id=match_id,
            minute=minute,
            win_home=round(win, 3),
            draw=round(draw, 3),
            win_away=round(loss, 3),
            next_goal_home=round(1 - math.exp(-rates["home"] * soon), 3),
            next_goal_away=round(1 - math.exp(-rates["away"] * soon), 3),
            possession=self._last.team if self._last else None,
            next_actions=self._next_actions(),
            cols=COLS,
            rows=ROWS,
            danger=[round(value / peak, 3) for value in merged],
        )
