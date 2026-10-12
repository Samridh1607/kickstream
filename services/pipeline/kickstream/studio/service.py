"""Holds the studio document: applies rules, saves, notifies pages, and settles deadlines."""

import asyncio
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable

from pydantic import ValidationError

from kickstream.contracts import KeyMoment, Studio, StudioSettings
from kickstream.ports.image_store import ImageStore, ImageStoreFull
from kickstream.ports.studio_store import StudioStore
from kickstream.studio import rules
from kickstream.studio.rules import StudioError
from kickstream.studio.templates import default_studio

log = logging.getLogger(__name__)


class StudioService:
    def __init__(
        self,
        store: StudioStore,
        images: ImageStore,
        *,
        now: Callable[[], float] = time.time,
        start_match: Callable[[], Awaitable[str]],
        find_moment: Callable[[str, str], KeyMoment | None],
    ) -> None:
        self._store = store
        self._images = images
        self._now = now
        self._start_match = start_match
        self._find_moment = find_moment
        self._doc = store.load() or default_studio()
        self._lock = asyncio.Lock()
        self._wake = asyncio.Event()
        self._listeners: set[asyncio.Event] = set()

    @property
    def doc(self) -> Studio:
        return self._doc.model_copy(update={"server_time": self._now()})

    @property
    def settings(self) -> StudioSettings:
        return self._doc.settings

    def now(self) -> float:
        return self._now()

    async def apply(self, change: Callable[[Studio], Studio]) -> Studio:
        async with self._lock:
            return self._commit(change(self._doc))

    def _commit(self, changed: Studio) -> Studio:
        if changed is self._doc:
            return self.doc
        try:
            candidate = Studio.model_validate(
                changed.model_copy(update={"revision": self._doc.revision + 1}).model_dump()
            )
        except ValidationError as exc:
            first = exc.errors()[0]
            raise StudioError(422, ".".join(str(part) for part in first["loc"]), first["msg"]) from exc
        try:
            self._store.save(candidate)
        except OSError as exc:
            raise StudioError(503, "studio", "The change could not be saved. Nothing was changed.") from exc
        self._doc = candidate
        for listener in self._listeners:
            listener.set()
        self._wake.set()
        return self.doc

    # --- changes that need the clock or a lookup ---------------------------------------------

    async def banner(self, text: str, kind: str, duration_s: int, source_id: str | None = None) -> Studio:
        return await self.apply(
            lambda doc: rules.enqueue_banner(doc, text, kind, duration_s, self._now(), source_id)
        )

    async def clear_banner(self) -> Studio:
        return await self.apply(lambda doc: rules.clear_banner(doc, self._now()))

    async def countdown(self, starts_at: float, label: str = "") -> Studio:
        return await self.apply(lambda doc: rules.start_countdown(doc, starts_at, self._now(), label))

    async def take_break(self, minutes: int, label: str = "") -> Studio:
        return await self.apply(lambda doc: rules.start_break(doc, minutes, self._now(), label))

    async def replay(self, match_id: str, moment_id: str) -> Studio:
        moment = self._find_moment(match_id, moment_id)
        if moment is None:
            raise StudioError(404, "moment", "That key moment is no longer available to replay.")
        return await self.apply(lambda doc: rules.start_replay(doc, moment, self._now()))

    # --- images -------------------------------------------------------------------------------

    def upload(self, content: bytes) -> str:
        if len(content) > rules.MAX_IMAGE_BYTES:
            raise StudioError(422, "image", "An image can be at most 2 MB.")
        media_type = rules.sniff_image(content)
        if media_type is None:
            raise StudioError(422, "image", "Only PNG, JPEG and WebP images can be uploaded.")
        try:
            return self._images.save(content, media_type)
        except ImageStoreFull as exc:
            raise StudioError(422, "image", "The studio already holds as many images as it allows.") from exc
        except OSError as exc:
            raise StudioError(503, "image", "The image could not be saved.") from exc

    def image(self, image_id: str) -> tuple[bytes, str] | None:
        return self._images.get(image_id)

    # --- deadlines ----------------------------------------------------------------------------

    async def tick(self) -> None:
        async with self._lock:
            settled, actions = rules.expire(self._doc, self._now())
            self._commit(settled)
        for action in actions:
            if action == "start_match":
                try:
                    await self._start_match()
                except Exception:  # noqa: BLE001 - the program has already cut to live; report and carry on
                    log.exception("the match could not be started at the end of the countdown")

    async def run(self) -> None:
        while True:
            # Cleared before the tick, so a change made during it is not lost.
            self._wake.clear()
            try:
                await self.tick()
            except StudioError as exc:
                log.warning("could not settle studio deadlines (%s); retrying", exc.message)
                await asyncio.sleep(1)
                continue
            deadline = rules.next_deadline(self._doc)
            timeout = None if deadline is None else max(0.0, deadline - self._now())
            try:
                await asyncio.wait_for(self._wake.wait(), timeout)
            except TimeoutError:
                pass

    # --- pages --------------------------------------------------------------------------------

    async def changes(self) -> AsyncIterator[Studio]:
        """The current document, then the latest one after each change. Slow readers skip steps."""
        listener = asyncio.Event()
        self._listeners.add(listener)
        try:
            yield self.doc
            while True:
                await listener.wait()
                listener.clear()
                yield self.doc
        finally:
            self._listeners.discard(listener)
