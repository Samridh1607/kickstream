import logging

from kickstream.contracts import (KeyMoment, MatchStatus, Narrative, Overlay, PressureSnapshot, Recap,
                                  StatsSnapshot)
from kickstream.domain.types import LANGUAGES
from kickstream.overlay.build import lower_third, pressure_map, recap_card, stat_card
from kickstream.ports.bus import INSIGHTS, NARRATIVES, OVERLAYS, STATUS, EventBus

log = logging.getLogger(__name__)


class OverlayStage:
    def __init__(self, bus: EventBus, stat_card_every_min: int = 5) -> None:
        self._bus = bus
        self._every = stat_card_every_min
        self._messages = bus.subscribe(STATUS, INSIGHTS, NARRATIVES)
        self._count: dict[str, int] = {}
        self._moments: dict[str, KeyMoment] = {}
        self._team_names: dict[str, dict[str, str]] = {}

    def _next_id(self, match_id: str) -> str:
        self._count[match_id] = self._count.get(match_id, 0) + 1
        return f"{match_id}-o{self._count[match_id]}"

    def _build(self, match_id: str, payload) -> list[Overlay]:
        if isinstance(payload, MatchStatus):
            self._team_names[match_id] = {"home": payload.home.name, "away": payload.away.name}
        elif isinstance(payload, KeyMoment):
            self._moments[payload.id] = payload
        elif isinstance(payload, StatsSnapshot):
            if payload.period_end or payload.minute % self._every == 0:
                return [stat_card(self._next_id(match_id), payload, language) for language in LANGUAGES]
        elif isinstance(payload, PressureSnapshot):
            return [pressure_map(self._next_id(match_id), payload)]
        elif isinstance(payload, Narrative) and payload.mode == "fan":
            moment = self._moments.get(payload.moment_id)
            if moment is None:
                log.warning("no key moment %s for narrative %s; skipping lower third", payload.moment_id, payload.id)
                return []
            team = self._team_names.get(match_id, {}).get(moment.team, moment.team)
            return [lower_third(self._next_id(match_id), payload, moment, team)]
        elif isinstance(payload, Recap) and payload.mode == "fan":
            return [recap_card(self._next_id(match_id), payload)]
        return []

    async def run(self) -> None:
        async for message in self._messages:
            for overlay in self._build(message.match_id, message.payload):
                await self._bus.publish(OVERLAYS, message.match_id, overlay)
