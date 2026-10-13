"""The agents, in the order a payload is offered to them, and which of them are switched on."""

import logging

from kickstream.agents.base import Declared
from kickstream.agents.explain import ExplainabilityAgent
from kickstream.agents.highlights import HighlightsAgent
from kickstream.agents.interpreter import EventInterpreter
from kickstream.agents.prediction import PredictionAgent
from kickstream.agents.tactics import TacticalAnalyst
from kickstream.agents.tracking import PlayerTracker
from kickstream.agents.visualize import VisualizationAgent
from kickstream.contracts import AgentCatalog
from kickstream.domain.errors import Refusal
from kickstream.ports.output import RecordStore

log = logging.getLogger(__name__)

# An agent comes after every agent it listens to, so one pass down the list settles a payload.
DECLARED: tuple[Declared, ...] = (
    EventInterpreter.declared,
    TacticalAnalyst.declared,
    PredictionAgent.declared,
    PlayerTracker.declared,
    VisualizationAgent.declared,
    HighlightsAgent.declared,
    ExplainabilityAgent.declared,
)
AGENT_IDS = tuple(declared.id for declared in DECLARED)


class AgentError(Refusal):
    """A change to the agents that is refused."""


class AgentSwitches:
    """Which agents are switched off. Kept in a record, so a restart does not switch them back on."""

    def __init__(self, store: RecordStore | None = None) -> None:
        self._store = store
        saved = (store.load() if store else None) or {}
        off = saved.get("off", [])
        self._off = (
            {agent_id for agent_id in off if agent_id in AGENT_IDS} if isinstance(off, list) else set()
        )

    def enabled(self, agent_id: str) -> bool:
        return agent_id not in self._off

    def set(self, agent_id: str, enabled: bool) -> None:
        if agent_id not in AGENT_IDS:
            raise AgentError(404, "agent", f"There is no agent called {agent_id}.")
        changed = (self._off - {agent_id}) if enabled else (self._off | {agent_id})
        if self._store is not None:
            try:
                self._store.save({"off": sorted(changed)})
            except OSError as exc:
                raise AgentError(503, "agent", "The change could not be saved. Nothing was changed.") from exc
        self._off = changed

    def catalog(self, *, model: bool) -> AgentCatalog:
        return AgentCatalog(
            agents=[declared.spec(self.enabled(declared.id)) for declared in DECLARED], model=model
        )
