import asyncio
import logging

from kickstream.contracts import MatchStatus
from kickstream.copilot.service import CopilotService
from kickstream.ports.bus import STATUS, EventBus

log = logging.getLogger(__name__)
# The last player report of a match is published just after the final whistle; wait for it.
SETTLE_S = 1.0


class CopilotStage:
    """Keeps each finished match, so later questions about records and head to head can be answered."""

    def __init__(self, bus: EventBus, service: CopilotService, settle_s: float = SETTLE_S) -> None:
        self._service = service
        self._settle_s = settle_s
        self._messages = bus.subscribe(STATUS)

    async def run(self) -> None:
        async for message in self._messages:
            payload = message.payload
            if isinstance(payload, MatchStatus) and payload.state == "finished":
                await asyncio.sleep(self._settle_s)
                try:
                    self._service.remember(message.match_id)
                except Exception:
                    log.exception("the finished match %s could not be remembered", message.match_id)
