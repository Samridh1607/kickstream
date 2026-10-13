from kickstream.fans.service import FanService
from kickstream.ports.bus import INSIGHTS, STATUS, EventBus


class FanStage:
    """Tells the fan zone what is happening in the match, for a feed that reacts to it."""

    def __init__(self, bus: EventBus, service: FanService) -> None:
        self._service = service
        self._messages = bus.subscribe(STATUS, INSIGHTS)

    async def run(self) -> None:
        async for message in self._messages:
            self._service.observe_match(message.payload)
