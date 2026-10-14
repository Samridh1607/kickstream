"""Player Tracking Agent: every player's numbers, so a viewer's favourite can be followed."""

from dataclasses import dataclass, field

from kickstream.agents.base import Declared
from kickstream.agents.squad import Squad
from kickstream.contracts import PlayerMetrics, PlayerReport, PlayEvent
from kickstream.domain.pitch import COLS, ROWS, attacking_x, xg, zone_index
from kickstream.domain.types import SIDES

BASE_RATING = 6.0


@dataclass
class _Line:
    touches: int = 0
    passes: int = 0
    completed: int = 0
    shots: int = 0
    on_target: int = 0
    goals: int = 0
    xg: float = 0.0
    fouls: int = 0
    yellow: int = 0
    red: int = 0
    saves: int = 0
    heat: list[float] = field(default_factory=lambda: [0.0] * (COLS * ROWS))


def rating(line: _Line) -> float:
    """A match rating out of ten, starting from six: reward what helps the side, dock what hurts it."""
    missed = line.passes - line.completed
    value = (
        BASE_RATING
        + 0.9 * line.goals
        + 0.25 * line.on_target
        + 0.1 * line.shots
        + 0.6 * line.xg
        + 0.02 * line.completed
        + 0.3 * line.saves
        - 0.03 * missed
        - 0.15 * line.fouls
        - 0.5 * line.yellow
        - 1.5 * line.red
    )
    return round(max(0.0, min(10.0, value)), 1)


class PlayerTracker:
    declared = Declared(
        id="player_tracking",
        name="Player Tracking Agent",
        description="Follows favorite player and computes personal metrics.",
        instructions=(
            "Credit every structured event to the player who made it and keep each player's touches, passes "
            "and accuracy, shots, expected goals, goals, fouls and cards, where on the pitch they have been, "
            "and a rating out of ten. Report every player once a match minute; the viewer's favourite is "
            "picked out of the report for them."
        ),
        triggers=("play",),
        tools=(
            ("credit", "Adds an event to the line of the player who made it."),
            ("rating", "Scores a player's match out of ten from their line."),
            ("heat", "Counts a player's touches in each zone of the pitch."),
        ),
        outputs=("players",),
        upstream=("event_interpreter",),
    )
    accepts = (PlayEvent,)

    def __init__(self, squad: Squad) -> None:
        self.note = ""
        self._squad = squad
        self._lines: dict[str, _Line] = {}
        self._minute = 0

    def handle(self, play: PlayEvent) -> list[PlayerReport]:
        self._credit(play)
        if play.minute <= self._minute:
            return []
        self._minute = play.minute
        return [self._report(play.match_id, play.minute)]

    def _credit(self, play: PlayEvent) -> None:
        if play.team is None or play.player_id is None:
            return
        line = self._lines.setdefault(play.player_id, _Line())
        if play.type in ("pass", "corner", "shot"):
            line.touches += 1
            if play.located:
                line.heat[zone_index(play.x, play.y)] += 1
        if play.type == "pass":
            line.passes += 1
            line.completed += 1 if play.completed else 0
        elif play.type == "shot":
            line.shots += 1
            if play.xg is not None:
                line.xg += play.xg
            elif play.located:
                line.xg += xg(attacking_x(play.team, play.x), play.y)
            line.on_target += 1 if play.outcome in ("goal", "saved") else 0
        elif play.type == "goal":
            line.goals += 1
        elif play.type == "save":
            line.saves += 1
        elif play.type == "foul":
            line.fouls += 1
        elif play.type == "yellow_card":
            line.yellow += 1
        elif play.type == "red_card":
            line.red += 1

    def _report(self, match_id: str, minute: int) -> PlayerReport:
        players = []
        for side in SIDES:
            playing = set(self._squad.on_pitch[side])
            for player in self._squad.sheets[side].players:
                line = self._lines.get(player.id, _Line())
                accuracy = 0.0 if line.passes == 0 else round(line.completed / line.passes * 100, 1)
                players.append(
                    PlayerMetrics(
                        player_id=player.id,
                        team=side,
                        name=player.name,
                        number=player.number,
                        position=player.position,
                        on_pitch=player.id in playing,
                        touches=line.touches,
                        passes=line.passes,
                        pass_accuracy=accuracy,
                        shots=line.shots,
                        shots_on_target=line.on_target,
                        goals=line.goals,
                        xg=round(line.xg, 2),
                        fouls=line.fouls,
                        yellow_cards=line.yellow,
                        red_cards=line.red,
                        rating=rating(line),
                        heat=line.heat,
                    )
                )
        best = max(players, key=lambda player: (player.rating, player.touches))
        self.note = f"best so far: {best.name} ({best.rating})"
        return PlayerReport(
            id=f"{match_id}-pl{minute}",
            match_id=match_id,
            minute=minute,
            cols=COLS,
            rows=ROWS,
            players=players,
        )
