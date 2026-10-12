from typing import Protocol


class Clock(Protocol):
    async def sleep(self, match_seconds: float) -> None:
        """Wait for the given amount of match time."""
