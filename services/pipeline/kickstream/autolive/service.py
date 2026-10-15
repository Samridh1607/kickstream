"""Auto live: rotates the screens on a timer with fresh commentary, keeps a match playing and the stream up, 24/7."""

import asyncio
import contextlib
import logging
import random
import secrets
import time
from collections.abc import AsyncIterator, Awaitable, Callable

from pydantic import ValidationError

from kickstream.autolive.commentary import CommentaryService
from kickstream.autolive.facts import MatchFacts
from kickstream.autolive.scenes import SCENE_IDS, TRANSITIONS, auto_scenes
from kickstream.autolive.speech import SpeechService
from kickstream.contracts import (
    AutoCommentary,
    AutoLive,
    AutoLiveScene,
    AutoLiveSettings,
    FanZone,
    Output,
    RunningMatch,
)
from kickstream.domain.errors import Refusal
from kickstream.ports.output import RecordStore

log = logging.getLogger(__name__)

TICK_S = 1.0
# A finished match stays on screen this long, with its recap, before the next kicks off.
BETWEEN_MATCHES_S = 45.0
# Waits before starting the stream again after it stopped by itself: growing, never giving up.
STREAM_RETRY_S = (5.0, 15.0, 30.0, 60.0, 120.0, 300.0)
# A stream that has stayed live this long has recovered: the next failure waits the shortest time again.
STREAM_HEALTHY_S = 300.0


class AutoLiveError(Refusal):
    """A change the auto live rules refuse."""


def default_settings(enabled: bool = False) -> AutoLiveSettings:
    return AutoLiveSettings(
        enabled=enabled,
        rotate=True,
        min_minutes=5,
        max_minutes=10,
        commentary=True,
        talk_minutes=2,
        narration=True,
        voice="en-GB-RyanNeural",
        rate=1.05,
        scenes=list(SCENE_IDS),
        keep_match=True,
        match_speed=1,
        stream=False,
    )


def check(settings: AutoLiveSettings) -> AutoLiveSettings:
    if settings.min_minutes > settings.max_minutes:
        raise AutoLiveError(
            422, "min_minutes", "The shortest time on a screen cannot be longer than the longest."
        )
    unknown = [scene for scene in settings.scenes if scene not in SCENE_IDS]
    if unknown:
        raise AutoLiveError(422, "scenes", f"There is no auto live screen called {unknown[0]}.")
    if not settings.scenes:
        raise AutoLiveError(422, "scenes", "Keep at least one screen in the rotation.")
    # Catalogue order, once each, so the rotation is the same whatever order they were sent in.
    return settings.model_copy(update={"scenes": [scene for scene in SCENE_IDS if scene in settings.scenes]})


