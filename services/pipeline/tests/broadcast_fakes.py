"""Stand-ins for the reel agents and the clip cutter, driven by the test."""

import asyncio
from pathlib import Path

from kickstream.ports.reels import ClipFailure, ReelBrief, ReelPick


class FakeProducer:
    name = "AI agents"

    def __init__(self, *, fails: Exception | None = None, stalls: bool = False) -> None:
        self.fails = fails
        self.stalls = stalls
        self.briefs: list[ReelBrief] = []

    async def produce(self, brief: ReelBrief) -> list[ReelPick]:
        self.briefs.append(brief)
        if self.stalls:
            await asyncio.Event().wait()
        if self.fails is not None:
            raise self.fails
        return [
            ReelPick(c.id, f"Agent {c.id}", f"Caption for {c.label}", ("#agent", "reel"))
            for c in brief.candidates[: brief.max_reels]
        ]


class FakeCutter:
    def __init__(self) -> None:
        self.missing: str | None = None
        self.fails_at: float | None = None  # a clip starting here fails
        self.cuts: list[tuple[Path, float, float, Path]] = []
        self.gate = asyncio.Event()
        self.gate.set()

    def available(self) -> str | None:
        return self.missing

    async def cut(self, source: Path, start_s: float, duration_s: float, out: Path) -> int:
        await self.gate.wait()
        self.cuts.append((source, start_s, duration_s, out))
        if self.fails_at == start_s:
            raise ClipFailure("ffmpeg could not cut the clip: broken")
        await asyncio.to_thread(_write_clip, out)
        return 4000


def _write_clip(out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(b"reel" * 1000)
