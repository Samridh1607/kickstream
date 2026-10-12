"""The two fictional clubs used by the simulator. No real clubs or players."""

from collections.abc import Iterable

from kickstream.contracts import Player, TeamSheet

_POSITIONS = ["GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "FW", "FW", "FW", "DF", "MF", "FW"]

_HOME_NAMES = [
    "Tobin Ashgrove", "Milo Ferncastle", "Idris Vantongeren", "Caspian Holloway", "Renzo Albarran",
    "Kellan Whitlock", "Jovan Stradling", "Emeka Okonjo-Reyes", "Luca Marrowby", "Dashiell Pruett",
    "Arjun Venkataraghavan", "Soren Applewhite", "Mateus Calderwood", "Finnian Ostrander",
]
_AWAY_NAMES = [
    "Osric Pendlebury", "Bastien Roquefeuil", "Nikhil Thorncroft", "Aurelio Zambrana", "Wendell Kirkby",
    "Tariq Halvorsen", "Ignatius Bellweather", "Rohan Castellane", "Evander Quillfeather", "Yusuf Marlowe-Diaz",
    "Cormac Linthwaite", "Anselm Drakeford", "Vikram Elderfield", "Leopold Varga-Nilsen",
]


def _sheet(team_id: str, name: str, short_name: str, color: str, names: list[str]) -> TeamSheet:
    players = [
        Player(id=f"{team_id}-{number}", name=player_name, number=number, position=position)
        for number, (player_name, position) in enumerate(zip(names, _POSITIONS, strict=True), start=1)
    ]
    return TeamSheet(id=team_id, name=name, short_name=short_name, color=color, players=players)


HOME = _sheet("nbr", "Northbridge FC", "NBR", "#0F6CBD", _HOME_NAMES)
AWAY = _sheet("hbc", "Harbour City", "HBC", "#C50F1F", _AWAY_NAMES)


def find_player(sheets: Iterable[TeamSheet], player_id: str | None) -> Player | None:
    if player_id is None:
        return None
    for sheet in sheets:
        for player in sheet.players:
            if player.id == player_id:
                return player
    return None
