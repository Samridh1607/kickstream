from typing import Literal

Side = Literal["home", "away"]
Mode = Literal["fan", "analyst"]
Language = Literal["en", "es", "hi"]
Variant = tuple[Mode, Language]

SIDES: tuple[Side, ...] = ("home", "away")
MODES: tuple[Mode, ...] = ("fan", "analyst")
LANGUAGES: tuple[Language, ...] = ("en", "es", "hi")
VARIANTS: tuple[Variant, ...] = tuple((mode, language) for mode in MODES for language in LANGUAGES)


def other(side: Side) -> Side:
    return "away" if side == "home" else "home"
