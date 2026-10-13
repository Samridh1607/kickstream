"""Event Interpreter: turns each raw detection into a structured event of play.

There is no video in this repository. The match feed stands in for a detector's output; a real
detector would publish to the same topic and this agent would not change.
"""

from kickstream.agents.base import POSSESSION, Declared
from kickstream.contracts import MatchEvent, PlayEvent
from kickstream.domain.pitch import attacking_x, xg
from kickstream.domain.types import Side

THIRD = 100.0 / 3.0
TRANSITION_PLAYS = 3  # how long a move counts as a transition after the ball is won
TRANSITION_FROM = 35.0  # and only once it is out of its own defensive area


def zone_of(side: Side | None, x: float) -> str:
    along = x if side is None else attacking_x(side, x)
    return "defensive_third" if along < THIRD else "middle_third" if along < 2 * THIRD else "attacking_third"


def lane_of(side: Side | None, y: float) -> str:
    """The flank as the side sees it. The away side attacks the other way, so its left is the far touchline."""
    across = 100.0 - y if side == "away" else y
    return "left" if across < THIRD else "centre" if across < 2 * THIRD else "right"


def danger_of(side: Side, x: float, y: float) -> float:
    """How threatening the ball is here, 0 to 1: the chance of a shot going in, plus ground gained."""
    along = attacking_x(side, x)
    return round(min(1.0, xg(along, y) * 1.5 + max(0.0, along - 50.0) / 100.0 * 0.4), 3)


class EventInterpreter:
    declared = Declared(
        id="event_interpreter",
        name="Event Interpreter",
        description="Converts video detections into structured events.",
        instructions=(
            "For every detection, say where on the pitch it happened as the team in possession sees it "
            "(third and flank), which phase of play it belongs to, which possession sequence it is part of "
            "and how long that sequence has run, and how dangerous the ball is at that spot. Never invent "
            "an event: one detection in, one structured event out."
        ),
        triggers=("match_event",),
        tools=(
            ("locate", "Places a detection in a third and a flank, from the attacking side's point of view."),
            ("sequence", "Groups consecutive touches by one side into a possession sequence."),
            ("danger", "Scores a ball position from 0 to 1 by shot quality and ground gained."),
        ),
        outputs=("play",),
    )
    accepts = (MatchEvent,)

    def __init__(self) -> None:
        self.note = ""
        self._sequence = 0
        self._side: Side | None = None
        self._length = 0
        self._won_in_play = False

    def handle(self, event: MatchEvent) -> list[PlayEvent]:
        side = event.team
        danger = 0.0
        if event.type == "kickoff":
            self._start(side, won_in_play=False)
            phase = "restart"
        elif event.type in POSSESSION and side is not None:
            if side != self._side:
                self._start(side, won_in_play=self._side is not None)
            self._length += 1
            danger = danger_of(side, event.x, event.y)
            phase = self._phase(event, side)
        elif event.type in ("substitution", "half_time", "full_time"):
            phase = "restart"
        else:
            phase = "defending"  # a foul, a card or a save belongs to the side without the ball
        self.note = f"sequence {self._sequence}, {phase.replace('_', ' ')}"
        return [
            PlayEvent(
                id=f"{event.match_id}-y{event.seq}",
                match_id=event.match_id,
                minute=event.minute,
                second=event.second,
                event_id=event.id,
                type=event.type,
                team=side,
                player_id=event.player_id,
                x=event.x,
                y=event.y,
                zone=zone_of(side, event.x),
                lane=lane_of(side, event.y),
                phase=phase,
                sequence=self._sequence,
                sequence_length=self._length,
                danger=danger,
                outcome=event.outcome,
                completed=event.completed,
                player_in_id=event.player_in_id,
            )
        ]

    def _start(self, side: Side | None, *, won_in_play: bool) -> None:
        self._sequence += 1
        self._side = side
        self._length = 0
        self._won_in_play = won_in_play

    def _phase(self, event: MatchEvent, side: Side) -> str:
        if event.type == "corner":
            return "set_piece"
        along = attacking_x(side, event.x)
        if self._won_in_play and self._length <= TRANSITION_PLAYS and along >= TRANSITION_FROM:
            return "transition"
        return "final_third" if along >= 2 * THIRD else "progression" if along >= THIRD else "build_up"
