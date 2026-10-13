"""Stand-ins for the browser, the encoder and the senders, driven by the test."""

import asyncio
import time
from pathlib import Path

from kickstream.ports.output import OutputFailure


class FakeNow:
    def __init__(self, at: float = 5_000.0) -> None:
        self.at = at

    def __call__(self) -> float:
        return self.at


class Sleeps:
    """Records each wait and returns at once, unless the test holds it."""

    def __init__(self) -> None:
        self.asked: list[float] = []
        self.gate = asyncio.Event()
        self.gate.set()

    async def __call__(self, seconds: float) -> None:
        self.asked.append(seconds)
        await asyncio.sleep(0)
        await self.gate.wait()


class FakeCapture:
    def __init__(self) -> None:
        self.started: list[tuple[str, int, int]] = []
        self.stopped = 0
        self.missing: str | None = None
        self.fails: str | None = None
        self._gone = asyncio.Event()

    def available(self) -> str | None:
        return self.missing

    async def start(self, url: str, width: int, height: int) -> None:
        if self.fails:
            raise OutputFailure(self.fails)
        self._gone = asyncio.Event()
        self.started.append((url, width, height))

    async def wait(self) -> None:
        await self._gone.wait()

    async def stop(self) -> None:
        self.stopped += 1

    def die(self) -> None:
        self._gone.set()

    @property
    def token(self) -> str:
        return self.started[-1][0].split("capture=")[1]


class FakeEncoder:
    def __init__(self) -> None:
        self.started: list = []
        self.written: list[bytes] = []
        self.stopped = 0
        self.missing: str | None = None
        self._out: asyncio.Queue = asyncio.Queue()

    def available(self) -> str | None:
        return self.missing

    async def start(self, quality) -> None:
        self._out = asyncio.Queue()
        self.started.append(quality)

    async def write(self, data: bytes) -> None:
        self.written.append(data)

    async def output(self):
        while (chunk := await self._out.get()) is not None:
            yield chunk

    async def stop(self) -> None:
        self.stopped += 1

    def emit(self, chunk: bytes = b"stream") -> None:
        self._out.put_nowait(chunk)

    def die(self) -> None:
        self._out.put_nowait(None)


def _write_recording(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * 2048)


class FakeSender:
    def __init__(self, made: list, *, exits_with: str | None = None, blocked: bool = False) -> None:
        made.append(self)
        self.target = None
        self.written: list[bytes] = []
        self.stopped = False
        self._exits_with = exits_with
        self._unblocked = asyncio.Event()
        if not blocked:
            self._unblocked.set()

    async def start(self, target, on_live) -> None:
        self.target = target
        self._on_live = on_live
        self._end = asyncio.get_running_loop().create_future()
        if target.kind == "file":
            _write_recording(Path(target.location))
        if self._exits_with is not None:
            self._end.set_result(self._exits_with)

    async def write(self, data: bytes) -> None:
        await self._unblocked.wait()
        self.written.append(data)

    async def wait(self) -> str:
        return await asyncio.shield(self._end)

    async def stop(self) -> None:
        self.stopped = True

    def go_live(self) -> None:
        self._on_live()

    def exit(self, reason: str) -> None:
        self._end.set_result(reason)


async def until(check, limit_s: float = 2.0) -> None:
    end = time.monotonic() + limit_s
    while not check():
        if time.monotonic() > end:
            raise AssertionError("the condition was not reached")
        await asyncio.sleep(0.005)
