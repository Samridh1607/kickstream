"""What Ask Copilot knows: one match as its log tells it, and the matches played before it."""

import logging
from dataclasses import dataclass, field

from kickstream.contracts import (
    Explanation,
    Highlight,
    KeyMoment,
    MatchStatus,
    Narrative,
    Player,
    PlayerMetrics,
    PlayEvent,
    Prediction,
    StatsSnapshot,
    TacticalInsight,
)
from kickstream.domain.types import SIDES, Mode, Side
from kickstream.ports.output import RecordStore
from kickstream.ports.store import MatchStore

log = logging.getLogger(__name__)
MAX_REMEMBERED = 50


@dataclass
class MatchView:
    """One match, read from its log, in the wording of one viewing mode."""

    match_id: str
    status: MatchStatus | None = None
    stats: StatsSnapshot | None = None
    tactics: TacticalInsight | None = None
    prediction: Prediction | None = None
    players: list[PlayerMetrics] = field(default_factory=list)
    plays: list[PlayEvent] = field(default_factory=list)
    moments: list[KeyMoment] = field(default_factory=list)
    highlights: list[Highlight] = field(default_factory=list)
    narratives: dict[str, Narrative] = field(default_factory=dict)  # by key moment
    explanations: dict[str, Explanation] = field(default_factory=dict)  # by what they explain

    @property
    def minute(self) -> int:
        latest = max((play.minute for play in self.plays[-1:]), default=0)
        return max(latest, self.status.minute if self.status else 0)

    def name(self, side: Side) -> str:
        if self.status is None:
            return side
        return (self.status.home if side == "home" else self.status.away).name

    def sheet_players(self) -> list[tuple[Side, Player]]:
        if self.status is None:
            return []
        return [(side, player) for side in SIDES for player in getattr(self.status, side).players]

    def player_name(self, player_id: str | None) -> str | None:
        return next((player.name for _, player in self.sheet_players() if player.id == player_id), None)

    def line(self, player_id: str) -> PlayerMetrics | None:
        return next((line for line in self.players if line.player_id == player_id), None)


def read_match(store: MatchStore, match_id: str, mode: Mode) -> MatchView:
    view = MatchView(match_id)
    for item in store.read(match_id):
        payload = item.payload
        if item.type == "match_status":
            view.status = payload
        elif item.type == "stats":
            view.stats = payload
        elif item.type == "tactics":
            view.tactics = payload
        elif item.type == "prediction":
            view.prediction = payload
        elif item.type == "players":
            view.players = payload.players
        elif item.type == "play":
            view.plays.append(payload)
        elif item.type == "key_moment":
            view.moments.append(payload)
        elif item.type == "highlight":
            view.highlights.append(payload)
        elif item.type == "narrative" and item.mode == mode and item.language == "en":
            view.narratives[payload.moment_id] = payload
        elif item.type == "explanation" and item.mode == mode:
            view.explanations[payload.subject_id] = payload
    return view


def summarize(view: MatchView, played_at: float) -> dict | None:
    """A finished match as it is remembered: the result, the numbers, who scored and how each player did."""
    status, stats = view.status, view.stats
    if status is None or stats is None or status.state != "finished":
        return None
    scorers = [
        {
            "player_id": play.player_id,
            "name": view.player_name(play.player_id) or "Unknown",
            "side": play.team,
            "minute": play.minute,
        }
        for play in view.plays
        if play.type == "goal" and play.team is not None
    ]
    return {
        "match_id": view.match_id,
        "played_at": played_at,
        "home": status.home.name,
        "away": status.away.name,
        "score_home": status.score_home,
        "score_away": status.score_away,
        "possession": [stats.home.possession, stats.away.possession],
        "shots": [stats.home.shots, stats.away.shots],
        "xg": [stats.home.xg, stats.away.xg],
        "scorers": scorers,
        "players": [
            {
                "player_id": line.player_id,
                "name": line.name,
                "side": line.team,
                "goals": line.goals,
                "shots": line.shots,
                "touches": line.touches,
                "rating": line.rating,
            }
            for line in view.players
            if line.touches > 0 or line.goals > 0
        ],
    }


def _usable(record) -> bool:
    try:
        return (
            isinstance(record["match_id"], str)
            and isinstance(record["score_home"], int)
            and isinstance(record["score_away"], int)
            and isinstance(record["home"], str)
            and isinstance(record["away"], str)
            and isinstance(record.get("scorers", []), list)
            and isinstance(record.get("players", []), list)
        )
    except (KeyError, TypeError):
        return False


class MatchArchive:
    """The finished matches Kickstream has seen, newest last. They are the only record there is."""

    def __init__(self, store: RecordStore | None = None) -> None:
        self._store = store
        saved = (store.load() if store else None) or {}
        matches = saved.get("matches", [])
        self.matches: list[dict] = [m for m in matches if _usable(m)] if isinstance(matches, list) else []

    def remember(self, record: dict) -> None:
        """Add a finished match, or replace what was kept of it."""
        kept = [match for match in self.matches if match["match_id"] != record["match_id"]]
        matches = [*kept, record][-MAX_REMEMBERED:]
        if matches == self.matches:
            return
        if self._store is not None:
            try:
                self._store.save({"matches": matches})
            except OSError:
                log.warning("the match archive could not be saved; it is kept until the pipeline stops")
        self.matches = matches

    def before(self, match_id: str | None) -> list[dict]:
        return [match for match in self.matches if match["match_id"] != match_id]

    def player_record(self, player_id: str, except_match: str | None = None) -> dict:
        """A player's totals over the remembered matches."""
        played = [
            line
            for match in self.before(except_match)
            for line in match.get("players", [])
            if isinstance(line, dict) and line.get("player_id") == player_id
        ]
        ratings = [line.get("rating", 0.0) for line in played]
        return {
            "matches": len(played),
            "goals": sum(line.get("goals", 0) for line in played),
            "shots": sum(line.get("shots", 0) for line in played),
            "average_rating": round(sum(ratings) / len(ratings), 1) if ratings else None,
            "best_rating": max(ratings) if ratings else None,
        }
