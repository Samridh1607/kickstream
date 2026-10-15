import logging

from kickstream.autolive.facts import MatchFacts
from kickstream.ports.bus import AGENTS, INSIGHTS, NARRATIVES, STATUS, EventBus

log = logging.getLogger(__name__)


class AutoLiveStage:
    """Keeps auto live's facts about the current match up to date, for its commentary."""

    def __init__(self, bus: EventBus, facts: MatchFacts) -> None:
        self._facts = facts
        self._messages = bus.subscribe(STATUS, INSIGHTS, AGENTS, NARRATIVES)

    async def run(self) -> None:
        async for message in self._messages:
            try:
                self._facts.take(message.match_id, message.payload)
            except Exception:
                log.exception("auto live could not take in a %s", type(message.payload).__name__)
