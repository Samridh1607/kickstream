"""Who is on the pitch for each side, kept up to date from substitutions and red cards."""

from kickstream.contracts import Player, PlayEvent, TeamSheet
from kickstream.domain.types import SIDES, Side

STARTERS = 11


def _starters(sheet: TeamSheet) -> list[str]:
    marked = [player.id for player in sheet.players if player.starting]
    return marked or [player.id for player in sheet.players[:STARTERS]]


class Squad:
    def __init__(self, home: TeamSheet, away: TeamSheet) -> None:
        self.refresh(home, away)
        self.on_pitch: dict[Side, list[str]] = {side: _starters(self.sheets[side]) for side in SIDES}

    def refresh(self, home: TeamSheet, away: TeamSheet) -> None:
        """Takes in the latest sheets, so players a source names later are known. Who is on the pitch stays."""
        self.sheets: dict[Side, TeamSheet] = {"home": home, "away": away}
        self._players: dict[str, tuple[Side, Player]] = {
            player.id: (side, player) for side in SIDES for player in self.sheets[side].players
        }

    def name(self, side: Side) -> str:
        return self.sheets[side].name

    def player(self, player_id: str | None) -> Player | None:
        found = self._players.get(player_id or "")
        return found[1] if found else None

    def player_name(self, player_id: str | None, default: str = "A player") -> str:
        player = self.player(player_id)
        return player.name if player else default

    def apply(self, play: PlayEvent) -> None:
        if play.team is None or play.player_id is None:
            return
        playing = self.on_pitch[play.team]
        if play.type == "substitution" and play.player_in_id and play.player_id in playing:
            playing[playing.index(play.player_id)] = play.player_in_id
        elif play.type == "red_card" and play.player_id in playing:
            playing.remove(play.player_id)
