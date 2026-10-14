import asyncio
import time
from collections.abc import Awaitable, Callable

from kickstream.contracts import MatchEvent, MatchStatus, StatsSnapshot
from kickstream.live.rules import LiveProgress, advance
from kickstream.ports.bus import EVENTS, INSIGHTS, STATUS, EventBus
from kickstream.ports.match_source import LiveSnapshot, LiveSource, SourceFailure

SOON_S = 15 * 60


class LiveMatch:
    """Follows one live fixture: polls its source, publishes what changed, and stops at full time."""

    def __init__(
        self,
        bus: EventBus,
        source: LiveSource,
        ref: str,
        match_id: str,
        first: LiveSnapshot,
        *,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        now: Callable[[], float] = time.time,
        poll_s: float | None = None,
        max_backoff_s: float = 300.0,
    ) -> None:
        self._bus = bus
        self._source = source
        self._ref = ref
        self._first = first
        self._sleep = sleep
        self._now = now
        self._poll_s = poll_s
        self._max_backoff_s = max_backoff_s
        self._progress = LiveProgress(match_id, source.id, source.credit)
        self.status: MatchStatus | None = None
        self.problem: str | None = None

    async def run(self) -> None:
        last = self._first
        await self._publish(last)
        delay = self._interval(last)
        failures = 0
        while last.state != "finished":
            await self._sleep(delay)
            try:
                last = await self._source.snapshot(self._ref)
            except SourceFailure as exc:
                failures += 1
                self.problem = exc.message
                if exc.retry_after is not None:
                    delay = exc.retry_after
                else:
                    delay = min(self._max_backoff_s, self._interval(last) * 2**failures)
                continue
            failures = 0
            self.problem = None
            await self._publish(last)
            delay = self._interval(last)

    def _interval(self, snap: LiveSnapshot) -> float:
        if self._poll_s is not None:
            return self._poll_s
        plan = self._source.poll
        if snap.state == "live":
            return plan.live_s
        if snap.state == "half_time":
            return plan.half_time_s
        if snap.kickoff_at - self._now() <= SOON_S:
            return plan.soon_s
        return plan.pre_match_s

    async def _publish(self, snap: LiveSnapshot) -> None:
        match_id = self._progress.match_id
        for payload in advance(self._progress, snap):
            if isinstance(payload, MatchStatus):
                self.status = payload
                await self._bus.publish(STATUS, match_id, payload)
            elif isinstance(payload, MatchEvent):
                await self._bus.publish(EVENTS, match_id, payload)
            elif isinstance(payload, StatsSnapshot):
                await self._bus.publish(INSIGHTS, match_id, payload)
