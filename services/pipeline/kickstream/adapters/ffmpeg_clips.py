"""Vertical clips cut from a recording by ffmpeg, ready for Shorts, Reels and TikTok."""

import asyncio
import contextlib
import shutil
from pathlib import Path

from kickstream.ports.reels import ClipFailure

WIDTH, HEIGHT, FPS = 1080, 1920, 30
# The whole program picture across the width, over a blurred, darkened fill of itself.
_GRAPH = (
    "[0:v]split=2[fill][front];"
    f"[fill]scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,crop={WIDTH}:{HEIGHT},"
    "boxblur=24:2,eq=brightness=-0.1[back];"
    f"[front]scale={WIDTH}:-2[picture];"
    f"[back][picture]overlay=(W-w)/2:(H-h)/2,fps={FPS},format=yuv420p[v]"
)


def clip_args(source: Path, start_s: float, duration_s: float, out: Path) -> list[str]:
    return [
        "-hide_banner", "-loglevel", "error", "-nostats",
        "-ss", f"{start_s:.2f}", "-i", str(source), "-t", f"{duration_s:.2f}",
        "-filter_complex", _GRAPH, "-map", "[v]", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
        # The index up front, so a reel starts playing before it has fully downloaded.
        "-movflags", "+faststart",
        "-f", "mp4", "-y", str(out),
    ]  # fmt: skip


class FfmpegClipCutter:
    def __init__(self, binary: str = "ffmpeg", *, timeout_s: float = 180.0) -> None:
        self._binary = binary
        self._timeout_s = timeout_s

    def available(self) -> str | None:
        if shutil.which(self._binary) is None:
            return "ffmpeg was not found. Install it, or set KICKSTREAM_FFMPEG to its path."
        return None

    async def cut(self, source: Path, start_s: float, duration_s: float, out: Path) -> int:
        partial = await asyncio.to_thread(_prepare, source, out)
        try:
            process = await asyncio.create_subprocess_exec(
                self._binary,
                *clip_args(source, start_s, duration_s, partial),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise ClipFailure(
                "ffmpeg was not found. Install it, or set KICKSTREAM_FFMPEG to its path."
            ) from exc
        except NotImplementedError as exc:
            raise ClipFailure("The pipeline cannot start ffmpeg when it is run with --reload.") from exc
        try:
            _, errors = await asyncio.wait_for(process.communicate(), self._timeout_s)
        except (TimeoutError, asyncio.CancelledError) as exc:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()
            await asyncio.to_thread(partial.unlink, missing_ok=True)
            if isinstance(exc, TimeoutError):
                raise ClipFailure("Cutting the clip took too long.") from exc
            raise
        if process.returncode != 0:
            await asyncio.to_thread(partial.unlink, missing_ok=True)
            last = errors.decode("utf-8", "replace").strip().splitlines()
            raise ClipFailure(f"ffmpeg could not cut the clip: {last[-1] if last else 'no reason given'}")
        return await asyncio.to_thread(_keep, partial, out)


def _prepare(source: Path, out: Path) -> Path:
    """Where ffmpeg writes until the clip is whole."""
    if not source.is_file():
        raise ClipFailure("The recording is no longer on this computer.")
    out.parent.mkdir(parents=True, exist_ok=True)
    return out.with_name(out.stem + ".part.mp4")


def _keep(partial: Path, out: Path) -> int:
    size = partial.stat().st_size if partial.exists() else 0
    if size == 0:
        partial.unlink(missing_ok=True)
        raise ClipFailure("The clip came out empty.")
    partial.replace(out)
    return size
