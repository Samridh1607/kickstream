from kickstream.audience.context import MatchTracker
from kickstream.ports.bus import INSIGHTS, NARRATIVES, STATUS, EventBus


class AudienceStage:
    """Feeds the match tracker, so the expert always has the current match to draw on."""

    def __init__(self, bus: EventBus, tracker: MatchTracker) -> None:
        self._tracker = tracker
        self._messages = bus.subscribe(STATUS, INSIGHTS, NARRATIVES)

    async def run(self) -> None:
        async for message in self._messages:
            self._tracker.observe(message.match_id, message.payload)
