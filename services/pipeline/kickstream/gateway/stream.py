from collections.abc import AsyncIterator

from kickstream.contracts import Envelope, ViewerProfile
from kickstream.gateway.personalize import to_envelope
from kickstream.ports.broadcaster import Broadcaster
from kickstream.ports.store import MatchStore


async def stream_items(store: MatchStore, broadcaster: Broadcaster, match_id: str, profile: ViewerProfile,
                       after_id: int = 0) -> AsyncIterator[Envelope]:
    """Replay the match log after `after_id`, then follow it live.

    The live feed is opened before the replay is read, so an item published in between is
    seen twice rather than missed; the ID check drops the second copy.
    """
    feed = broadcaster.subscribe(match_id)
    try:
        last = after_id
        for item in store.read(match_id, after_id):
            last = item.id
            envelope = to_envelope(item, profile)
            if envelope is not None:
                yield envelope
        async for item in feed:
            if item.id <= last:
                continue
            last = item.id
            envelope = to_envelope(item, profile)
            if envelope is not None:
                yield envelope
    finally:
        feed.close()
