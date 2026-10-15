import asyncio
import logging
from collections import deque
from dataclasses import dataclass

from kickstream.contracts import KeyMoment, MatchStatus, StatsSnapshot, TeamSheet
from kickstream.domain.recent import make_room
from kickstream.domain.teams import find_player
from kickstream.narration.service import NarrationService
from kickstream.ports.bus import INSIGHTS, NARRATIVES, STATUS, EventBus
from kickstream.ports.writer import MomentContext, RecapContext

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class _Job:
    kind: str  # "moment" or "recap"
    ctx: MomentContext | RecapContext


class NarrationStage:
    """Turns key moments and period ends into narratives, one item at a time.

    Narration is slower than the match. When more than `max_pending` moments are waiting,
    the oldest one is written from templates so the feed stays current. Goals keep their
    place in the queue while any other kind of moment is waiting.
    """

    def __init__(self, bus: EventBus, service: NarrationService, max_pending: int = 4) -> None:
        self._bus = bus
        self._service = service
        self._max_pending = max_pending
        self._messages = bus.subscribe(STATUS, INSIGHTS)
        self._pending: deque[_Job] = deque()
        self._wake = asyncio.Event()
        self._teams: dict[str, tuple[TeamSheet, TeamSheet]] = {}
        self._stats: dict[str, StatsSnapshot] = {}
        self._moments: dict[str, list[KeyMoment]] = {}

    async def run(self) -> None:
        worker = asyncio.create_task(self._work())
        try:
            async for message in self._messages:
                await self._intake(message.match_id, message.payload)
        finally:
            worker.cancel()

    async def _intake(self, match_id: str, payload) -> None:
        if isinstance(payload, MatchStatus):
            for per_match in (self._teams, self._stats, self._moments):
                make_room(per_match, match_id)
            self._teams[match_id] = (payload.home, payload.away)
            return
        if match_id not in self._teams:
            log.warning("no team sheets for match %s; skipping %s", match_id, type(payload).__name__)
            return
        home, away = self._teams[match_id]
        if isinstance(payload, KeyMoment):
            self._moments.setdefault(match_id, []).append(payload)
            player = find_player((home, away), payload.player_id)
            ctx = MomentContext(
                moment=payload,
                home=home,
                away=away,
                player_name=player.name if player else None,
                stats=self._stats.get(match_id),
            )
            await self._enqueue(_Job("moment", ctx))
        elif isinstance(payload, StatsSnapshot):
            self._stats[match_id] = payload
            if payload.period_end:
                ctx = RecapContext(
                    match_id=match_id,
                    period=payload.period_end,
                    minute=payload.minute,
                    home=home,
                    away=away,
                    stats=payload,
                    moments=tuple(self._moments.get(match_id, ())),
                )
                await self._enqueue(_Job("recap", ctx))

    async def _enqueue(self, job: _Job) -> None:
        waiting = [pending for pending in self._pending if pending.kind == "moment"]
        if job.kind == "moment" and len(waiting) >= self._max_pending:
            # Evict the oldest waiting moment, sparing goals while anything lesser is waiting.
            evicted = next((pending for pending in waiting if pending.ctx.moment.kind != "goal"), waiting[0])
            self._pending.remove(evicted)
            await self._publish(evicted.ctx.moment.match_id, await self._service.scripted_moment(evicted.ctx))
        self._pending.append(job)
        self._wake.set()

    async def _work(self) -> None:
        while True:
            await self._wake.wait()
            while self._pending:
                job = self._pending.popleft()
                try:
                    if job.kind == "moment":
                        await self._publish(job.ctx.moment.match_id, await self._service.moment(job.ctx))
                    else:
                        await self._publish(job.ctx.match_id, await self._service.recap(job.ctx))
                except Exception:
                    log.exception("narration failed for a %s", job.kind)
            self._wake.clear()

    async def _publish(self, match_id: str, items: list) -> None:
        for item in items:
            await self._bus.publish(NARRATIVES, match_id, item)
