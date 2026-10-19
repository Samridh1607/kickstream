"""Starts and replaces the running match. Part of the composition layer, not a stage."""

import asyncio
import contextlib
import functools
from collections.abc import AsyncIterable, Awaitable, Callable, Mapping
from types import MappingProxyType

from kickstream.contracts import MatchStatus, RunningMatch, TeamSheet
from kickstream.domain.demo import DEMO_SEED
from kickstream.live.runner import LiveMatch
from kickstream.ports.bus import STATUS, EventBus
from kickstream.ports.clock import Clock
from kickstream.ports.match_source import LiveSource, ReplaySource, SourceFailure, SourceUnavailable
from kickstream.simulator.generate import generate
from kickstream.simulator.reader import EventReader
from kickstream.simulator.stage import Simulator

DETECTOR_SETUP = "Set KICKSTREAM_DETECTOR_FILE to the JSON Lines file your detector writes MatchEvents to."


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
        live: Mapping[str, LiveSource] = MappingProxyType({}),
        live_match: Callable[..., LiveMatch] | None = None,
        live_poll_s: float | None = None,
        detector: Callable[[], AsyncIterable[str]] | None = None,
    ) -> None:
        self._bus = bus
        self._detector = detector
        self._clock_factory = clock_factory
        self._home = home
        self._away = away
        self._replays = replays
        self._live = live
        self._live_match = live_match or functools.partial(LiveMatch, poll_s=live_poll_s)
        self._started: list[str] = []
        self._teams = (home, away)
        self._running: RunningMatch | None = None
        self._runner: Simulator | LiveMatch | EventReader | None = None
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
        status = self._runner.status if self._runner is not None else None
        return (status.home, status.away) if status is not None else self._teams

    def exists(self, match_id: str) -> bool:
        return match_id in self._started

    def running(self) -> RunningMatch | None:
        if self._task is None or self._task.done():
            return None
        if isinstance(self._runner, LiveMatch | EventReader):
            return self._running.model_copy(update={"problem": self._runner.problem})
        return self._running

    async def start(
        self, seed: int = DEMO_SEED, speed: float = 30.0, *, source: str = "simulated", ref: str | None = None
    ) -> str:
        """Raises SourceFailure, leaving the running match playing, when the source cannot give the match."""
        async with self._lock:
            match_id = f"{self._prefix}-{len(self._started) + 1}"
            home, away, runner, run = await self._prepare(match_id, seed, speed, source, ref)
            interrupted = await self._cancel_running()
            self._runner = runner
            self._task = asyncio.create_task(run())
            self._started.append(match_id)
            self._teams = (home, away)
            self._running = RunningMatch(
                match_id=match_id, source=source, ref=ref, title=f"{home.name} vs {away.name}"
            )
            # Announce the abandonment only once the new match is current, so a viewer who
            # reacts by asking for the current match is sent to the new one.
            await self._announce_abandoned(interrupted)
            return match_id

    async def _prepare(
        self, match_id: str, seed: int, speed: float, source: str, ref: str | None
    ) -> tuple[TeamSheet, TeamSheet, Simulator | LiveMatch | EventReader, Callable[[], Awaitable[None]]]:
        """Everything that can fail happens here, before the running match is touched."""
        if source == "detector":
            if self._detector is None:
                raise SourceUnavailable(DETECTOR_SETUP)
            home, away = self._home, self._away
            reader = EventReader(self._bus, self._detector())
            return home, away, reader, functools.partial(reader.follow, match_id, home, away)
        if source == "simulated":
            home, away = self._home, self._away
            simulator = Simulator(self._bus, self._clock_factory(speed))
            events = generate(match_id, seed, home, away)
            play = functools.partial(simulator.play, match_id, events, home, away, speed)
            return home, away, simulator, play
        if source in self._live:
            live_source = self._live[source]
            if not live_source.available:
                raise SourceUnavailable(live_source.setup or f"{live_source.name} is not set up.")
            if not ref:
                raise SourceFailure("Choose a match to follow first.")
            first = await live_source.snapshot(ref)
            runner = self._live_match(self._bus, live_source, ref, match_id, first)
            return first.home, first.away, runner, runner.run
        replay_source = self._replays.get(source)
        if replay_source is None:
            raise SourceUnavailable(f"Kickstream has no source called {source}.")
        if not ref:
            raise SourceFailure("Choose a match to replay first.")
        replay = await replay_source.load(ref, match_id)
        simulator = Simulator(self._bus, self._clock_factory(speed))
        play = functools.partial(
            simulator.play,
            match_id,
            replay.events,
            replay.home,
            replay.away,
            speed,
            source=source,
            credit=replay_source.credit,
            competition=replay.competition,
        )
        return replay.home, replay.away, simulator, play

    async def stop(self) -> None:
        async with self._lock:
            await self._announce_abandoned(await self._cancel_running())

    async def _cancel_running(self) -> MatchStatus | None:
        """Cancel the running match. Returns its last status if it was cut short."""
        task, runner = self._task, self._runner
        self._task = self._runner = None
        if runner is None or task is None:
            return None
        cut_short = not task.done()
        if cut_short:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        status = runner.status
        if status is None:
            return None
        self._teams = (status.home, status.away)
        return status if cut_short and status.state != "finished" else None

    async def _announce_abandoned(self, status: MatchStatus | None) -> None:
        if status is not None:
            await self._bus.publish(STATUS, status.match_id, status.model_copy(update={"state": "abandoned"}))

    async def wait(self) -> None:
        if self._task is not None:
            await self._task
