"""Pitch geometry. Coordinates are 0-100 on both axes; home attacks toward x = 100."""

import math

from kickstream.domain.types import Side

COLS = 6
ROWS = 4
_PITCH_LENGTH_M = 105.0
_PITCH_WIDTH_M = 68.0


def attacking_x(side: Side, x: float) -> float:
    """Distance travelled along the attacking direction of `side`, 0-100."""
    return x if side == "home" else 100.0 - x


def zone_index(x: float, y: float) -> int:
    col = min(COLS - 1, max(0, int(x / 100.0 * COLS)))
    row = min(ROWS - 1, max(0, int(y / 100.0 * ROWS)))
    return row * COLS + col


def attacking_third(side: Side) -> tuple[int, ...]:
    cols = (COLS - 2, COLS - 1) if side == "home" else (0, 1)
    return tuple(row * COLS + col for row in range(ROWS) for col in cols)


def xg(attacking_x: float, y: float) -> float:
    """A simple expected-goals value from distance and angle to the goal centre."""
    dx = (100.0 - attacking_x) / 100.0 * _PITCH_LENGTH_M
    dy = (y - 50.0) / 100.0 * _PITCH_WIDTH_M
    distance = math.hypot(dx, dy)
    angle = math.atan2(abs(dy), max(dx, 0.01))
    value = 0.9 * math.exp(-distance / 9.0) * max(0.2, math.cos(angle))
    return max(0.01, min(0.95, value))
