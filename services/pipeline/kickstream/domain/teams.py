"""The two fictional clubs used by the simulator (no real clubs or players), and what any match's teams need."""

import re
from collections.abc import Iterable

from kickstream.contracts import Player, TeamSheet

PALETTE = ("#0F6CBD", "#C50F1F", "#107C10", "#5C2E91", "#CA5010", "#038387", "#8764B8", "#986F0B")

_HEX_COLOR = re.compile(r"#[0-9A-Fa-f]{6}")

_POSITIONS = ["GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "FW", "FW", "FW", "DF", "MF", "FW"]

_HOME_NAMES = [
    "Tobin Ashgrove",
    "Milo Ferncastle",
    "Idris Vantongeren",
    "Caspian Holloway",
    "Renzo Albarran",
    "Kellan Whitlock",
    "Jovan Stradling",
    "Emeka Okonjo-Reyes",
    "Luca Marrowby",
    "Dashiell Pruett",
    "Arjun Venkataraghavan",
    "Soren Applewhite",
    "Mateus Calderwood",
    "Finnian Ostrander",
]
_AWAY_NAMES = [
    "Osric Pendlebury",
    "Bastien Roquefeuil",
    "Nikhil Thorncroft",
    "Aurelio Zambrana",
    "Wendell Kirkby",
    "Tariq Halvorsen",
    "Ignatius Bellweather",
    "Rohan Castellane",
    "Evander Quillfeather",
    "Yusuf Marlowe-Diaz",
    "Cormac Linthwaite",
    "Anselm Drakeford",
    "Vikram Elderfield",
    "Leopold Varga-Nilsen",
]


def _sheet(team_id: str, name: str, short_name: str, color: str, names: list[str]) -> TeamSheet:
    players = [
        Player(
            id=f"{team_id}-{number}",
            name=player_name,
            number=number,
            position=position,
            starting=number <= 11,
        )
        for number, (player_name, position) in enumerate(zip(names, _POSITIONS, strict=True), start=1)
    ]
    return TeamSheet(id=team_id, name=name, short_name=short_name, color=color, players=players)


HOME = _sheet("nbr", "Northbridge FC", "NBR", "#0F6CBD", _HOME_NAMES)
AWAY = _sheet("hbc", "Harbour City", "HBC", "#C50F1F", _AWAY_NAMES)


def team_colors(home: str | None, away: str | None) -> tuple[str, str]:
    """Each side's colour: the source's own when it gives a valid `#RRGGBB`, else from PALETTE, never the same twice."""
    given_home = home if home and _HEX_COLOR.fullmatch(home) else None
    given_away = away if away and _HEX_COLOR.fullmatch(away) else None
    home_color = given_home or _first_unlike(given_away)
    if given_away and given_away.upper() != home_color.upper():
        return home_color, given_away
    return home_color, _first_unlike(home_color)


def _first_unlike(color: str | None) -> str:
    taken = color.upper() if color else None
    return next(candidate for candidate in PALETTE if candidate != taken)


def short_name(name: str) -> str:
    """Three letters for a scoreboard: the name's first three letters, skipping digits, spaces and punctuation.

    "France" -> "FRA", "Bayern München" -> "BAY", "1. FC Köln" -> "FCK". Upper-cased; shorter only when
    the name has fewer than three letters.
    """
    return "".join(char for char in name if char.isalpha()).upper()[:3]


def find_player(sheets: Iterable[TeamSheet], player_id: str | None) -> Player | None:
    if player_id is None:
        return None
    for sheet in sheets:
        for player in sheet.players:
            if player.id == player_id:
                return player
    return None
