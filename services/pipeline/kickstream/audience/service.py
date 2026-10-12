"""Holds the audience state: applies rules, saves, pushes views to pages, and runs expert drafts."""

import asyncio
import logging
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import replace

from pydantic import ValidationError

from kickstream.audience import rules
from kickstream.audience.rules import AudienceError, AudienceState
from kickstream.contracts import Audience
from kickstream.ports.audience_store import AudienceStore
from kickstream.ports.expert import ExpertWriter, MatchContext

log = logging.getLogger(__name__)


class AudienceService:
    def __init__(
        self,
        store: AudienceStore,
        *,
        now: Callable[[], float] = time.time,
        expert: ExpertWriter | None = None,
        context: Callable[[], MatchContext | None] = lambda: None,
        language: Callable[[], str] = lambda: "en",
        push_interval_s: float = 0.5,
        save_interval_s: float = 1.0,
        expert_timeout_s: float = 20.0,
    ) -> None:
        self._store = store
        self._now = now
        self._expert = expert
        self._context = context
        self._language = language
        self._push_interval_s = push_interval_s
        self._save_interval_s = save_interval_s
        self._expert_timeout_s = expert_timeout_s
        self._state = self._load()
        self._lock = asyncio.Lock()
        self._wake = asyncio.Event()
        self._listeners: set[asyncio.Event] = set()
        self._tasks: set[asyncio.Task] = set()
        self._unsaved_since: float | None = None  # loop time of the oldest vote not yet on disk

    def _load(self) -> AudienceState:
        record = self._store.load()
        if record is None:
            return rules.empty_state()
        try:
            return rules.load(record)
        except (ValueError, TypeError, KeyError) as exc:
            log.warning("the saved audience record cannot be used (%s); starting empty", type(exc).__name__)
            self._store.set_aside()
            return rules.empty_state()

    # --- reading --------------------------------------------------------------------------------

    def view(self, *, studio: bool) -> Audience:
        return (
            rules.studio_view(self._state, self._now())
            if studio
            else rules.fan_view(self._state, self._now())
        )

    @property
    def expert_available(self) -> bool:
        return self._expert is not None

    def now(self) -> float:
        return self._now()

    # --- changing -------------------------------------------------------------------------------

    async def apply(
        self, change: Callable[[AudienceState], AudienceState], *, structural: bool = True
    ) -> None:
        async with self._lock:
            self._commit(change(self._state), structural)

    def _commit(self, changed: AudienceState, structural: bool) -> None:
        if changed is self._state:
            return
        try:
            doc = Audience.model_validate(
                changed.doc.model_copy(update={"revision": self._state.doc.revision + 1}).model_dump()
            )
        except ValidationError as exc:
            first = exc.errors()[0]
            raise AudienceError(422, ".".join(str(part) for part in first["loc"]), first["msg"]) from exc
        candidate = replace(changed, doc=doc)
        if structural:
            try:
                self._store.save(rules.dump(candidate))
            except OSError as exc:
                raise AudienceError(
                    503, "audience", "The change could not be saved. Nothing was changed."
                ) from exc
            self._unsaved_since = None
        elif self._unsaved_since is None:
            self._unsaved_since = asyncio.get_running_loop().time()
        self._state = candidate
        for listener in self._listeners:
            listener.set()
        self._wake.set()

    async def vote(self, voter: str, option_id: str) -> None:
        await self.apply(lambda state: rules.vote(state, voter, option_id), structural=False)

    async def upvote(self, voter: str, question_id: str) -> None:
        await self.apply(lambda state: rules.upvote(state, voter, question_id), structural=False)

    async def ask(self, voter: str, text: str, nickname: str) -> str:
        """Add a fan's question and return its ID."""
        async with self._lock:
            before = {question.id for question in self._state.doc.questions}
            changed = rules.ask(self._state, voter, text, nickname, self._now())
            self._commit(changed, True)
            return next(question.id for question in changed.doc.questions if question.id not in before)

    async def create_poll(self, question: str, options: list[str], duration_s: int | None) -> None:
        await self.apply(lambda state: rules.create_poll(state, question, options, duration_s, self._now()))

    async def preset_poll(self, kind: str, home: str, away: str, duration_s: int | None) -> None:
        await self.apply(
            lambda state: rules.preset_poll(
                state, kind, home, away, self._language(), duration_s, self._now()
            )
        )

    async def air(self, duration_s: int) -> None:
        await self.apply(lambda state: rules.air(state, duration_s, self._now()))

    # --- the expert -----------------------------------------------------------------------------

    async def ask_expert(self, question_id: str) -> None:
        await self.apply(lambda state: rules.start_draft(state, question_id, self._expert is not None))
        question = rules.question_for(self._state, question_id)
        if self._expert is None or question is None:
            return
        task = asyncio.create_task(self._write_answer(question_id, question.text))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _write_answer(self, question_id: str, text: str) -> None:
        try:
            answer = await asyncio.wait_for(
                self._expert.answer(text, self._context(), self._language()), self._expert_timeout_s
            )
        except Exception as exc:  # noqa: BLE001 - any failure leaves the draft for the streamer to write
            log.warning("the match expert could not answer (%s)", type(exc).__name__)
            answer = None
        try:
            # Ignored by the rule if the streamer has since discarded the draft or moved to another question.
            await self.apply(lambda state: rules.finish_draft(state, question_id, answer))
        except AudienceError as exc:
            log.warning("the expert's answer could not be stored: %s", exc.message)

    # --- saving and deadlines ---------------------------------------------------------------------

    async def flush(self) -> None:
        """Write votes that are only in memory. A failed write is retried at the next flush."""
        async with self._lock:
            if self._unsaved_since is None:
                return
            try:
                self._store.save(rules.dump(self._state))
            except OSError as exc:
                log.warning("could not save the latest votes (%s); will retry", exc)
                self._unsaved_since = asyncio.get_running_loop().time()
                return
            self._unsaved_since = None

    async def tick(self) -> None:
        async with self._lock:
            self._commit(rules.expire(self._state, self._now()), True)

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            # Cleared before the work, so a change made during it is not lost.
            self._wake.clear()
            try:
                await self.tick()
            except AudienceError as exc:
                log.warning("could not settle audience deadlines (%s); retrying", exc.message)
                await asyncio.sleep(1)
                continue
            if self._unsaved_since is not None and loop.time() - self._unsaved_since >= self._save_interval_s:
                await self.flush()
            waits = []
            deadline = rules.next_deadline(self._state)
            if deadline is not None:
                waits.append(max(0.0, deadline - self._now()))
            if self._unsaved_since is not None:
                waits.append(max(0.0, self._unsaved_since + self._save_interval_s - loop.time()))
            try:
                await asyncio.wait_for(self._wake.wait(), min(waits) if waits else None)
            except TimeoutError:
                pass

    async def stop(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        await self.flush()

    # --- pages ----------------------------------------------------------------------------------

    async def changes(self, *, studio: bool) -> AsyncIterator[Audience]:
        """The current view, then the latest view after changes, no more often than the push interval."""
        loop = asyncio.get_running_loop()
        listener = asyncio.Event()
        self._listeners.add(listener)
        try:
            yield self.view(studio=studio)
            last = loop.time()
            while True:
                await listener.wait()
                remaining = self._push_interval_s - (loop.time() - last)
                if remaining > 0:
                    await asyncio.sleep(remaining)
                listener.clear()
                yield self.view(studio=studio)
                last = loop.time()
        finally:
            self._listeners.discard(listener)
