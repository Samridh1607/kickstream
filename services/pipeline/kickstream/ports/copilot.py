"""What Ask Copilot needs from outside: a web search, and optionally a model to word its answers."""

from dataclasses import dataclass
from typing import Protocol


class SearchFailure(Exception):
    """The web could not be searched. The message is written for the person asking."""


@dataclass(frozen=True)
class SearchResult:
    title: str
    url: str
    snippet: str


class WebSearch(Protocol):
    name: str  # shown to the person asking, so they know where an answer came from

    async def search(self, query: str, limit: int) -> list[SearchResult]:
        """The best results for the query, best first. Raises SearchFailure."""


class WriterFailure(Exception):
    """A writer could not produce a usable answer."""


@dataclass(frozen=True)
class Speaker:
    """The agent a question was put to, which the answer is written as."""

    name: str
    description: str


class CopilotWriter(Protocol):
    """Words an answer from the facts found for a question. It may use nothing else."""

    model: str

    async def write(
        self, question: str, facts: list[str], sources: list[SearchResult], speaker: Speaker | None = None
    ) -> str: ...
