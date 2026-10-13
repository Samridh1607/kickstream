"""Stand-ins for the people stage's neighbours: its saved file and the broadcasts."""

import asyncio
import json

from kickstream.contracts import Broadcast, Broadcasts, BroadcastStats


def broadcast(state="ready", id_="b1", title="Derby day") -> Broadcast:
    return Broadcast(
        id=id_,
        title=title,
        description="",
        record=False,
        state=state,
        created_at=1_000.0,
        sessions=[],
        recordings=[],
        moments=[],
        stats=BroadcastStats(live_s=0.0),
        reels=[],
        generating=False,
    )


class MemoryRecords:
    """A record store in memory. Saving goes through JSON, as the real file does."""

    def __init__(self, record: dict | None = None) -> None:
        self.record = record
        self.aside = False
        self.fails = False

    def load(self) -> dict | None:
        return self.record

    def save(self, record: dict) -> None:
        if self.fails:
            raise OSError("the disk is full")
        self.record = json.loads(json.dumps(record))

    def set_aside(self) -> None:
        self.aside = True
        self.record = None


class FakeBroadcasts:
    """The broadcasts as the people service sees them: look one up, and follow their changes."""

    def __init__(self, *broadcasts: Broadcast) -> None:
        self.items = {item.id: item for item in broadcasts}
        self._changed: asyncio.Queue[Broadcasts] = asyncio.Queue()

    def find(self, broadcast_id: str) -> Broadcast | None:
        return self.items.get(broadcast_id)

    def doc(self) -> Broadcasts:
        return Broadcasts(
            revision=0, server_time=0.0, broadcasts=list(self.items.values()), current_id=None, ai=False
        )

    def set(self, changed: Broadcast) -> None:
        self.items[changed.id] = changed
        self._changed.put_nowait(self.doc())

    def delete(self, broadcast_id: str) -> None:
        del self.items[broadcast_id]
        self._changed.put_nowait(self.doc())

    async def changes(self):
        yield self.doc()
        while True:
            yield await self._changed.get()
