import logging

from kickstream.contracts import KeyMoment, MatchStatus, Narrative
from kickstream.ports.bus import INSIGHTS, NARRATIVES, STATUS, EventBus
from kickstream.studio import rules
from kickstream.studio.rules import StudioError
from kickstream.studio.service import StudioService

log = logging.getLogger(__name__)
_BANNER_KIND = {"goal": "goal", "red_card": "card"}
_REMEMBERED_MOMENTS = 2000


class StudioStage:
    """Feeds the studio from the match: automatic banners and the half-time break."""

    def __init__(self, bus: EventBus, service: StudioService) -> None:
        self._service = service
        self._messages = bus.subscribe(STATUS, INSIGHTS, NARRATIVES)
        self._kinds: dict[str, str] = {}
        self._half_times: set[str] = set()

    async def run(self) -> None:
        async for message in self._messages:
            try:
                await self._handle(message.match_id, message.payload)
            except StudioError as exc:
                log.warning("studio ignored a match message: %s", exc.message)

    async def _handle(self, match_id: str, payload) -> None:
        settings = self._service.settings
        if isinstance(payload, KeyMoment):
            if len(self._kinds) >= _REMEMBERED_MOMENTS:
                self._kinds.clear()
            self._kinds[payload.id] = payload.kind
        elif isinstance(payload, Narrative):
            kind = _BANNER_KIND.get(self._kinds.get(payload.moment_id, ""))
            in_program_variant = (payload.mode, payload.language) == (settings.mode, settings.language)
            if kind and settings.auto_banner and in_program_variant:
                await self._service.banner(payload.text[:200], kind, rules.DEFAULT_BANNER_SECONDS, source_id=payload.id)
        elif isinstance(payload, MatchStatus) and payload.state == "half_time":
            if settings.auto_half_time_break and match_id not in self._half_times:
                self._half_times.add(match_id)
                await self._service.take_break(rules.HALF_TIME_BREAK_MINUTES)
