import logging

from kickstream.broadcasts.rules import BroadcastError
from kickstream.broadcasts.service import BroadcastService
from kickstream.ports.bus import INSIGHTS, NARRATIVES, STATUS, EventBus

log = logging.getLogger(__name__)


class BroadcastStage:
    """Gives the live broadcast the match's score, its key moments and their commentary."""

    def __init__(self, bus: EventBus, service: BroadcastService) -> None:
        self._service = service
        self._messages = bus.subscribe(STATUS, INSIGHTS, NARRATIVES)

    async def run(self) -> None:
        async for message in self._messages:
            try:
                self._service.observe_match(message.payload)
            except BroadcastError as exc:
                log.warning("the broadcast could not take in the match: %s", exc.message)
