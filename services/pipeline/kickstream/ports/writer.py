from dataclasses import dataclass
from typing import Literal, Protocol

from kickstream.contracts import KeyMoment, StatsSnapshot, TeamSheet
from kickstream.domain.types import Variant


class NarrationError(Exception):
    """A writer could not produce a complete, well-formed result."""


@dataclass(frozen=True)
class MomentContext:
    moment: KeyMoment
    home: TeamSheet
    away: TeamSheet
    player_name: str | None
    stats: StatsSnapshot | None


@dataclass(frozen=True)
class RecapContext:
    match_id: str
    period: Literal["half_time", "full_time"]
    minute: int
    home: TeamSheet
    away: TeamSheet
    stats: StatsSnapshot
    moments: tuple[KeyMoment, ...]


@dataclass(frozen=True)
class WrittenText:
    text: str
    agent: str


@dataclass(frozen=True)
class WrittenRecap:
    title: str
    bullets: tuple[str, str, str]
    text: str
    agent: str


class NarrativeWriter(Protocol):
    """Writes one item in every (mode, language) variant. Localization happens inside the writer."""

    model: str

    async def write_moment(self, ctx: MomentContext) -> dict[Variant, WrittenText]: ...

    async def write_recap(self, ctx: RecapContext) -> dict[Variant, WrittenRecap]: ...
