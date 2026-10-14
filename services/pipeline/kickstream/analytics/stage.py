from kickstream.analytics.state import AnalyticsConfig, MatchState, apply
from kickstream.contracts import MatchEvent, MatchStatus
from kickstream.ports.bus import EVENTS, INSIGHTS, STATUS, EventBus


class AnalyticsStage:
    def __init__(self, bus: EventBus, cfg: AnalyticsConfig | None = None) -> None:
        self._bus = bus
        self._cfg = cfg or AnalyticsConfig()
        self._states: dict[str, MatchState] = {}
        self._details: dict[str, str] = {}
        self._messages = bus.subscribe(STATUS, EVENTS)

    async def run(self) -> None:
        async for message in self._messages:
            payload = message.payload
            if isinstance(payload, MatchStatus):
                self._details[message.match_id] = payload.detail or "full"
                continue
            if not isinstance(payload, MatchEvent):
                continue
            state = self._states.setdefault(message.match_id, MatchState(message.match_id))
            full = self._details.get(message.match_id, "full") == "full"
            for insight in apply(state, payload, self._cfg, snapshots=full):
                await self._bus.publish(INSIGHTS, message.match_id, insight)
