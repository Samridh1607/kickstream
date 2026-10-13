"""The encoder and the senders, as ffmpeg processes fed through their standard input.

Each reads from a pipe, so it ends by itself when this process dies, however it dies.
"""

import asyncio
import contextlib
import shutil
from collections.abc import AsyncIterator, Callable
from pathlib import Path

from kickstream.ports.output import OutputFailure, Quality, Target

_TS_PACKET = 188  # MPEG-TS packets are this long; whole packets let a sender start anywhere
_READ = 64 * 1024
_QUIET = ["-hide_banner", "-loglevel", "error", "-nostats"]
_PROGRESS = (b"total_size=", b"out_time_us=")


def encoder_args(quality: Quality) -> list[str]:
    keyframe_every = str(quality.fps * 2)
    video = f"{quality.video_kbps}k"
    return [
        *_QUIET, "-fflags", "+genpts", "-analyzeduration", "2000000", "-i", "pipe:0",
        "-vf", f"scale={quality.width}:{quality.height},fps={quality.fps}",
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
        "-g", keyframe_every, "-keyint_min", keyframe_every, "-sc_threshold", "0",
        "-b:v", video, "-maxrate", video, "-bufsize", f"{2 * quality.video_kbps}k",
        "-c:a", "aac", "-b:a", f"{quality.audio_kbps}k", "-ar", "44100", "-ac", "2",
        "-f", "mpegts", "pipe:1",
    ]  # fmt: skip


def sender_args(target: Target) -> list[str]:
    copy = [
        *_QUIET,
        "-progress",
        "pipe:1",
        "-analyzeduration",
        "1000000",
        "-probesize",
        "500000",
        "-f",
        "mpegts",
        "-i",
        "pipe:0",
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
    ]
    if target.kind == "file":
        # Fragmented, so the file plays even if the recording is cut short.
        return [
            *copy,
            "-movflags",
            "+frag_keyframe+empty_moov+default_base_moof",
            "-f",
            "mp4",
            "-y",
            target.location,
        ]
    return [*copy, "-f", "flv", target.location]


async def _spawn(binary: str, args: list[str], **pipes) -> asyncio.subprocess.Process:
    try:
        return await asyncio.create_subprocess_exec(binary, *args, **pipes)
    except FileNotFoundError as exc:
        raise OutputFailure(
            "ffmpeg was not found. Install it, or set KICKSTREAM_FFMPEG to its path."
        ) from exc
    except NotImplementedError as exc:
        # Windows starts processes only from its default event loop, which `--reload` replaces.
        raise OutputFailure("The pipeline cannot start ffmpeg when it is run with --reload.") from exc


async def _write(process: asyncio.subprocess.Process | None, data: bytes) -> None:
    stdin = process.stdin if process is not None else None
    if stdin is None or stdin.is_closing():
        return
    with contextlib.suppress(OSError):  # the process has gone; its exit is reported elsewhere
        stdin.write(data)
        await stdin.drain()


async def _end(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        with contextlib.suppress(ProcessLookupError):
            process.kill()
    await process.wait()


class FfmpegEncoder:
    def __init__(self, binary: str = "ffmpeg") -> None:
        self._binary = binary
        self._process: asyncio.subprocess.Process | None = None

    def available(self) -> str | None:
        if shutil.which(self._binary) is None:
            return "ffmpeg was not found. Install it, or set KICKSTREAM_FFMPEG to its path."
        return None

    async def start(self, quality: Quality) -> None:
        self._process = await _spawn(
            self._binary, encoder_args(quality), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE
        )

    async def write(self, data: bytes) -> None:
        await _write(self._process, data)

    async def output(self) -> AsyncIterator[bytes]:
        process = self._process
        if process is None or process.stdout is None:
            return
        carry = b""
        while data := await process.stdout.read(_READ):
            carry += data
            whole = len(carry) - len(carry) % _TS_PACKET
            if whole:
                yield carry[:whole]
                carry = carry[whole:]

    async def stop(self) -> None:
        process, self._process = self._process, None
        if process is not None:
            await _end(process)  # nothing to finish: what it has not yet produced is not wanted


class FfmpegSender:
    def __init__(self, binary: str = "ffmpeg", *, grace_s: float = 3.0) -> None:
        self._binary = binary
        self._grace_s = grace_s
        self._process: asyncio.subprocess.Process | None = None
        self._following: asyncio.Task | None = None
        self._last_words = ""

    async def start(self, target: Target, on_live: Callable[[], None]) -> None:
        if target.kind == "file":
            Path(target.location).parent.mkdir(parents=True, exist_ok=True)
        self._process = await _spawn(
            self._binary,
            sender_args(target),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,  # kept here and never logged: it can contain the key
        )
        self._following = asyncio.create_task(self._follow(self._process, on_live))

    async def _follow(self, process: asyncio.subprocess.Process, on_live: Callable[[], None]) -> None:
        async def progress() -> None:
            live = False
            async for line in process.stdout:
                for field in _PROGRESS:
                    amount = line[len(field) :].strip()
                    if not live and line.startswith(field) and amount.isdigit() and int(amount) > 0:
                        live = True
                        on_live()

        async def errors() -> None:
            async for line in process.stderr:
                text = line.decode("utf-8", "replace").strip()
                if text:
                    self._last_words = text

        await asyncio.gather(progress(), errors())

    async def write(self, data: bytes) -> None:
        await _write(self._process, data)

    async def wait(self) -> str:
        if self._process is not None:
            await self._process.wait()
        if self._following is not None:
            await asyncio.gather(self._following, return_exceptions=True)
        return self._last_words

    async def stop(self) -> None:
        process = self._process
        if process is None:
            return
        if process.stdin is not None and not process.stdin.is_closing():
            with contextlib.suppress(OSError):
                process.stdin.close()  # the end of its input: it finishes what it has and exits
        try:
            await asyncio.wait_for(process.wait(), self._grace_s)
        except TimeoutError:
            await _end(process)
