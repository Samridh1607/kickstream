from kickstream.domain.types import Side

SWING_STRENGTH = 0.35  # |momentum| at which one side is "in control"


def in_control(momentum: float, strength: float = SWING_STRENGTH) -> Side | None:
    """The side in control: momentum runs from -1 (away) to 1 (home)."""
    if momentum >= strength:
        return "home"
    if momentum <= -strength:
        return "away"
    return None
