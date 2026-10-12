from dataclasses import dataclass
from typing import Protocol

from kickstream.contracts import KeyMoment, MatchStatus, StatsSnapshot, TeamSheet


@dataclass(frozen=True)
class MatchContext:
    """What the expert may draw on. Each key moment comes with its analyst narrative when known."""

    home: TeamSheet
    away: TeamSheet
    status: MatchStatus
    stats: StatsSnapshot | None
    moments: tuple[tuple[KeyMoment, str | None], ...]


class ExpertWriter(Protocol):
    async def answer(self, question: str, ctx: MatchContext | None, language: str) -> str:
        """Answer one fan question from the match context. Raises on any failure."""
