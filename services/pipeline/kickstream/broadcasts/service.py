"""Holds the broadcasts: applies rules, saves, pushes the document to pages, and makes reels."""

import asyncio
import logging
import shutil
import time
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import replace
from pathlib import Path

from kickstream.broadcasts import reels, rules
from kickstream.broadcasts.rules import BroadcastError, BroadcastsState
from kickstream.contracts import Audience, Broadcasts, KeyMoment, MatchStatus, Narrative, Output, Reel
from kickstream.ports.broadcasts import LiveOutput
from kickstream.ports.output import RecordStore
from kickstream.ports.reels import ClipCutter, ClipFailure, ReelBrief, ReelCandidate, ReelPick, ReelProducer

log = logging.getLogger(__name__)


class BroadcastService:
    def __init__(
        self,
        store: RecordStore,
        *,
        output: LiveOutput,
        audience_view: Callable[[], Audience | None] = lambda: None,
        audience_changes: Callable[[], AsyncIterator[Audience]] | None = None,
        producer: ReelProducer | None,
        fallback: ReelProducer,
        cutter: ClipCutter,
        recordings_dir: Path,
        reels_dir: Path,
        now: Callable[[], float] = time.time,
        new_id: Callable[[], str] = lambda: uuid.uuid4().hex[:8],
        producer_timeout_s: float = 60.0,
    ) -> None:
        self._store = store
        self._output = output
        self._audience_view = audience_view
        self._audience_changes = audience_changes
        self._producer = producer
        self._fallback = fallback
        self._cutter = cutter
        self._recordings_dir = Path(recordings_dir)
        self._reels_dir = Path(reels_dir)
        self._now = now
        self._new_id = new_id
        self._producer_timeout_s = producer_timeout_s
        self._state = self._load()
        self._listeners: set[asyncio.Event] = set()
        self._tasks: set[asyncio.Task] = set()

    def _load(self) -> BroadcastsState:
        ai = self._producer is not None
        record = self._store.load()
        if record is None:
            return rules.empty_state(ai)
        try:
            return rules.load(record, ai)
        except (ValueError, TypeError, KeyError, IndexError) as exc:
            log.warning("the saved broadcasts cannot be used (%s); starting empty", type(exc).__name__)
            self._store.set_aside()
            return rules.empty_state(ai)

    # --- reading --------------------------------------------------------------------------------

    def view(self) -> Broadcasts:
        return rules.view(self._state, self._now())

    async def changes(self) -> AsyncIterator[Broadcasts]:
        """The current document, then the latest one after each change."""
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

    def recording_file(self, broadcast_id: str, file: str) -> Path | None:
        """A recording this broadcast lists, if it is still on disk."""
        broadcast = rules.find(self._state, broadcast_id)
        if broadcast is None or not any(recording.file == file for recording in broadcast.recordings):
            return None
        path = self._recordings_dir / file
        return path if path.is_file() else None

    def reel_file(self, broadcast_id: str, reel_id: str) -> Path | None:
        broadcast = rules.find(self._state, broadcast_id)
        if broadcast is None or not any(r.id == reel_id and r.state == "ready" for r in broadcast.reels):
            return None
        path = self._reel_path(broadcast_id, reel_id)
        return path if path.is_file() else None

    def _reel_path(self, broadcast_id: str, reel_id: str) -> Path:
        return self._reels_dir / broadcast_id / f"{reel_id}.mp4"

    # --- changing -------------------------------------------------------------------------------

    def _apply(self, change: Callable[[BroadcastsState], BroadcastsState]) -> None:
        changed = change(self._state)
        if changed is self._state:
            return
        if changed.doc == self._state.doc:
            self._state = changed  # only what the live session has seen: nothing to show or save
            return
        candidate = replace(
            changed, doc=changed.doc.model_copy(update={"revision": self._state.doc.revision + 1})
        )
        try:
            self._store.save(rules.dump(candidate))
        except OSError as exc:
            raise BroadcastError(
                503, "broadcast", "The change could not be saved. Nothing was changed."
            ) from exc
        self._state = candidate
        for listener in self._listeners:
            listener.set()

    def create(self, title: str, description: str, record: bool) -> str:
        broadcast_id = self._new_id()
        self._apply(lambda state: rules.create(state, broadcast_id, title, description, record, self._now()))
        return broadcast_id

    def edit(self, broadcast_id: str, title: str, description: str) -> None:
        self._apply(lambda state: rules.edit(state, broadcast_id, title, description))

    def delete(self, broadcast_id: str) -> None:
        self._apply(lambda state: rules.delete(state, broadcast_id))
        shutil.rmtree(self._reels_dir / broadcast_id, ignore_errors=True)

    def go_live(self, broadcast_id: str) -> None:
        """Make the broadcast current and start the stream; its session opens when the stream is live."""
        self._apply(lambda state: rules.select(state, broadcast_id))
        broadcast = rules.get(self._state, broadcast_id)
        if broadcast.state == "live":
            return
        if broadcast.record:
            self._output.ensure_recording()
        self._output.start()

    async def end(self, broadcast_id: str) -> None:
        broadcast = rules.get(self._state, broadcast_id)
        running = self._output.view().state != "idle"
        if running and (broadcast.state == "live" or self._state.doc.current_id == broadcast_id):
            await self._output.stop()
            self.observe_output(self._output.view())
        self._apply(lambda state: rules.end(state, broadcast_id, self._now()))

    # --- following the output, the audience and the match -----------------------------------------

    def observe_output(self, output: Output) -> None:
        opening = output.state == "live" and rules.live(self._state) is None
        new_id = self._new_id() if opening else ""
        self._apply(
            lambda state: rules.observe_output(state, output, self._audience_view(), self._now(), new_id)
        )

    def observe_audience(self, audience: Audience) -> None:
        self._apply(lambda state: rules.observe_audience(state, audience))

    def observe_match(self, payload) -> None:
        if isinstance(payload, MatchStatus):
            self._apply(lambda state: rules.observe_status(state, payload))
        elif isinstance(payload, KeyMoment):
            self._apply(lambda state: rules.observe_moment(state, payload, self._now()))
        elif isinstance(payload, Narrative):
            self._apply(lambda state: rules.observe_narrative(state, payload))

    async def run(self) -> None:
        followers = [self._follow(self._output.changes(), self.observe_output)]
        if self._audience_changes is not None:
            followers.append(self._follow(self._audience_changes(), self.observe_audience))
        await asyncio.gather(*followers)

    @staticmethod
    async def _follow(documents: AsyncIterator, observe: Callable) -> None:
        async for doc in documents:
            try:
                observe(doc)
            except BroadcastError as exc:
                log.warning("a broadcast could not be updated: %s", exc.message)

    async def stop(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

    # --- reels ----------------------------------------------------------------------------------

    def generate_reels(self, broadcast_id: str) -> None:
        """Start making reels from the broadcast's recording. They appear as they are made."""
        missing = self._cutter.available()
        if missing:
            raise BroadcastError(503, "reels", missing)
        self._apply(lambda state: rules.begin_reels(state, broadcast_id))
        task = asyncio.create_task(self._make_reels(broadcast_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def delete_reel(self, broadcast_id: str, reel_id: str) -> None:
        self._apply(lambda state: rules.delete_reel(state, broadcast_id, reel_id))
        self._reel_path(broadcast_id, reel_id).unlink(missing_ok=True)

    async def _make_reels(self, broadcast_id: str) -> None:
        try:
            broadcast = rules.get(self._state, broadcast_id)
            recording = reels.latest_recording(broadcast)
            assert recording is not None  # begin_reels refuses a broadcast without one
            found = reels.candidates(broadcast, recording)
            picks, agent = await self._pick(
                reels.brief(broadcast, found, rules.room_for_reels(broadcast)), found
            )
            length = reels.recording_length(recording)
            by_id = {candidate.id: candidate for candidate in found}
            made = []
            for pick in picks:
                candidate = by_id[pick.candidate_id]
                start, duration = reels.window(candidate.offset_s, length)
                reel = Reel(
                    id=self._new_id(),
                    recording=recording.file,
                    moment_id=candidate.id if candidate.kind else None,
                    start_s=start,
                    duration_s=duration,
                    title=pick.title,
                    caption=pick.caption,
                    hashtags=list(pick.hashtags),
                    state="rendering",
                    agent=agent,
                    made_at=self._now(),
                )
                self._apply(lambda state, reel=reel: rules.add_reel(state, broadcast_id, reel))
                made.append(reel)
            source = self._recordings_dir / recording.file
            for reel in made:
                size, reason = None, None
                try:
                    size = await self._cutter.cut(
                        source, reel.start_s, reel.duration_s, self._reel_path(broadcast_id, reel.id)
                    )
                except ClipFailure as exc:
                    reason = str(exc)
                self._apply(
                    lambda state, reel=reel, size=size, reason=reason: rules.finish_reel(
                        state, broadcast_id, reel.id, size, reason
                    )
                )
        except BroadcastError as exc:
            log.warning("reels could not be made: %s", exc.message)
        except Exception:
            log.exception("reels could not be made")
        finally:
            try:
                self._apply(lambda state: rules.end_reels(state, broadcast_id))
            except BroadcastError as exc:
                log.warning("could not record that reels are done: %s", exc.message)

    async def _pick(self, brief: ReelBrief, found: list[ReelCandidate]) -> tuple[list[ReelPick], str]:
        """The agents' picks, or the templates' when there are no agents or they fail."""
        if self._producer is not None:
            try:
                produced = await asyncio.wait_for(self._producer.produce(brief), self._producer_timeout_s)
                picks = reels.checked(produced, found, brief.max_reels)
                if picks:
                    return picks, self._producer.name
                log.warning("the reel agents chose nothing usable; using templates")
            except Exception as exc:  # noqa: BLE001 - any failure falls back to the templates
                log.warning("the reel agents could not make reels (%s); using templates", type(exc).__name__)
        produced = await self._fallback.produce(brief)
        return reels.checked(produced, found, brief.max_reels), self._fallback.name
