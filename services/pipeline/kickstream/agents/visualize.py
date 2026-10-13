"""Visualization Agent: the data a 3D pitch and its overlays are drawn from.

The feed names the ball and the player on it, not where the other players are. Their positions here are
estimated from the formation and the ball, and every such player is marked `estimated`.
"""

import math
from collections import deque

from kickstream.agents.base import POSSESSION, Declared, clock, fade
from kickstream.agents.squad import Squad
from kickstream.contracts import DangerColumn, PassLane, PitchScene, PlayEvent, Point3, ScenePlayer
from kickstream.domain.pitch import COLS, ROWS, attacking_x, zone_index
from kickstream.domain.types import SIDES

LINE_DEPTH = {"GK": 5.0, "DF": 24.0, "MF": 46.0, "FW": 68.0}  # how far up its own attack each line stands
PUSH_WITH_BALL = 0.45  # how far a side's shape follows the ball when it has it
PUSH_WITHOUT = 0.35  # and when it does not
PULL_ACROSS = 0.15  # how far players shift across towards the ball
ARC_POINTS = 6
MAX_COLUMNS = 6
MAX_LANES = 5
ATTACK_VIEW_FROM = 70.0


def _arc(start: tuple[float, float], end: tuple[float, float], peak: float) -> list[Point3]:
    """The ball's flight from one spot to the next: a parabola that lands where it is now."""
    points = []
    for step in range(ARC_POINTS):
        t = step / (ARC_POINTS - 1)
        points.append(
            Point3(
                x=round(start[0] + (end[0] - start[0]) * t, 1),
                y=round(start[1] + (end[1] - start[1]) * t, 1),
                z=round(peak * 4 * t * (1 - t), 2),
            )
        )
    return points


def _peak(play: PlayEvent, distance: float) -> float:
    if play.type == "corner":
        return 6.0
    if play.type in ("shot", "goal"):
        return 1.5
    return round(min(8.0, distance / 100.0 * 12.0), 2)


class VisualizationAgent:
    declared = Declared(
        id="visualization",
        name="Visualization Agent",
        description="Generates 3D pitch and overlay data.",
        instructions=(
            "For every structured event, describe the picture: the ball and the arc it flew, each player's "
            "position, columns that rise where each side has been dangerous, the pass lanes of the current "
            "move, and where a camera should look. Only the player on the ball is known; place the others "
            "from their formation and the ball, and mark them as estimated."
        ),
        triggers=("play",),
        tools=(
            ("ball_arc", "Gives the ball height along its path from the last touch."),
            ("formation", "Estimates where each player stands from their line and the ball."),
            ("danger_columns", "Raises a column over each zone a side has threatened from."),
            ("camera", "Chooses a broadcast, tactical or attacking view."),
        ),
        outputs=("pitch_scene",),
        upstream=("event_interpreter",),
    )
    accepts = (PlayEvent,)

    def __init__(self, squad: Squad) -> None:
        self.note = ""
        self._squad = squad
        self._ball = (50.0, 50.0)
        self._clock = 0
        self._danger = {side: [0.0] * (COLS * ROWS) for side in SIDES}
        self._lanes: deque[PassLane] = deque(maxlen=MAX_LANES)
        self._sequence = 0

    def handle(self, play: PlayEvent) -> list[PitchScene]:
        at = clock(play.minute, play.second)
        for side in SIDES:
            self._danger[side] = fade(self._danger[side], at - self._clock)
        self._clock = at

        start, end = self._ball, (play.x, play.y)
        in_possession = play.type in POSSESSION and play.team is not None
        if play.sequence != self._sequence:
            self._lanes.clear()
            self._sequence = play.sequence
        elif in_possession and start != end:
            self._lanes.append(
                PassLane(
                    from_x=start[0], from_y=start[1], to_x=end[0], to_y=end[1], team=play.team, weight=1.0
                )
            )
        if in_possession:
            self._danger[play.team][zone_index(play.x, play.y)] += play.danger
        self._ball = end

        camera = self._camera(play)
        self.note = f"{camera.replace('_', ' ')} view, ball at {play.x:.0f},{play.y:.0f}"
        return [
            PitchScene(
                id=f"{play.match_id}-v{play.id[len(play.match_id) + 2 :]}",  # the play's number
                match_id=play.match_id,
                minute=play.minute,
                second=play.second,
                ball=Point3(x=play.x, y=play.y, z=0.0),
                trail=_arc(start, end, _peak(play, math.dist(start, end))),
                players=self._players(play),
                columns=self._columns(),
                lanes=self._faded_lanes(),
                camera=camera,
                focus_x=play.x,
                focus_y=play.y,
            )
        ]

    def _camera(self, play: PlayEvent) -> str:
        if play.phase == "restart":
            return "tactical"
        if play.team is not None and play.type in POSSESSION:
            if attacking_x(play.team, play.x) >= ATTACK_VIEW_FROM:
                return f"attack_{play.team}"
        return "broadcast"

    def _players(self, play: PlayEvent) -> list[ScenePlayer]:
        placed = []
        for side in SIDES:
            has_ball = play.team == side and play.type in POSSESSION
            ball_along = attacking_x(side, play.x)
            push = (ball_along - 50.0) * (PUSH_WITH_BALL if has_ball else PUSH_WITHOUT)
            lines: dict[str, list] = {}
            for player_id in self._squad.on_pitch[side]:
                player = self._squad.player(player_id)
                if player is not None:
                    lines.setdefault(player.position, []).append(player)
            for position, players in lines.items():
                for index, player in enumerate(players):
                    if player.id == play.player_id and play.team == side:
                        placed.append(
                            ScenePlayer(
                                id=player.id, team=side, number=player.number, x=play.x, y=play.y,
                                on_ball=play.type in POSSESSION, estimated=False,
                            )
                        )  # fmt: skip
                        continue
                    along = LINE_DEPTH[position] + (0.0 if position == "GK" else push)
                    across = 50.0 if position == "GK" else (index + 1) / (len(players) + 1) * 100.0
                    across += (play.y - across) * (0.0 if position == "GK" else PULL_ACROSS)
                    along = max(2.0, min(98.0, along))
                    placed.append(
                        ScenePlayer(
                            id=player.id,
                            team=side,
                            number=player.number,
                            x=round(along if side == "home" else 100.0 - along, 1),
                            y=round(across, 1),
                            on_ball=False,
                            estimated=True,
                        )
                    )
        return placed

    def _columns(self) -> list[DangerColumn]:
        cells = [
            (value, side, index)
            for side in SIDES
            for index, value in enumerate(self._danger[side])
            if value > 0.05
        ]
        if not cells:
            return []
        peak = max(value for value, _, _ in cells)
        width, depth = 100.0 / COLS, 100.0 / ROWS
        return [
            DangerColumn(
                x=round((index % COLS) * width, 2),
                y=round((index // COLS) * depth, 2),
                width=round(width, 2),
                depth=round(depth, 2),
                team=side,
                intensity=round(value / peak, 3),
            )
            for value, side, index in sorted(cells, key=lambda cell: -cell[0])[:MAX_COLUMNS]
        ]

    def _faded_lanes(self) -> list[PassLane]:
        count = len(self._lanes)
        return [
            lane.model_copy(update={"weight": round((index + 1) / count, 2)})
            for index, lane in enumerate(self._lanes)
        ]
