"""Holds the output state and runs a stream: the hidden browser, the encoder, and a sender per destination."""

import asyncio
import logging
import secrets
import time
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable, Coroutine
from dataclasses import replace
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from kickstream.contracts import Output
from kickstream.output import rules
from kickstream.output.rules import OutputError, OutputState
from kickstream.ports.output import (
    Encoder,
    OutputFailure,
    ProgramCapture,
    Quality,
    RecordStore,
    Sender,
    Target,
)

log = logging.getLogger(__name__)


def capture_address(program_url: str, token: str) -> str:
    """The program page's address with the run's token added, keeping any query it already has."""
    parts = urlsplit(program_url)
    query = [
        (name, value) for name, value in parse_qsl(parts.query, keep_blank_values=True) if name != "capture"
    ]
    return urlunsplit(parts._replace(query=urlencode([*query, ("capture", token)])))


class _Ended(Exception):
    """The run ended by itself. The message is what the streamer is told."""

    def __init__(self, message: str, *, retry: bool = True) -> None:
        super().__init__(message)
        self.retry = retry


class _Buffer:
    """Stream waiting for one sender. Bounded, so a slow destination cannot grow memory."""

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._chunks: deque[bytes] = deque()
        self._size = 0
        self._ready = asyncio.Event()
        self.overflow = asyncio.Event()
        self.overflowed = False

    def put(self, chunk: bytes) -> None:
        if self._size + len(chunk) > self._limit:
            self.overflowed = True
            self.overflow.set()
            self._chunks.clear()
            self._size = 0
        self._chunks.append(chunk)
        self._size += len(chunk)
        self._ready.set()

    async def get(self) -> bytes:
        while not self._chunks:
            self._ready.clear()
            await self._ready.wait()
        chunk = self._chunks.popleft()
        self._size -= len(chunk)
        return chunk

    def clear(self) -> None:
        self._chunks.clear()
        self._size = 0
        self.overflowed = False
        self.overflow.clear()


