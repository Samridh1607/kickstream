import logging

from pydantic import BaseModel

from kickstream.contracts import (
    KeyMoment,
    MatchEvent,
    MatchStatus,
    Narrative,
    Overlay,
    PressureSnapshot,
    Recap,
    StatsSnapshot,
)
from kickstream.ports.broadcaster import Broadcaster
from kickstream.ports.bus import EVENTS, INSIGHTS, NARRATIVES, OVERLAYS, STATUS, EventBus
from kickstream.ports.store import LogItem, MatchStore

log = logging.getLogger(__name__)

_TYPES: dict[type, str] = {
    MatchStatus: "match_status",
    MatchEvent: "match_event",
    StatsSnapshot: "stats",
    PressureSnapshot: "pressure",
    KeyMoment: "key_moment",
    Narrative: "narrative",
    Recap: "recap",
    Overlay: "overlay",
}


class Recorder:
    """Writes everything the pipeline publishes into the match log and fans it out."""

    def __init__(self, bus: EventBus, store: MatchStore, broadcaster: Broadcaster) -> None:
        self._store = store
        self._broadcaster = broadcaster
        self._messages = bus.subscribe(STATUS, EVENTS, INSIGHTS, NARRATIVES, OVERLAYS)
        self._team_ids: dict[str, dict[str, str]] = {}

    def record(self, match_id: str, payload: BaseModel) -> LogItem | None:
        item_type = _TYPES.get(type(payload))
        if item_type is None:
            log.warning("not recording unknown payload type %s", type(payload).__name__)
            return None
        if isinstance(payload, MatchStatus):
            self._team_ids[match_id] = {"home": payload.home.id, "away": payload.away.id}
        side = getattr(payload, "team", None)
        item = self._store.append(
            match_id,
            item_type,
            payload.minute,
            payload,
            language=getattr(payload, "language", None),
            mode=getattr(payload, "mode", None),
            team_id=self._team_ids.get(match_id, {}).get(side),
            player_id=getattr(payload, "player_id", None),
        )
        self._broadcaster.publish(item)
        return item

    async def run(self) -> None:
        async for message in self._messages:
            self.record(message.match_id, message.payload)
