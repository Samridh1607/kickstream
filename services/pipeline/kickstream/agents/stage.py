"""The orchestrator: offers each match payload to the agents that listen for it, and publishes what they find."""

import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass

from pydantic import BaseModel

from kickstream.agents.base import MatchAgent
from kickstream.agents.explain import ExplainabilityAgent, ExplainService
from kickstream.agents.highlights import HighlightsAgent
from kickstream.agents.interpreter import EventInterpreter
from kickstream.agents.prediction import PredictionAgent
from kickstream.agents.registry import AgentSwitches
from kickstream.agents.squad import Squad
from kickstream.agents.tactics import TacticalAnalyst
from kickstream.agents.tracking import PlayerTracker
from kickstream.agents.visualize import VisualizationAgent
from kickstream.contracts import AgentRun, KeyMoment, MatchEvent, MatchStatus, PlayEvent, StatsSnapshot
from kickstream.domain.payloads import TYPE_NAMES
from kickstream.ports.bus import AGENTS, EVENTS, INSIGHTS, STATUS, EventBus
from kickstream.ports.explainer import ExplainContext

log = logging.getLogger(__name__)
REMEMBERED_MATCHES = 4
MAX_WAITING_EXPLANATIONS = 16


@dataclass
class _Tally:
    """What one agent did in one match minute."""

    trigger: str = ""
    produced: str = ""
    count: int = 0
    seconds: float = 0.0


class _Team:
    """The agents working on one match."""

    def __init__(self, status: MatchStatus) -> None:
        self.squad = Squad(status.home, status.away)
        names = {"home": status.home.name, "away": status.away.name}
        # In the registry's order: an agent comes after every agent it listens to.
        if status.detail == "key_events":
            # Without positions the Tactical Analyst and the Visualization Agent would only invent.
            self.agents: list[MatchAgent] = [
                EventInterpreter(),
                PredictionAgent(),
                PlayerTracker(self.squad),
                HighlightsAgent(self.squad),
            ]
        else:
            self.agents = [
                EventInterpreter(),
                TacticalAnalyst(names),
                PredictionAgent(),
                PlayerTracker(self.squad),
                VisualizationAgent(self.squad),
                HighlightsAgent(self.squad),
            ]
        self.tactics = next((agent for agent in self.agents if isinstance(agent, TacticalAnalyst)), None)
        self.explainability = ExplainabilityAgent(names)
        self.minute = 0
        self.tallies: dict[str, _Tally] = {}
        self.explained = 0


class AgentsStage:
    def __init__(self, bus: EventBus, switches: AgentSwitches, explainer: ExplainService) -> None:
        self._bus = bus
        self._switches = switches
        self._explainer = explainer
        self._messages = bus.subscribe(STATUS, EVENTS, INSIGHTS)
        self._teams: dict[str, _Team] = {}
        self._waiting: asyncio.Queue[tuple[str, ExplainContext]] = asyncio.Queue(MAX_WAITING_EXPLANATIONS)

    async def run(self) -> None:
        worker = asyncio.create_task(self._explain())
        try:
            async for message in self._messages:
                try:
                    await self.take(message.match_id, message.payload)
                except Exception:
                    log.exception("the agents could not take in a %s", type(message.payload).__name__)
        finally:
            worker.cancel()

    async def settle(self) -> None:
        """Returns once every explanation asked for so far has been written."""
        await self._waiting.join()

    async def take(self, match_id: str, payload: BaseModel) -> None:
        if isinstance(payload, MatchStatus):
            if match_id not in self._teams:
                while len(self._teams) >= REMEMBERED_MATCHES:
                    del self._teams[next(iter(self._teams))]
                self._teams[match_id] = _Team(payload)
            else:
                self._teams[match_id].squad.refresh(payload.home, payload.away)
            if payload.state in ("finished", "abandoned"):
                await self._report(match_id, self._teams[match_id])
            return
        team = self._teams.get(match_id)
        if team is not None and team.tactics is not None and isinstance(payload, StatsSnapshot):
            team.tactics.momentum = payload.momentum
        if team is None or not isinstance(payload, (MatchEvent, KeyMoment)):
            return
        if payload.minute > team.minute:
            await self._report(match_id, team)
            team.minute = payload.minute

        pending: deque[BaseModel] = deque([payload])
        while pending:
            item = pending.popleft()
            if isinstance(item, PlayEvent):
                team.squad.apply(item)
            for agent in team.agents:
                declared = agent.declared
                if not isinstance(item, agent.accepts) or not self._switches.enabled(declared.id):
                    continue
                started = time.perf_counter()
                found = agent.handle(item)
                tally = team.tallies.setdefault(declared.id, _Tally())
                tally.seconds += time.perf_counter() - started
                tally.trigger = TYPE_NAMES[type(item)]
                for output in found:
                    tally.count += 1
                    tally.produced = TYPE_NAMES[type(output)]
                    await self._bus.publish(AGENTS, match_id, output)
                    pending.append(output)
            explainability = team.explainability
            if isinstance(item, explainability.accepts) and self._switches.enabled(
                explainability.declared.id
            ):
                for ctx in explainability.consider(item):
                    try:
                        self._waiting.put_nowait((match_id, ctx))
                    except asyncio.QueueFull:
                        log.warning("too many explanations are waiting; skipping %s", ctx.topic)

    async def _report(self, match_id: str, team: _Team) -> None:
        """One run per agent for the minute just played, so the trace stays readable."""
        tallies, team.tallies = team.tallies, {}
        for agent in team.agents:
            tally = tallies.get(agent.declared.id)
            if tally is None or tally.count == 0:
                continue
            await self._bus.publish(
                AGENTS,
                match_id,
                AgentRun(
                    id=f"{match_id}-run-{agent.declared.id}-{team.minute}",
                    match_id=match_id,
                    minute=team.minute,
                    agent=agent.declared.id,
                    trigger=tally.trigger,
                    produced=tally.produced,
                    count=tally.count,
                    duration_ms=round(tally.seconds * 1000, 3),
                    source="scripted",
                    note=agent.note,
                ),
            )

    async def _explain(self) -> None:
        while True:
            match_id, ctx = await self._waiting.get()
            try:
                started = time.perf_counter()
                explanations = await self._explainer.explain(match_id, ctx)
                for explanation in explanations:
                    await self._bus.publish(AGENTS, match_id, explanation)
                team = self._teams.get(match_id)
                if team is not None and explanations:
                    team.explained += 1
                    await self._bus.publish(
                        AGENTS,
                        match_id,
                        AgentRun(
                            id=f"{match_id}-run-explainability-n{team.explained}",
                            match_id=match_id,
                            minute=ctx.minute,
                            agent="explainability",
                            trigger=ctx.kind,
                            produced="explanation",
                            count=len(explanations),
                            duration_ms=round((time.perf_counter() - started) * 1000, 3),
                            source=explanations[0].source,
                            note=explanations[0].headline,
                        ),
                    )
            except Exception:
                log.exception("an explanation could not be written for %s", ctx.topic)
            finally:
                self._waiting.task_done()