class AutoLiveService:
    def __init__(
        self,
        store: RecordStore,
        *,
        facts: MatchFacts,
        commentary: CommentaryService,
        speech: SpeechService,
        running_match: Callable[[], RunningMatch | None],
        start_match: Callable[[int, float], Awaitable[str]],
        output_view: Callable[[], Output],
        start_output: Callable[[str], None],
        stop_output: Callable[[], Awaitable[None]],
        program_url: str,
        fans: Callable[[], FanZone | None] = lambda: None,
        now: Callable[[], float] = time.time,
        rng: random.Random | None = None,
        enabled_at_first: bool = False,
    ) -> None:
        self._store = store
        self._facts = facts
        self._commentary = commentary
        self._speech = speech
        self._running_match = running_match
        self._start_match = start_match
        self._output_view = output_view
        self._start_output = start_output
        self._stop_output = stop_output
        self._program_url = program_url
        self._fans = fans
        self._now = now
        self._rng = rng or random.Random()
        self._scenes = auto_scenes()
        self._by_id = {scene.id: scene for scene in self._scenes}
        self._listeners: set[asyncio.Event] = set()
        self._wake = asyncio.Event()
        self._revision = 0
        settings, scene_id = self._load(enabled_at_first)
        self._settings = settings
        self._scene_id = scene_id
        self._changed_at = now()
        self._next_at: float | None = None
        self._transition = "fade"
        self._commentary_doc: AutoCommentary | None = None
        self._talk: asyncio.Task | None = None
        self._talked_at = 0.0
        self._problems: dict[str, str | None] = {}
        self._matches_started = 0
        self._idle_since: float | None = None
        self._stream_restarts = 0
        self._stream_failures = 0
        self._stream_retry_at = 0.0
        self._live_since: float | None = None
        self._owns_output = False
        self._schedule()

    # --- the document ---------------------------------------------------------------------------

    def _load(self, enabled_at_first: bool) -> tuple[AutoLiveSettings, str]:
        record = self._store.load() or {}
        try:
            settings = check(AutoLiveSettings.model_validate(record.get("settings")))
        except (ValidationError, AutoLiveError):
            if record:
                log.warning("the saved auto live settings cannot be used; starting from the defaults")
            settings = default_settings(enabled_at_first)
        scene_id = record.get("scene_id")
        if scene_id not in settings.scenes:
            scene_id = settings.scenes[0]
        return settings, scene_id

    def _save(self) -> None:
        try:
            self._store.save({"settings": self._settings.model_dump(mode="json"), "scene_id": self._scene_id})
        except OSError as exc:
            raise AutoLiveError(
                503, "settings", "The change could not be saved. Nothing was changed."
            ) from exc

    def view(self) -> AutoLive:
        return AutoLive(
            revision=self._revision,
            server_time=self._now(),
            settings=self._settings,
            scenes=self._scenes,
            scene_id=self._scene_id,
            changed_at=self._changed_at,
            next_at=self._next_at,
            transition=self._transition,
            commentary=self._commentary_doc,
            speech=self._speech.view(),
            matches_started=self._matches_started,
            stream_restarts=self._stream_restarts,
            problem=" ".join(problem for problem in self._problems.values() if problem) or None,
        )

    def changed(self) -> None:
        self._revision += 1
        for listener in self._listeners:
            listener.set()

    async def changes(self) -> AsyncIterator[AutoLive]:
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

    @property
    def settings(self) -> AutoLiveSettings:
        return self._settings

    @property
    def scene(self) -> AutoLiveScene:
        return self._by_id[self._scene_id]

    # --- changes from the page ------------------------------------------------------------------

    def set_settings(self, settings: AutoLiveSettings) -> AutoLive:
        settings = check(settings)
        before = self._settings
        self._settings = settings
        if self._scene_id not in settings.scenes:
            self._show(settings.scenes[0])
        try:
            self._save()
        except AutoLiveError:
            self._settings = before
            raise
        switched_on = settings.enabled and not before.enabled
        if switched_on:
            self._changed_at = self._now()
        timing = ("enabled", "rotate", "min_minutes", "max_minutes")
        if any(getattr(before, name) != getattr(settings, name) for name in timing):
            self._schedule()
        if before.stream and not settings.stream:
            self._stream_failures = 0
            self._stream_retry_at = 0.0
        if not settings.enabled and self._talk is not None:
            self._talk.cancel()
        self.changed()
        if switched_on:
            self._comment(opening=True)
        self._wake.set()
        return self.view()

    def next_scene(self) -> AutoLive:
        self._show(self._following())
        return self.view()

    def show(self, scene_id: str) -> AutoLive:
        if scene_id not in self._by_id:
            raise AutoLiveError(404, "scene_id", f"There is no auto live screen called {scene_id}.")
        self._show(scene_id)
        return self.view()

    def say(self) -> AutoLive:
        """Fresh commentary on the screen on air, now."""
        self._comment(opening=False)
        return self.view()

    async def speak(self, text: str) -> bytes:
        return await self._speech.speak(text, self._settings.voice, self._settings.rate)

    # --- rotation and commentary ----------------------------------------------------------------

    def _following(self) -> str:
        order = self._settings.scenes
        if self._scene_id not in order:
            return order[0]
        return order[(order.index(self._scene_id) + 1) % len(order)]

    def _schedule(self) -> None:
        s = self._settings
        self._next_at = (
            self._changed_at + self._rng.uniform(s.min_minutes, s.max_minutes) * 60
            if s.enabled and s.rotate
            else None
        )

    def _show(self, scene_id: str) -> None:
        self._transition = self._rng.choice([t for t in TRANSITIONS if t != self._transition])
        self._scene_id = scene_id
        self._changed_at = self._now()
        self._schedule()
        with contextlib.suppress(AutoLiveError):
            self._save()
        self.changed()
        self._comment(opening=True)

    def _comment(self, *, opening: bool) -> None:
        if not (self._settings.enabled and self._settings.commentary):
            return
        if self._talk is not None and not self._talk.done():
            self._talk.cancel()
        self._talked_at = self._now()
        self._talk = asyncio.create_task(self._write(self.scene, opening))

    async def _write(self, scene: AutoLiveScene, opening: bool) -> None:
        try:
            text, source = await self._commentary.write(scene, self._facts, self._fans(), opening=opening)
        except Exception:
            log.exception("auto live commentary could not be written")
            return
        if scene.id != self._scene_id:
            return
        self._commentary_doc = AutoCommentary(
            id=secrets.token_hex(6), scene_id=scene.id, text=text, source=source, at=self._now()
        )
        self.changed()

    # --- the loop -------------------------------------------------------------------------------

    async def run(self) -> None:
        self._comment(opening=True)
        try:
            while True:
                try:
                    await self.tick()
                except Exception:
                    log.exception("auto live stumbled; carrying on")
                self._wake.clear()
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._wake.wait(), TICK_S)
        finally:
            if self._talk is not None:
                self._talk.cancel()

    async def stop(self) -> None:
        if self._owns_output and self._output_view().state != "idle":
            await self._stop_output()
        self._owns_output = False

    async def tick(self) -> None:
        now = self._now()
        s = self._settings
        if s.enabled:
            if self._next_at is not None and now >= self._next_at:
                self._show(self._following())
            elif s.commentary and s.talk_minutes > 0 and now - self._talked_at >= s.talk_minutes * 60:
                self._comment(opening=False)
            if s.keep_match:
                await self._keep_match(now)
        await self._keep_stream(now)

    async def _keep_match(self, now: float) -> None:
        if self._running_match() is not None:
            self._idle_since = None
            return
        if self._idle_since is None:
            # Straight away when nothing has played yet; after the full-time screens otherwise.
            self._idle_since = now - (BETWEEN_MATCHES_S if self._facts.status is None else 0)
        if now - self._idle_since < BETWEEN_MATCHES_S:
            return
        self._idle_since = None
        try:
            await self._start_match(self._rng.randrange(1, 1_000_000), self._settings.match_speed)
        except Exception as exc:
            self._set_problem("match", f"The next match could not start: {exc}")
            return
        self._matches_started += 1
        self._set_problem("match", None)
        self.changed()

    async def _keep_stream(self, now: float) -> None:
        output = self._output_view()
        if not (self._settings.enabled and self._settings.stream):
            if self._owns_output and output.state != "idle":
                await self._stop_output()
            self._owns_output = False
            self._live_since = None
            self._set_problem("stream", None)
            return
        if not self._owns_output:
            if output.state != "idle":
                self._set_problem(
                    "stream", "The studio's stream is on air; auto live goes on air when it ends."
                )
                return
            if now < self._stream_retry_at:
                return
            try:
                self._start_output(self._program_url)
            except Refusal as exc:
                self._set_problem("stream", f"The stream could not start: {exc.message}")
                self._retry_later(now)
                return
            self._owns_output = True
            return
        if output.state == "live":
            self._live_since = self._live_since or now
            self._set_problem("stream", None)
            if now - self._live_since >= STREAM_HEALTHY_S:
                self._stream_failures = 0
            return
        if output.state != "idle":
            return
        # Ours, and it stopped without being told to here: start it again, waiting longer each time.
        self._stream_restarts += 1
        self._retry_later(now)
        self._live_since = None
        self._owns_output = False
        why = f" ({output.problem})" if output.problem else ""
        self._set_problem("stream", f"The stream stopped{why}; starting it again.")
        self.changed()

    def _retry_later(self, now: float) -> None:
        self._stream_retry_at = now + STREAM_RETRY_S[min(self._stream_failures, len(STREAM_RETRY_S) - 1)]
        self._stream_failures += 1

    def _set_problem(self, kind: str, problem: str | None) -> None:
        if self._problems.get(kind) != problem:
            self._problems[kind] = problem
            self.changed()
