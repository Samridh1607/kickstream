"""The latest of what the pipeline knows about the current match, for auto live's commentary."""

from collections import deque

from pydantic import BaseModel

from kickstream.contracts import (
    Explanation,
    FanZone,
    Highlight,
    KeyMoment,
    MatchStatus,
    Narrative,
    PlayerMetrics,
    PlayerReport,
    Prediction,
    StatsSnapshot,
    TacticalInsight,
)

_ENDED = ("finished", "abandoned")
_MOMENT = {
    "goal": "a goal",
    "red_card": "a red card",
    "big_chance": "a big chance",
    "momentum_swing": "a swing in momentum",
    "sustained_pressure": "a spell of sustained pressure",
}
_PATTERN = {
    "high_press": "a high press",
    "wing_overload_left": "overloading the left wing",
    "wing_overload_right": "overloading the right wing",
    "central_play": "playing through the middle",
    "counter_attack": "counter-attacks",
    "patient_build_up": "patient build-up",
    "direct_play": "direct play",
    "low_block": "a low block",
}
_ACTION = {"pass": "a pass", "shot": "a shot", "turnover": "losing the ball"}


def pct(value: float) -> str:
    return f"{round(value * 100)} percent"


def ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


class MatchFacts:
    """Follows one match at a time: the newest match to send a status that has not ended."""

    def __init__(self) -> None:
        self.match_id: str | None = None
        self._clear()

    def _clear(self) -> None:
        self.status: MatchStatus | None = None
        self.stats: StatsSnapshot | None = None
        self.tactics: TacticalInsight | None = None
        self.prediction: Prediction | None = None
        self.explanation: Explanation | None = None
        self.players: PlayerReport | None = None
        self.moments: deque[KeyMoment] = deque(maxlen=6)
        self.narratives: deque[Narrative] = deque(maxlen=4)
        self.highlights: deque[Highlight] = deque(maxlen=6)

    def take(self, match_id: str, payload: BaseModel) -> None:
        if isinstance(payload, MatchStatus):
            if match_id != self.match_id:
                # A replaced match is announced abandoned after its successor starts: never go back to it.
                if payload.state in _ENDED:
                    return
                self.match_id = match_id
                self._clear()
            self.status = payload
            return
        if match_id != self.match_id:
            return
        if isinstance(payload, StatsSnapshot):
            self.stats = payload
        elif isinstance(payload, TacticalInsight):
            self.tactics = payload
        elif isinstance(payload, Prediction):
            self.prediction = payload
        elif isinstance(payload, Explanation) and payload.mode == "fan":
            self.explanation = payload
        elif isinstance(payload, PlayerReport):
            self.players = payload
        elif isinstance(payload, KeyMoment):
            self.moments.append(payload)
        elif isinstance(payload, Narrative) and payload.mode == "fan" and payload.language == "en":
            self.narratives.append(payload)
        elif isinstance(payload, Highlight):
            self.highlights.append(payload)

    # --- read in words ----------------------------------------------------------------------------

    def name(self, side: str) -> str:
        if self.status is None:
            return "the home side" if side == "home" else "the away side"
        return (self.status.home if side == "home" else self.status.away).name

    def score(self) -> str:
        s = self.status
        if s is None:
            return ""
        if s.score_home == s.score_away:
            return f"{s.home.name} and {s.away.name} level at {s.score_home} all"
        lead, trail = ("home", "away") if s.score_home > s.score_away else ("away", "home")
        high, low = max(s.score_home, s.score_away), min(s.score_home, s.score_away)
        return f"{self.name(lead)} lead {self.name(trail)} {high} {low}"

    def clock(self) -> str:
        s = self.status
        if s is None:
            return ""
        return {
            "pre_match": "before kick-off",
            "half_time": "at half-time",
            "finished": "at full-time",
            "abandoned": "with the match stopped",
        }.get(s.state, f"in the {ordinal(max(s.minute, 1))} minute")

    def top_player(self) -> PlayerMetrics | None:
        players = self.players.players if self.players else []
        return max(players, key=lambda p: (p.rating, p.touches), default=None)

    def moment(self, moment: KeyMoment) -> str:
        who = self.player_name(moment.player_id)
        by = f" by {who}" if who else ""
        return f"{_MOMENT.get(moment.kind, moment.kind)}{by} for {self.name(moment.team)} in the {ordinal(moment.minute)} minute"

    def player_name(self, player_id: str | None) -> str | None:
        if self.status is None or player_id is None:
            return None
        for team in (self.status.home, self.status.away):
            for player in team.players:
                if player.id == player_id:
                    return player.name
        return None

    def patterns(self, side: str) -> list[str]:
        if self.tactics is None:
            return []
        team = self.tactics.home if side == "home" else self.tactics.away
        return [_PATTERN.get(p, p.replace("_", " ")) for p in team.patterns]

    def next_action(self) -> str | None:
        p = self.prediction
        if p is None or not p.next_actions or p.possession is None:
            return None
        best = max(p.next_actions, key=lambda a: a.probability)
        return f"with {self.name(p.possession)} on the ball, the likeliest next move is {_ACTION.get(best.action, best.action)}, at {pct(best.probability)}"

    def labelled(self, fans: FanZone | None = None) -> tuple[tuple[str, str], ...]:
        """Every fact, labelled, for a model to word. Only what the pipeline measured."""
        facts: list[tuple[str, str]] = []
        s = self.status
        if s is not None:
            facts.append(("Match", f"{s.home.name} vs {s.away.name}"))
            if s.competition:
                facts.append(("Competition", s.competition))
            facts.append(("State", s.state.replace("_", " ")))
            facts.append(("Minute", str(s.minute)))
            facts.append(("Score", f"{s.home.name} {s.score_home}, {s.away.name} {s.score_away}"))
        if self.stats is not None:
            h, a = self.stats.home, self.stats.away
            facts.append(
                (
                    "Possession",
                    f"{s.home.name if s else 'home'} {h.possession:.0f}%, {s.away.name if s else 'away'} {a.possession:.0f}%",
                )
            )
            facts.append(
                ("Shots (on target)", f"{h.shots} ({h.shots_on_target}) to {a.shots} ({a.shots_on_target})")
            )
            facts.append(("Expected goals", f"{h.xg:.2f} to {a.xg:.2f}"))
            facts.append(("Pass accuracy", f"{h.pass_accuracy:.0f}% to {a.pass_accuracy:.0f}%"))
        if self.prediction is not None:
            p = self.prediction
            facts.append(
                ("Win probability", f"home {pct(p.win_home)}, draw {pct(p.draw)}, away {pct(p.win_away)}")
            )
            facts.append(
                (
                    "Next ten minutes, chance to score",
                    f"home {pct(p.next_goal_home)}, away {pct(p.next_goal_away)}",
                )
            )
            if action := self.next_action():
                facts.append(("Next action", action))
        if self.tactics is not None:
            facts.append(("Tactics", self.tactics.summary))
            facts.append(("Rhythm", self.tactics.rhythm))
        if self.explanation is not None:
            facts.append(("Why it matters", f"{self.explanation.headline}. {self.explanation.why}"))
        if (player := self.top_player()) is not None:
            facts.append(
                (
                    "Best rated player",
                    f"{player.name} ({self.name(player.team)}), rating {player.rating:.1f}, {player.goals} goals, {player.touches} touches",
                )
            )
        if self.moments:
            facts.append(("Latest key moment", self.moment(self.moments[-1])))
        if self.highlights:
            h = self.highlights[-1]
            facts.append(("Latest highlight", f"{h.title}: {h.reason}"))
        if self.narratives:
            facts.append(("Latest commentary line", self.narratives[-1].text))
        if fans is not None and fans.summary.total:
            facts.append(("Fans", fans.summary.text))
            if fans.poll is not None:
                facts.append(("Fan poll", fans.poll.question))
        return tuple(facts)
