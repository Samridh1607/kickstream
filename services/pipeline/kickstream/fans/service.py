"""Holds the fan zone: applies rules, reads the chosen feed, saves, notifies pages, and settles deadlines."""

import asyncio
import logging
import random
import time
from collections.abc import AsyncIterator, Callable, Mapping

from kickstream.contracts import FanSettings, FanZone, KeyMoment, MatchStatus
from kickstream.fans import rules
from kickstream.fans.rules import FanError, FanState
from kickstream.ports.output import RecordStore
from kickstream.ports.social import (
    FeedBatch,
    FeedContext,
    FeedFailure,
    IncomingComment,
    IncomingSuperChat,
    SocialFeed,
)

log = logging.getLogger(__name__)
SAVE_EVERY_S = 5.0  # what the feeds bring in is saved this often, not on every comment
FETCH_TIMEOUT_S = 15.0
RETRY_AFTER_FAILURE_S = 60.0
REMEMBERED_MOMENTS = 8


class FanService:
    def __init__(
        self,
        store: RecordStore,
        feeds: Mapping[str, SocialFeed],
        *,
        now: Callable[[], float] = time.time,
        rng: random.Random | None = None,
    ) -> None:
        self._store = store
        self._feeds = dict(feeds)
        self._now = now
        self._rng = rng or random.Random()
        self._state = self._load()
        self._lock = asyncio.Lock()
        self._wake = asyncio.Event()
        self._listeners: set[asyncio.Event] = set()
        self._unsaved = False
        self._saved_at = now()
        self._fetch_at = 0.0
        self._teams: dict[str, str] = {}
        self._moments: list[tuple[str, str]] = []

    def _load(self) -> FanState:
        x_available = "x" in self._feeds
        record = self._store.load()
        if record is None:
            return rules.empty_state(x_available)
        try:
            return rules.load(record, x_available)
        except (ValueError, TypeError, KeyError, IndexError) as exc:
            log.warning("the saved fan zone cannot be used (%s); starting empty", type(exc).__name__)
            self._store.set_aside()
            return rules.empty_state(x_available)

    # --- reading --------------------------------------------------------------------------------

    def view(self) -> FanZone:
        return self._state.doc.model_copy(update={"server_time": self._now()})

    async def changes(self) -> AsyncIterator[FanZone]:
        """The current document, then the latest one after each change. Slow readers skip steps."""
        listener = asyncio.Event()
        self._listeners.add(listener)
        try:
            yield self.view()
            while True:
                await listener.wait()
                listener.clear()
                yield self.view()
        finally:
            self._listeners.discard(listener)

    # --- changing -------------------------------------------------------------------------------

    async def apply(self, change: Callable[[FanState], FanState], *, save: bool = True) -> FanZone:
        async with self._lock:
            return self._commit(change(self._state), save)

    def _commit(self, changed: FanState, save: bool) -> FanZone:
        if changed is self._state:
            return self.view()
        if changed.doc == self._state.doc:
            self._state = changed  # only what is kept beside the document: nothing to show
            self._unsaved = True
            return self.view()
        doc = FanZone.model_validate(
            changed.doc.model_copy(update={"revision": self._state.doc.revision + 1}).model_dump()
        )
        candidate = FanState(doc, changed.votes, changed.seen)
        if save:
            self._save(candidate)
        else:
            self._unsaved = True
        self._state = candidate
        for listener in self._listeners:
            listener.set()
        self._wake.set()
        return self.view()

    def _save(self, state: FanState) -> None:
        try:
            self._store.save(rules.dump(state))
        except OSError as exc:
            raise FanError(503, "fans", "The change could not be saved. Nothing was changed.") from exc
        self._unsaved = False
        self._saved_at = self._now()

    async def settings(self, settings: FanSettings) -> FanZone:
        doc = await self.apply(lambda state: rules.set_settings(state, settings))
        self._fetch_at = 0.0  # ask the newly chosen source at once
        self._wake.set()
        return doc

    async def like(self, comment_id: str, liked: bool) -> FanZone:
        return await self.apply(lambda state: rules.like_comment(state, comment_id, liked))

    async def spotlight_comment(self, comment_id: str) -> FanZone:
        return await self.apply(lambda state: rules.spotlight_comment(state, comment_id, self._now()))

    async def spotlight_superchat(self, superchat_id: str) -> FanZone:
        return await self.apply(lambda state: rules.spotlight_superchat(state, superchat_id, self._now()))

    async def message(self, title: str, text: str, duration_s: int) -> FanZone:
        return await self.apply(
            lambda state: rules.spotlight_message(state, title, text, duration_s, self._now())
        )

    async def clear_spotlight(self) -> FanZone:
        return await self.apply(lambda state: rules.clear_spotlight(state, self._now()))

    async def open_poll(self, question: str, options: list[str], minutes: int | None) -> FanZone:
        return await self.apply(lambda state: rules.open_poll(state, question, options, minutes, self._now()))

    async def close_poll(self) -> FanZone:
        return await self.apply(rules.close_poll)

    async def poll_air(self, on_air: bool) -> FanZone:
        return await self.apply(lambda state: rules.set_poll_air(state, on_air))

    async def remove_poll(self) -> FanZone:
        return await self.apply(rules.remove_poll)

    async def announce_poll(self) -> FanZone:
        return await self.apply(lambda state: rules.announce_poll(state, self._now()))

    async def superchat(self, name: str, amount: float, currency: str, message: str) -> FanZone:
        return await self.apply(
            lambda state: rules.add_superchat(state, name, amount, currency, message, self._now())
        )

    async def winner(self, pool: str) -> FanZone:
        return await self.apply(lambda state: rules.pick_winner(state, pool, self._rng, self._now()))

    async def clear(self) -> FanZone:
        return await self.apply(lambda state: rules.clear(state, self._now()))

    async def take(self, batch: FeedBatch, *, demo: bool, save: bool = True) -> FanZone:
        """What a feed or a bridge brought in."""

        def change(state: FanState) -> FanState:
            state = rules.take_comments(state, list(batch.comments), self._now(), demo=demo)
            return rules.take_superchats(state, list(batch.superchats), self._now(), demo=demo)

        return await self.apply(change, save=save)

    async def ingest(self, comments: list[IncomingComment], superchats: list[IncomingSuperChat]) -> FanZone:
        return await self.take(FeedBatch(tuple(comments), tuple(superchats)), demo=False)

    # --- the match, for a feed that reacts to it ------------------------------------------------

    def observe_match(self, payload) -> None:
        if isinstance(payload, MatchStatus):
            self._teams = {"home": payload.home.name, "away": payload.away.name}
        elif isinstance(payload, KeyMoment):
            self._moments.append((payload.kind, self._teams.get(payload.team, payload.team)))
            del self._moments[:-REMEMBERED_MOMENTS]

    # --- the feed and the deadlines -------------------------------------------------------------

    def _feed(self) -> SocialFeed | None:
        return self._feeds.get(self._state.doc.settings.source)

    async def fetch(self) -> None:
        """Ask the chosen source for what is new, and take it in."""
        feed = self._feed()
        if feed is None:
            return
        poll = self._state.doc.poll
        options = len(poll.options) if poll is not None and poll.state == "open" else 0
        moments, self._moments = tuple(self._moments), []
        try:
            batch = await asyncio.wait_for(feed.fetch(FeedContext(options, moments)), FETCH_TIMEOUT_S)
        except (FeedFailure, TimeoutError) as exc:
            problem = str(exc) or "The source did not answer in time."
            self._fetch_at = self._now() + RETRY_AFTER_FAILURE_S
            await self.apply(lambda state: rules.set_source_health(state, problem), save=False)
            return
        self._fetch_at = self._now() + feed.interval_s
        await self.take(batch, demo=feed.demo, save=False)
        await self.apply(lambda state: rules.set_source_health(state, None), save=False)

    async def tick(self) -> None:
        now = self._now()
        async with self._lock:
            self._commit(rules.refresh(rules.expire(self._state, now), now), save=False)
        if self._feed() is not None and now >= self._fetch_at:
            await self.fetch()
        if self._unsaved and self._now() - self._saved_at >= SAVE_EVERY_S:
            self.flush()

    def flush(self) -> None:
        """Save what the feeds have brought in since the last save. A failure is retried later."""
        if not self._unsaved:
            return
        try:
            self._save(self._state)
        except FanError as exc:
            log.warning("the fan zone could not be saved (%s); trying again later", exc.message)
            self._saved_at = self._now()

    def _next_wake(self) -> float | None:
        times = []
        deadline = rules.next_deadline(self._state)
        if deadline is not None:
            times.append(deadline)
        if self._feed() is not None:
            times.append(self._fetch_at)
        if self._unsaved:
            times.append(self._saved_at + SAVE_EVERY_S)
        return min(times) if times else None

    async def run(self) -> None:
        try:
            while True:
                # Cleared before the tick, so a change made during it is not lost.
                self._wake.clear()
                try:
                    await self.tick()
                except FanError as exc:
                    log.warning("could not settle the fan zone (%s); retrying", exc.message)
                    await asyncio.sleep(1)
                    continue
                wake = self._next_wake()
                timeout = None if wake is None else max(0.05, wake - self._now())
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout)
                except TimeoutError:
                    pass
        finally:
            self.flush()
