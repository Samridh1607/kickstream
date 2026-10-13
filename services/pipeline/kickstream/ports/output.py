"""What the output stage needs from the outside world: a browser, an encoder, senders and storage."""

from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Literal, Protocol


@dataclass(frozen=True)
class Quality:
    width: int
    height: int
    video_kbps: int
    audio_kbps: int = 128
    fps: int = 30


@dataclass(frozen=True)
class Target:
    """Where one sender delivers: an RTMP address with its key, or a file path."""

    kind: Literal["rtmp", "file"]
    location: str


class OutputFailure(Exception):
    """Something outside the pipeline failed. The message is written for the streamer."""


class RecordStore(Protocol):
    def load(self) -> dict | None:
        """The saved record, or None when there is none to use."""

    def save(self, record: dict) -> None:
        """Persist the record. Raises OSError when it could not be written."""

    def set_aside(self) -> None:
        """Move the saved record out of the way, so the next load finds nothing."""


class ProgramCapture(Protocol):
    """A hidden browser showing the program page, which records itself."""

    def available(self) -> str | None:
        """None when a browser can be started, else what is missing."""

    async def start(self, url: str, width: int, height: int) -> None:
        """Open the page at that size and have it start recording. Raises OutputFailure."""

    async def wait(self) -> None:
        """Returns when the browser has exited."""

    async def stop(self) -> None:
        """End the browser and everything it started. Safe to call when not started."""


class Encoder(Protocol):
    """Turns the page's recording into one encoded stream."""

    def available(self) -> str | None:
        """None when the encoder can be started, else what is missing."""

    async def start(self, quality: Quality) -> None:
        """Raises OutputFailure when it cannot be started."""

    async def write(self, data: bytes) -> None:
        """Give it more of the recording. Never raises; data for a stopped encoder is dropped."""

    def output(self) -> AsyncIterator[bytes]:
        """The encoded stream, in pieces a sender can start from. Ends when the encoder exits."""

    async def stop(self) -> None:
        """End the encoder. Safe to call when not started."""


class Sender(Protocol):
    """Delivers the encoded stream to one destination, without re-encoding."""

    async def start(self, target: Target, on_live: Callable[[], None]) -> None:
        """Begin delivering. `on_live` is called once the destination is receiving. Raises OutputFailure."""

    async def write(self, data: bytes) -> None:
        """Give it more of the stream. Never raises; data for a sender that has ended is dropped."""

    async def wait(self) -> str:
        """Returns when the sender has ended, with its last words. They may contain the key."""

    async def stop(self) -> None:
        """Ask it to finish, and end it if it has not within the grace period. Safe to call twice."""