class OutputService:
    def __init__(
        self,
        store: RecordStore,
        keys: RecordStore,
        *,
        capture: ProgramCapture,
        encoder: Encoder,
        new_sender: Callable[[], Sender],
        program_url: str,
        recordings_dir: Path,
        now: Callable[[], float] = time.time,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        new_token: Callable[[], str] = lambda: secrets.token_urlsafe(24),
        start_timeout_s: float = 20.0,
        restart_window_s: float = 60.0,
        buffer_s: float = 10.0,
    ) -> None:
        self._store = store
        self._keys = keys
        self._capture = capture
        self._encoder = encoder
        self._new_sender = new_sender
        self._program_url = program_url
        self._run_url = program_url
        self._recordings_dir = Path(recordings_dir)
        self._now = now
        self._sleep = sleep
        self._new_token = new_token
        self._start_timeout_s = start_timeout_s
        self._restart_window_s = restart_window_s
        self._buffer_s = buffer_s
        self._state = self._load()
        self._listeners: set[asyncio.Event] = set()
        self._run: asyncio.Task | None = None
        self._cancelled = False  # the current run has been told to stop, once
        self._token: str | None = None  # the page allowed to send video, one per attempt
        self._video = asyncio.Event()
        self._feed_lost = asyncio.Event()
        self._buffers: dict[str, _Buffer] = {}

    def _load(self) -> OutputState:
        record = self._store.load()
        if record is None:
            return rules.empty_state()
        try:
            return rules.load(record, self._keys.load())
        except (ValueError, TypeError, KeyError) as exc:
            log.warning("the saved output record cannot be used (%s); starting empty", type(exc).__name__)
            self._store.set_aside()
            return rules.empty_state()

    # --- reading and changing ---------------------------------------------------------------------

    def view(self) -> Output:
        return rules.view(self._state, self._now())

    def _apply(self, change: Callable[[OutputState], OutputState], *, save: bool = True) -> None:
        """Apply one rule. What a run does to the state is not saved: a restart begins idle anyway."""
        changed = change(self._state)
        if changed is self._state:
            return
        candidate = replace(
            changed, doc=changed.doc.model_copy(update={"revision": self._state.doc.revision + 1})
        )
        if save:
            try:
                if candidate.keys != self._state.keys:
                    self._keys.save(rules.dump_keys(candidate))
                self._store.save(rules.dump(candidate))
            except OSError as exc:
                raise OutputError(
                    503, "output", "The change could not be saved. Nothing was changed."
                ) from exc
        self._state = candidate
        for listener in self._listeners:
            listener.set()

    def add_destination(self, name: str, platform: str, url: str, key: str) -> None:
        self._apply(lambda state: rules.add_destination(state, name, platform, url, key))

    def edit_destination(
        self, destination_id: str, *, name: str, url: str, enabled: bool, key: str | None = None
    ) -> None:
        self._apply(
            lambda state: rules.edit_destination(
                state, destination_id, name=name, url=url, enabled=enabled, key=key
            )
        )

    def remove_destination(self, destination_id: str) -> None:
        self._apply(lambda state: rules.remove_destination(state, destination_id))

    def set_quality(self, quality: str) -> None:
        self._apply(lambda state: rules.set_quality(state, quality))

    def ensure_recording(self) -> None:
        self._apply(rules.ensure_recording)

    async def changes(self) -> AsyncIterator[Output]:
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

    # --- a run --------------------------------------------------------------------------------------

    def start(self, program_url: str | None = None) -> None:
        """Go live with the studio's program page, or with another page such as auto live's."""
        begun = rules.begin(self._state)
        missing = self._encoder.available() or self._capture.available()
        if missing:
            raise OutputError(503, "output", missing)
        self._run_url = program_url or self._program_url
        self._apply(lambda _: begun, save=False)
        self._cancelled = False
        run = self._run = asyncio.create_task(self._supervise())
        run.add_done_callback(lambda _: self._finish(run, None))

    async def stop(self) -> None:
        run = self._run
        if run is None:
            return
        self._apply(rules.stopping, save=False)
        if not self._cancelled:  # a second stop waits for the first one's clean-up, it does not interrupt it
            self._cancelled = True
            run.cancel()
        # wait() does not cancel the run if this caller is cancelled, so the clean-up always completes
        await asyncio.wait({run})
        self._finish(run, None)

    def _finish(self, run: asyncio.Task, problem: str | None) -> None:
        """End the run however its task ended, including being cancelled before its first step. Once only."""
        if self._run is not run:
            return
        self._token = None
        self._run = None
        self._apply(lambda state: rules.finish(state, problem), save=False)

    async def _supervise(self) -> None:
        """Run until stopped. A run that ends by itself is restarted once, then given up on."""
        problem: str | None = None
        last_failure: float | None = None
        try:
            while True:
                try:
                    await self._run_once()
                except _Ended as ended:
                    reason, retry = str(ended), ended.retry
                except Exception:
                    log.exception("the stream stopped unexpectedly")
                    reason, retry = "The stream stopped unexpectedly.", False
                now = self._now()
                if not retry or (last_failure is not None and now - last_failure < self._restart_window_s):
                    problem = reason
                    return
                last_failure = now
                log.warning("the stream stopped (%s); restarting it", reason)
                self._apply(rules.restarting, save=False)
        finally:
            run = asyncio.current_task()
            assert run is not None
            self._finish(run, problem)

    async def _run_once(self) -> None:
        """One attempt: start everything, wait for something to end, then end the rest. Always raises."""
        quality = rules.QUALITIES[self._state.doc.quality]
        self._token = self._new_token()
        self._video = asyncio.Event()
        self._feed_lost = asyncio.Event()
        self._buffers = {}
        relays: list[asyncio.Task] = []
        watchers: list[asyncio.Task] = []
        try:
            await self._encoder.start(quality)
            fan = asyncio.create_task(self._fan_out(quality, relays))
            watchers.append(fan)
            await self._capture.start(
                capture_address(self._run_url, self._token), quality.width, quality.height
            )
            gone = asyncio.create_task(self._capture.wait())
            lost = asyncio.create_task(self._feed_lost.wait())
            first = asyncio.create_task(self._video.wait())
            watchers += [gone, lost, first]
            endings = {fan, gone, lost}
            done, _ = await asyncio.wait(
                {*endings, first}, timeout=self._start_timeout_s, return_when=asyncio.FIRST_COMPLETED
            )
            if not done:
                raise _Ended("The program page did not start sending video in time.", retry=False)
            if not done & endings:
                done, _ = await asyncio.wait(endings, return_when=asyncio.FIRST_COMPLETED)
            if fan in done:
                if fan.exception() is not None:
                    log.error("the stream could not be passed on", exc_info=fan.exception())
                raise _Ended("The encoder stopped.")
            if gone in done:
                raise _Ended("The hidden browser stopped.")
            raise _Ended("The program page stopped sending video.")
        except OutputFailure as exc:
            raise _Ended(str(exc), retry=False) from exc
        finally:
            await self._uninterrupted(self._wind_down(watchers, relays))

    @staticmethod
    async def _uninterrupted(work: Coroutine) -> None:
        """Finish `work` even if this task is cancelled meanwhile, then pass the cancellation on."""
        job = asyncio.ensure_future(work)
        cancelled = False
        while not job.done():
            try:
                await asyncio.shield(job)
            except asyncio.CancelledError:
                cancelled = True
        await asyncio.gather(job, return_exceptions=True)
        if cancelled:
            raise asyncio.CancelledError

    async def _wind_down(self, watchers: list[asyncio.Task], relays: list[asyncio.Task]) -> None:
        for task in [*watchers, *relays]:
            task.cancel()
        await asyncio.gather(*watchers, *relays, return_exceptions=True)
        for part in (self._capture, self._encoder):
            try:
                await part.stop()
            except Exception as exc:  # one part failing to stop must not leave the other running
                log.error("could not stop %s (%s)", type(part).__name__, type(exc).__name__)

    async def _fan_out(self, quality: Quality, relays: list[asyncio.Task]) -> None:
        """Hand every piece of the encoded stream to every destination's buffer."""
        limit = int((quality.video_kbps + quality.audio_kbps) * 1000 / 8 * self._buffer_s)
        async for chunk in self._encoder.output():
            if not self._video.is_set():
                self._video.set()
                self._apply(lambda state: rules.went_live(state, self._now()), save=False)
                for destination in self._state.doc.destinations:
                    if destination.enabled:
                        buffer = self._buffers[destination.id] = _Buffer(limit)
                        relays.append(asyncio.create_task(self._relay(destination.id, buffer)))
            for buffer in self._buffers.values():
                buffer.put(chunk)

    def _mark(self, destination_id: str, status: str, reason: str | None = None) -> None:
        now = self._now() if status == "live" else None
        self._apply(lambda state: rules.mark(state, destination_id, status, reason, now), save=False)

    async def _relay(self, destination_id: str, buffer: _Buffer) -> None:
        """Keep one destination supplied, starting its sender again when it ends."""
        failures = 0
        while True:
            was_live, reason = await self._attempt(destination_id, buffer)
            failures = 1 if was_live else failures + 1
            if failures >= rules.MAX_FAILURES:
                self._mark(destination_id, "failed", reason)
                return
            self._mark(destination_id, "retrying", reason)
            await self._sleep(rules.retry_delay(failures))
            buffer.clear()  # a new sender starts from now, not from what piled up while it was away

    async def _attempt(self, destination_id: str, buffer: _Buffer) -> tuple[bool, str]:
        """Run one sender until it ends. Returns whether it was ever live, and why it ended."""
        sender: Sender | None = None
        target: Target | None = None
        key = ""
        was_live = False

        def on_live() -> None:
            nonlocal was_live
            was_live = True
            self._mark(destination_id, "live")

        reason = ""
        try:
            destination = next(d for d in self._state.doc.destinations if d.id == destination_id)
            key = self._state.keys.get(destination_id, "")
            target = rules.target_for(destination, key, self._recordings_dir, self._now())
            sender = self._new_sender()
            self._mark(destination_id, "connecting")
            await sender.start(target, on_live)
            reason = await self._deliver(buffer, sender)
        except OutputFailure as exc:
            reason = str(exc)
        except Exception as exc:  # never the text or the target: they can hold the stream key
            log.error("a sender failed unexpectedly (%s)", type(exc).__name__)
            reason = "The connection failed unexpectedly."
        finally:
            await self._uninterrupted(self._clean_up(sender, target))
        return was_live, rules.redact(reason or "The connection closed.", key)

    async def _clean_up(self, sender: Sender | None, target: Target | None) -> None:
        if sender is not None:
            try:
                await sender.stop()
            except Exception as exc:
                log.error("a sender could not be stopped (%s)", type(exc).__name__)
        if target is not None:
            self._list_recording(target)

    async def _deliver(self, buffer: _Buffer, sender: Sender) -> str:
        """Pass the stream on until the sender ends or falls too far behind. Returns why."""

        async def pump() -> None:
            while True:
                chunk = await buffer.get()
                if buffer.overflowed:
                    return
                await sender.write(chunk)

        # A sender stuck inside write() never looks at the buffer, so the overflow is watched separately.
        pumping = asyncio.create_task(pump())
        ended = asyncio.create_task(sender.wait())
        behind = asyncio.create_task(buffer.overflow.wait())
        try:
            done, _ = await asyncio.wait({pumping, ended, behind}, return_when=asyncio.FIRST_COMPLETED)
            if ended in done:
                return ended.result()
            if pumping in done and not buffer.overflowed:
                pumping.result()  # the sender refused a write: raises why
            return "It fell too far behind and was restarted."
        finally:
            for task in (pumping, ended, behind):
                task.cancel()
            await asyncio.gather(pumping, ended, behind, return_exceptions=True)

    def _list_recording(self, target: Target) -> None:
        if target.kind != "file":
            return
        path = Path(target.location)
        try:
            size = path.stat().st_size
        except OSError:
            return
        if size == 0:
            return
        try:
            self._apply(lambda state: rules.add_recording(state, path.name, size, self._now()))
        except OutputError as exc:
            log.warning("the recording %s could not be listed: %s", path.name, exc.message)

    # --- video from the program page --------------------------------------------------------------

    def accepts(self, token: str) -> bool:
        """Whether a page presenting this token is the one this run opened."""
        if self._token is None:
            return False
        # Bytes, so any text can be compared (compare_digest rejects non-ASCII str) and still in constant time.
        # errors="surrogatepass" keeps a lone surrogate from a malformed query from raising here.
        return secrets.compare_digest(token.encode(errors="surrogatepass"), self._token.encode())

    async def feed(self, token: str, chunks: AsyncIterator[bytes]) -> None:
        """Pass a page's recording to the encoder, for as long as that page is the current one."""
        if not self.accepts(token):
            return
        lost = self._feed_lost  # this attempt's, so an old page ending cannot stop a newer attempt
        try:
            async for chunk in chunks:
                if token != self._token:
                    return
                await self._encoder.write(chunk)
        finally:
            lost.set()
