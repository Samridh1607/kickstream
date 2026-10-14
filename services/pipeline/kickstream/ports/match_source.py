"""What Kickstream needs from a football data service: past matches to replay, or live matches to follow."""

from dataclasses import dataclass
from datetime import date
from typing import Literal, Protocol

from kickstream.contracts import Competition, Fixture, MatchEvent, MatchListing, TeamSheet, TeamStats
from kickstream.domain.types import Side

LiveSourceId = Literal["api_football", "openligadb"]
LiveState = Literal["pre_match", "live", "half_time", "finished"]


class SourceFailure(Exception):
    """A source could not be read, or refused. The message is written for the streamer and says what to do."""

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.retry_after = retry_after  # seconds; set when waiting is the only fix (a spent daily budget)


class SourceUnavailable(SourceFailure):
    """The source cannot be used at all as configured, e.g. its key is not set."""


@dataclass(frozen=True)
class ReplayMatch:
    home: TeamSheet
    away: TeamSheet
    events: list[MatchEvent]
    competition: str


@dataclass(frozen=True)
class LiveEvent:
    key: str  # stable across polls, so an event is published once
    minute: int
    type: Literal["goal", "yellow_card", "red_card", "substitution"]
    team: Side
    player_id: str | None = None
    player_in_id: str | None = None


@dataclass(frozen=True)
class LiveSnapshot:
    state: LiveState
    minute: int
    score_home: int
    score_away: int
    home: TeamSheet
    away: TeamSheet
    competition: str
    kickoff_at: float  # Unix seconds
    events: tuple[LiveEvent, ...] = ()
    stats: tuple[TeamStats, TeamStats] | None = None
    provided: tuple[str, ...] = ()  # TeamStats fields the source measured


@dataclass(frozen=True)
class PollPlan:
    pre_match_s: float
    soon_s: float  # within 15 minutes of kick-off
    live_s: float
    half_time_s: float


class ReplaySource(Protocol):
    id: str
    name: str
    credit: str

    async def competitions(self) -> list[Competition]: ...

    async def matches(self, competition_id: int, season_id: int) -> list[MatchListing]: ...

    async def load(self, ref: str, match_id: str) -> ReplayMatch:
        """Raises SourceFailure."""


class LiveSource(Protocol):
    id: LiveSourceId
    name: str
    credit: str
    available: bool  # false when its key is not set
    setup: str | None  # what to do to make it available
    poll: PollPlan

    async def fixtures(self, day: date) -> list[Fixture]: ...

    async def snapshot(self, ref: str) -> LiveSnapshot:
        """Raises SourceFailure."""

    def budget(self) -> tuple[int, int] | None:
        """(used today, daily limit), or None when the source has no limit."""
