"""Starts and replaces the running match. Part of the composition layer, not a stage."""

import asyncio
import contextlib
from collections.abc import Callable

from kickstream.contracts import MatchStatus, TeamSheet
from kickstream.ports.bus import STATUS, EventBus
from kickstream.ports.clock import Clock
from kickstream.simulator.generate import generate
from kickstream.simulator.stage import Simulator


class MatchController:
    def __init__(
        self, bus: EventBus, clock_factory: Callable[[float], Clock], home: TeamSheet, away: TeamSheet
    ) -> None:
        self._bus = bus
        self._clock_factory = clock_factory
        self._home = home
        self._away = away
        self._started: list[str] = []
        self._simulator: Simulator | None = None
        self._task: asyncio.Task | None = None

    @property
    def current(self) -> str | None:
        return self._started[-1] if self._started else None

    def exists(self, match_id: str) -> bool:
        return match_id in self._started

    async def start(self, seed: int, speed: float) -> str:
        interrupted = await self._cancel_running()
        match_id = f"m-{len(self._started) + 1}"
        events = generate(match_id, seed, self._home, self._away)
        self._simulator = Simulator(self._bus, self._clock_factory(speed))
        self._task = asyncio.create_task(
            self._simulator.play(match_id, events, self._home, self._away, speed)
        )
        self._started.append(match_id)
        # Announce the abandonment only once the new match is current, so a viewer who
        # reacts by asking for the current match is sent to the new one.
        await self._announce_abandoned(interrupted)
        return match_id

    async def stop(self) -> None:
        await self._announce_abandoned(await self._cancel_running())

    async def _cancel_running(self) -> MatchStatus | None:
        """Cancel the running match. Returns its last status if it was cut short."""
        task, simulator = self._task, self._simulator
        self._task = self._simulator = None
        if task is None or task.done():
            return None
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        status = simulator.status
        return status if status is not None and status.state != "finished" else None

    async def _announce_abandoned(self, status: MatchStatus | None) -> None:
        if status is not None:
            await self._bus.publish(STATUS, status.match_id, status.model_copy(update={"state": "abandoned"}))

    async def wait(self) -> None:
        if self._task is not None:
            await self._task
