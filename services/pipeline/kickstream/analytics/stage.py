from kickstream.analytics.state import AnalyticsConfig, MatchState, apply
from kickstream.contracts import MatchEvent
from kickstream.ports.bus import EVENTS, INSIGHTS, EventBus


class AnalyticsStage:
    def __init__(self, bus: EventBus, cfg: AnalyticsConfig | None = None) -> None:
        self._bus = bus
        self._cfg = cfg or AnalyticsConfig()
        self._states: dict[str, MatchState] = {}
        self._events = bus.subscribe(EVENTS)

    async def run(self) -> None:
        async for message in self._events:
            if not isinstance(message.payload, MatchEvent):
                continue
            state = self._states.setdefault(message.match_id, MatchState(message.match_id))
            for insight in apply(state, message.payload, self._cfg):
                await self._bus.publish(INSIGHTS, message.match_id, insight)
