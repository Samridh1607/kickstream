"""What every match agent declares about itself, in the manner of a Copilot Studio agent."""

from dataclasses import dataclass
from typing import ClassVar, Protocol

from pydantic import BaseModel

from kickstream.contracts import AgentSpec, AgentTool

POSSESSION = frozenset({"pass", "shot", "goal", "corner"})  # events of the side that has the ball
HALF_LIFE_S = 300.0  # how fast a zone's danger fades


@dataclass(frozen=True)
class Declared:
    id: str
    name: str
    description: str
    instructions: str
    triggers: tuple[str, ...]
    tools: tuple[tuple[str, str], ...]
    outputs: tuple[str, ...]
    upstream: tuple[str, ...] = ()

    def spec(self, enabled: bool) -> AgentSpec:
        return AgentSpec(
            id=self.id,
            name=self.name,
            description=self.description,
            instructions=self.instructions,
            triggers=list(self.triggers),
            tools=[AgentTool(name=name, description=description) for name, description in self.tools],
            outputs=list(self.outputs),
            upstream=list(self.upstream),
            enabled=enabled,
        )


class MatchAgent(Protocol):
    """One agent working on one match. `handle` is given each payload of a type it accepts."""

    declared: ClassVar[Declared]
    accepts: ClassVar[tuple[type, ...]]
    note: str  # what it last did, in a few words, for the activity trace

    def handle(self, payload: BaseModel) -> list[BaseModel]: ...


def clock(minute: int, second: int) -> int:
    return minute * 60 + second


def fade(values: list[float], seconds: float) -> list[float]:
    factor = 0.5 ** (max(0.0, seconds) / HALF_LIFE_S)
    return [value * factor for value in values]
