"""What broadcasts need from the output: its state as it changes, and the means to start and stop it."""

from collections.abc import AsyncIterator
from typing import Protocol

from kickstream.contracts import Output


class LiveOutput(Protocol):
    def view(self) -> Output: ...

    def changes(self) -> AsyncIterator[Output]:
        """The current document, then the latest one after each change."""

    def ensure_recording(self) -> None:
        """Have a file destination on, adding one if there is none. Raises a Refusal."""

    def start(self) -> None:
        """Raises a Refusal when the stream cannot start."""

    async def stop(self) -> None: ...
