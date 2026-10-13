from collections.abc import AsyncIterator

from kickstream.contracts import Envelope, ViewerProfile
from kickstream.gateway.personalize import to_envelope
from kickstream.ports.broadcaster import Broadcaster
from kickstream.ports.store import MatchStore

# Only the newest of these is of use to a page that has just arrived, and they are most of a match's
# log by size. A replay sends the newest of each and leaves out the ones it replaced.
LATEST_ONLY = frozenset({"pitch_scene", "players"})


def _replayed(items: list) -> list:
    newest = {item.type: item.id for item in items if item.type in LATEST_ONLY}
    return [item for item in items if item.type not in LATEST_ONLY or newest[item.type] == item.id]


async def stream_items(
    store: MatchStore, broadcaster: Broadcaster, match_id: str, profile: ViewerProfile, after_id: int = 0
) -> AsyncIterator[Envelope]:
    """Replay the match log after `after_id`, then follow it live.

    The live feed is opened before the replay is read, so an item published in between is
    seen twice rather than missed; the ID check drops the second copy.
    """
    feed = broadcaster.subscribe(match_id)
    try:
        if after_id > len(store.read(match_id)):
            # An ID this log has not reached cannot have come from it. Replay everything
            # rather than stay silent until the log catches up.
            after_id = 0
        last = after_id
        waiting = store.read(match_id, after_id)
        for item in _replayed(waiting):
            last = item.id
            envelope = to_envelope(item, profile)
            if envelope is not None:
                yield envelope
        if waiting:
            last = waiting[-1].id
        async for item in feed:
            if item.id <= last:
                continue
            last = item.id
            envelope = to_envelope(item, profile)
            if envelope is not None:
                yield envelope
    finally:
        feed.close()
