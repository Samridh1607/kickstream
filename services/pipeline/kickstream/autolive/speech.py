"""Auto live's voice: Azure Speech, with a cache so a line said before costs nothing, and a daily allowance."""

import asyncio
import contextlib
import hashlib
import logging
import os
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from kickstream.contracts import AutoSpeech
from kickstream.ports.output import RecordStore
from kickstream.ports.speech import SpeechFailure, SpeechSynth

log = logging.getLogger(__name__)
MAX_TEXT = 600


def _day(now: float) -> str:
    return datetime.fromtimestamp(now, UTC).date().isoformat()


class SpeechService:
    def __init__(
        self,
        synth: SpeechSynth,
        budget: RecordStore,
        cache_dir: Path,
        *,
        daily_chars: int = 200_000,
        max_cached: int = 400,
        now: Callable[[], float] = time.time,
        on_change: Callable[[], None] = lambda: None,
    ) -> None:
        self._synth = synth
        self._budget = budget
        self._cache_dir = Path(cache_dir)
        self._daily_chars = daily_chars
        self._max_cached = max_cached
        self._now = now
        self._on_change = on_change
        self._problem: str | None = None
        self._inflight: dict[str, asyncio.Task[bytes]] = {}

    def view(self) -> AutoSpeech:
        return AutoSpeech(
            azure=self._synth.available(),
            region=self._synth.region,
            chars_today=self._used(),
            chars_limit=self._daily_chars,
            problem=self._problem,
        )

    def _used(self) -> int:
        record = self._budget.load() or {}
        used = record.get("chars")
        return used if record.get("day") == _day(self._now()) and isinstance(used, int) else 0

    def _count(self, chars: int) -> None:
        with contextlib.suppress(OSError):
            self._budget.save({"day": _day(self._now()), "chars": self._used() + chars})

    def _set_problem(self, problem: str | None) -> None:
        if problem != self._problem:
            self._problem = problem
            self._on_change()

    async def speak(self, text: str, voice: str, rate: float) -> bytes:
        """MP3 of the text. Raises SpeechFailure, whose message the page shows before using its own voice."""
        text = " ".join(text.split())
        if not text or len(text) > MAX_TEXT:
            raise SpeechFailure(f"Only 1 to {MAX_TEXT} characters can be spoken at once.")
        key = hashlib.sha256(f"{voice}|{rate:.2f}|{text}".encode()).hexdigest()
        cached = self._cache_dir / f"{key}.mp3"
        with contextlib.suppress(OSError):
            return cached.read_bytes()
        # The preview and the program ask for the same line at about the same time: make it once.
        task = self._inflight.get(key)
        if task is None:
            task = self._inflight[key] = asyncio.create_task(self._make(text, voice, rate, cached))
            task.add_done_callback(lambda _: self._inflight.pop(key, None))
        return await asyncio.shield(task)

    async def _make(self, text: str, voice: str, rate: float, cached: Path) -> bytes:
        if not self._synth.available():
            raise SpeechFailure("Azure Speech is not set up.")
        if self._used() + len(text) > self._daily_chars:
            problem = f"Today's {self._daily_chars} Azure Speech characters are used up; the browser's voice speaks until midnight UTC."
            self._set_problem(problem)
            raise SpeechFailure(problem)
        try:
            audio = await self._synth.synthesize(text, voice, rate)
        except SpeechFailure as exc:
            self._set_problem(str(exc))
            raise
        self._count(len(text))
        self._set_problem(None)
        self._keep(cached, audio)
        self._on_change()
        return audio

    def _keep(self, path: Path, audio: bytes) -> None:
        try:
            self._cache_dir.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".tmp")
            temporary.write_bytes(audio)
            os.replace(temporary, path)
            files = sorted(self._cache_dir.glob("*.mp3"), key=lambda found: found.stat().st_mtime)
            for old in files[: max(0, len(files) - self._max_cached)]:
                old.unlink(missing_ok=True)
        except OSError as exc:
            log.warning("a spoken line could not be cached (%s)", type(exc).__name__)
