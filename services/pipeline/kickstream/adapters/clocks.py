import asyncio


class RealClock:
    def __init__(self, speed: float) -> None:
        self._speed = speed

    async def sleep(self, match_seconds: float) -> None:
        if match_seconds > 0:
            await asyncio.sleep(match_seconds / self._speed)


class InstantClock:
    """Runs a match as fast as the pipeline can absorb it. For tests."""

    async def sleep(self, match_seconds: float) -> None:
        await asyncio.sleep(0)
