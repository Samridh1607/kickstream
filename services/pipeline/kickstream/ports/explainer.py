from dataclasses import dataclass
from typing import Literal, Protocol

from kickstream.domain.types import Mode, Side


class ExplainError(Exception):
    """An explainer could not produce a complete, well-formed result."""


@dataclass(frozen=True)
class ExplainContext:
    """One thing an agent found, with every fact an explainer may use. Nothing else may be stated."""

    subject_id: str
    kind: Literal["tactics", "prediction", "highlight"]
    # What kind of finding it is, such as "pattern:high_press". The scripted explainer writes from it.
    topic: str
    minute: int
    home: str
    away: str
    side: Side | None
    facts: tuple[tuple[str, str], ...]
    evidence: tuple[str, ...]

    @property
    def team(self) -> str | None:
        return None if self.side is None else (self.home if self.side == "home" else self.away)

    def fact(self, label: str, default: str = "") -> str:
        return next((value for name, value in self.facts if name == label), default)


@dataclass(frozen=True)
class WrittenExplanation:
    headline: str
    why: str
    agent: str


class Explainer(Protocol):
    """Says why a finding matters, once for fans and once for analysts."""

    model: str

    async def explain(self, ctx: ExplainContext) -> dict[Mode, WrittenExplanation]: ...
