"""Auto-eventing: reads the MatchEvents a detector writes and publishes them onto the bus as they arrive.

The detector writes one JSON object per line in the MatchEvent shape, speed and pass fields included. It
leaves out id, match_id and seq; the reader numbers the events for the match it is following. The stages
downstream, the Event Interpreter first, cannot tell these events from the simulator's.

Write a sample feed from the simulated match: python -m kickstream.simulator.reader feed.jsonl
"""

import asyncio
import json
import sys
from collections.abc import AsyncIterable, AsyncIterator
from pathlib import Path

from pydantic import ValidationError

from kickstream.contracts import MatchEvent, MatchStatus, TeamSheet
from kickstream.ports.bus import EventBus
from kickstream.simulator.stage import Scoreboard

_NUMBERED = {"id", "match_id", "seq"}


class EventReader:
    """Follows one detector feed until its full_time event or the end of the feed."""

    def __init__(self, bus: EventBus, lines: AsyncIterable[str]) -> None:
        self._bus = bus
        self._lines = lines
        self._board: Scoreboard | None = None
        self.skipped = 0
        self.problem: str | None = None

    @property
    def status(self) -> MatchStatus | None:
        return self._board.status if self._board is not None else None

    async def follow(self, match_id: str, home: TeamSheet, away: TeamSheet) -> None:
        board = self._board = Scoreboard(self._bus, match_id, home, away, 1.0, source="detector")
        await board.publish_status("live", 0)
        seq = 0
        async for line in self._lines:
            if not line.strip():
                continue
            try:
                raw = {key: value for key, value in json.loads(line).items() if key not in _NUMBERED}
                event = MatchEvent.model_validate(
                    {**raw, "id": f"{match_id}-e{seq + 1}", "match_id": match_id, "seq": seq + 1}
                )
            except (ValueError, AttributeError, ValidationError):
                self.skipped += 1
                self.problem = f"{self.skipped} line(s) from the detector could not be read"
                continue
            seq += 1
            await board.publish(event)
            if event.type == "full_time":
                return


async def tail_lines(path: Path, poll_s: float = 0.5) -> AsyncIterator[str]:
    """Yields each complete line of a file as it is written, waiting at the end for more."""
    handle = await asyncio.to_thread(path.open, encoding="utf-8")
    try:
        partial = ""
        while True:
            chunk = await asyncio.to_thread(handle.readline)
            if not chunk:
                await asyncio.sleep(poll_s)
                continue
            partial += chunk
            if partial.endswith("\n"):
                yield partial
                partial = ""
    finally:
        handle.close()


def write_sample(path: Path) -> None:
    from kickstream.domain.demo import DEMO_SEED
    from kickstream.domain.teams import AWAY, HOME
    from kickstream.simulator.generate import generate

    lines = (
        event.model_dump_json(exclude=_NUMBERED, exclude_none=True)
        for event in generate("feed", DEMO_SEED, HOME, AWAY)
    )
    path.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")


if __name__ == "__main__":
    write_sample(Path(sys.argv[1] if len(sys.argv) > 1 else "feed.jsonl"))
