"""What making reels needs from the outside world: someone to pick and write them, and a clip cutter."""

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class ReelCandidate:
    """A moment of a recording a reel could be made from. `offset_s` is where it is in the file."""

    id: str
    label: str
    offset_s: float
    kind: str | None = None  # a key moment's kind; None for a plain stretch of the recording
    minute: int | None = None
    team: str | None = None
    commentary: str | None = None


@dataclass(frozen=True)
class ReelBrief:
    title: str
    description: str
    score: str | None  # "Northbridge 2-1 Eastport" when a match was played
    candidates: tuple[ReelCandidate, ...]
    max_reels: int


@dataclass(frozen=True)
class ReelPick:
    """One reel to make: which candidate, and the post that goes with it."""

    candidate_id: str
    title: str
    caption: str
    hashtags: tuple[str, ...]


class ReelProducer(Protocol):
    name: str  # recorded on each reel it writes

    async def produce(self, brief: ReelBrief) -> list[ReelPick]:
        """Pick the best candidates and write a post for each. Raises on any failure."""


class ClipFailure(Exception):
    """A clip could not be cut. The message is written for the streamer."""


class ClipCutter(Protocol):
    def available(self) -> str | None:
        """None when clips can be cut, else what is missing."""

    async def cut(self, source: Path, start_s: float, duration_s: float, out: Path) -> int:
        """Write a vertical clip of that stretch of `source` to `out`. Returns its size. Raises ClipFailure."""
