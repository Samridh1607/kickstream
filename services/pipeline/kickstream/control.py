"""Starts and replaces the running match. Part of the composition layer, not a stage."""

import asyncio
import contextlib
from collections.abc import Callable, Mapping
from types import MappingProxyType

from kickstream.contracts import MatchStatus, RunningMatch, TeamSheet
from kickstream.domain.demo import DEMO_SEED
from kickstream.ports.bus import STATUS, EventBus
from kickstream.ports.clock import Clock
from kickstream.ports.match_source import ReplaySource, SourceFailure, SourceUnavailable
from kickstream.simulator.generate import generate
from kickstream.simulator.stage import Simulator


class MatchController:
    def __init__(
        self,
        bus: EventBus,
        clock_factory: Callable[[float], Clock],
        home: TeamSheet,
        away: TeamSheet,
        prefix: str = "m",
        *,
        replays: Mapping[str, ReplaySource] = MappingProxyType({}),
    ) -> None:
        self._bus = bus
        self._clock_factory = clock_factory
        self._home = home
        self._away = away
        self._replays = replays
        self._started: list[str] = []
        self._teams = (home, away)
        self._running: RunningMatch | None = None
        self._simulator: Simulator | None = None
        self._task: asyncio.Task | None = None
        self._prefix = prefix
        # Starting and stopping each span several awaits; overlapping calls must not interleave.
        self._lock = asyncio.Lock()

    @property
    def current(self) -> str | None:
        return self._started[-1] if self._started else None

    @property
    def teams(self) -> tuple[TeamSheet, TeamSheet]:
        """The current match's teams, or the simulated match's before any match."""
        return self._teams

    def exists(self, match_id: str) -> bool:
        return match_id in self._started

    def running(self) -> RunningMatch | None:
        if self._task is None or self._task.done():
            return None
        return self._running

    async def start(
        self, seed: int = DEMO_SEED, speed: float = 30.0, *, source: str = "simulated", ref: str | None = None
    ) -> str:
        """Raises SourceFailure, leaving the running match playing, when the source cannot give the match."""
        async with self._lock:
            match_id = f"{self._prefix}-{len(self._started) + 1}"
            if source == "simulated":
                home, away = self._home, self._away
                events = generate(match_id, seed, home, away)
                play = {}
            else:
                replay_source = self._replays.get(source)
                if replay_source is None:
                    raise SourceUnavailable(f"Kickstream has no source called {source}.")
                if not ref:
                    raise SourceFailure("Choose a match to replay first.")
                replay = await replay_source.load(ref, match_id)
                home, away, events = replay.home, replay.away, replay.events
                play = {"source": source, "credit": replay_source.credit, "competition": replay.competition}
            interrupted = await self._cancel_running()
            self._simulator = Simulator(self._bus, self._clock_factory(speed))
            self._task = asyncio.create_task(
                self._simulator.play(match_id, events, home, away, speed, **play)
            )
            self._started.append(match_id)
            self._teams = (home, away)
            self._running = RunningMatch(
                match_id=match_id, source=source, ref=ref, title=f"{home.name} vs {away.name}"
            )
            # Announce the abandonment only once the new match is current, so a viewer who
            # reacts by asking for the current match is sent to the new one.
            await self._announce_abandoned(interrupted)
            return match_id

    async def stop(self) -> None:
        async with self._lock:
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
