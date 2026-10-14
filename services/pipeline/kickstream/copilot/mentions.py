"""Which agent a question is put to: named in the request, or tagged in the question with an @."""

import re
from collections.abc import Iterable
from typing import Literal, get_args

from kickstream.contracts import AgentSpec

AgentId = Literal[
    "event_interpreter",
    "tactical_analyst",
    "prediction",
    "explainability",
    "visualization",
    "player_tracking",
    "highlights",
]

# Short names people type, on top of each agent's id and name.
_SHORT: dict[str, tuple[str, ...]] = {
    "event_interpreter": ("events", "event", "interpreter", "plays"),
    "tactical_analyst": ("tactics", "tactical", "analyst", "tactic"),
    "prediction": ("predict", "predictions", "forecast", "odds"),
    "explainability": ("explain", "explainer", "why"),
    "visualization": ("visual", "visuals", "viz", "visualisation", "pitch"),
    "player_tracking": ("player", "players", "tracking", "tracker"),
    "highlights": ("highlight", "moments"),
}

# An @ at the start or after a space, so an e-mail address is not read as a tag. A second word is
# tried too, for "@Tactical Analyst".
_MENTION = re.compile(r"(?<!\S)@([^\W\d][\w-]*)(?:\s+([^\W\d][\w-]*))?", re.UNICODE)


def _key(text: str) -> str:
    return re.sub(r"[\s_-]+", "", text.lower())


class Mentions:
    """The agents a question can be put to, by id, by name and by a short name."""

    def __init__(self, agents: Iterable[AgentSpec]) -> None:
        self.agents: dict[str, AgentSpec] = {agent.id: agent for agent in agents}
        self._aliases: dict[str, str] = {}
        for agent_id in get_args(AgentId):
            known = self.agents.get(agent_id)
            for alias in (agent_id, *([known.name] if known else []), *_SHORT[agent_id]):
                self._aliases.setdefault(_key(alias), agent_id)

    def name(self, agent: AgentId) -> str:
        known = self.agents.get(agent)
        return known.name if known else agent.replace("_", " ").capitalize()

    def find(self, question: str) -> tuple[AgentId | None, str]:
        """The first agent tagged in a question, and the question with every agent tag taken out."""
        first: AgentId | None = None

        def strip(match: re.Match) -> str:
            nonlocal first
            word, following = match.group(1), match.group(2)
            if following and (agent := self._aliases.get(_key(word + following))):
                kept = ""
            elif agent := self._aliases.get(_key(word)):
                kept = f" {following}" if following else ""
            else:
                return match.group(0)
            first = first or agent
            return kept

        rest = _MENTION.sub(strip, question)
        return first, " ".join(rest.split())
