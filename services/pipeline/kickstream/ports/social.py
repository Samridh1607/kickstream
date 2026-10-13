"""What the fan zone needs from the platforms fans are on: their comments and their paid messages."""

from dataclasses import dataclass, field
from typing import Protocol


class FeedFailure(Exception):
    """A platform could not be read. The message is written for the streamer."""


@dataclass(frozen=True)
class IncomingComment:
    id: str
    platform: str
    author: str
    text: str
    handle: str | None = None
    likes: int = 0
    at: float | None = None  # when it was posted, Unix seconds; now when the platform does not say


@dataclass(frozen=True)
class IncomingSuperChat:
    id: str
    platform: str
    name: str
    amount: float
    currency: str
    message: str = ""


@dataclass(frozen=True)
class FeedBatch:
    comments: tuple[IncomingComment, ...] = ()
    superchats: tuple[IncomingSuperChat, ...] = ()


@dataclass(frozen=True)
class FeedContext:
    """What is happening on the stream, for a feed that reacts to it. A real platform ignores it."""

    poll_options: int = 0  # how many options the open poll has; 0 when none is open
    moments: tuple[tuple[str, str], ...] = field(default=())  # (kind, team name) since the last fetch


class SocialFeed(Protocol):
    demo: bool  # true when what it returns is made up
    interval_s: float  # how often to ask it

    async def fetch(self, context: FeedContext) -> FeedBatch:
        """What is new since the last fetch. Raises FeedFailure."""
