"""Ask Copilot: answers a question from the match, the matches before it, and the web when asked to."""

import asyncio
import logging
import time
import uuid
from collections.abc import Callable, Iterable

from kickstream.contracts import AgentSpec, CopilotAnswer, CopilotInfo, CopilotSource
from kickstream.copilot import answer as answering
from kickstream.copilot.mentions import AgentId, Mentions
from kickstream.copilot.view import MatchArchive, MatchView, read_match, summarize
from kickstream.domain.errors import Refusal
from kickstream.domain.types import Mode
from kickstream.ports.copilot import CopilotWriter, SearchFailure, SearchResult, Speaker, WebSearch
from kickstream.ports.store import MatchStore

log = logging.getLogger(__name__)
MAX_QUESTION = 300
MAX_SOURCES = 4
SEARCH_TIMEOUT_S = 12.0
WRITER_TIMEOUT_S = 20.0


class CopilotError(Refusal):
    """A question Ask Copilot refuses."""


class CopilotService:
    def __init__(
        self,
        store: MatchStore,
        archive: MatchArchive,
        *,
        current_match: Callable[[], str | None],
        match_exists: Callable[[str], bool],
        search: WebSearch | None = None,
        writer: CopilotWriter | None = None,
        agents: Iterable[AgentSpec] = (),
        max_model_calls: int = 40,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._store = store
        self._mentions = Mentions(agents)
        self._archive = archive
        self._current_match = current_match
        self._match_exists = match_exists
        self._search = search
        self._writer = writer
        self._max_model_calls = max_model_calls
        self._model_calls: dict[str, int] = {}
        self._now = now

    def info(self) -> CopilotInfo:
        return CopilotInfo(
            model=self._writer is not None,
            search=self._search.name if self._search else "",
            matches_remembered=len(self._archive.matches),
        )

    def remember(self, match_id: str) -> None:
        """Keep a finished match in the archive. Does nothing for one still being played."""
        if not self._match_exists(match_id):
            return
        record = summarize(read_match(self._store, match_id, "fan"), self._now())
        if record is not None:
            self._archive.remember(record)

    def _view(self, match_id: str | None, mode: Mode) -> MatchView | None:
        if match_id is None:
            match_id = self._current_match()
        elif not self._match_exists(match_id):
            raise CopilotError(404, "match_id", f"There is no match with the ID {match_id}.")
        if match_id is None:
            return None
        view = read_match(self._store, match_id, mode)
        if view.status is not None and view.status.state == "finished":
            self.remember(match_id)
        return view

    def _question(self, question: str, agent: AgentId | None) -> tuple[str, AgentId | None]:
        too_long = len(" ".join(question.split())) > MAX_QUESTION
        tagged, question = self._mentions.find(question)
        agent = agent or tagged
        if agent is not None and not question:
            question = f"What has the {self._mentions.name(agent)} found?"
        if too_long or not question:
            raise CopilotError(422, "question", f"A question must be 1 to {MAX_QUESTION} characters.")
        return question, agent

    def _draft(self, question: str, view: MatchView | None, agent: AgentId | None) -> answering.Draft:
        if agent is None:
            return answering.draft(question, view, self._archive)
        return answering.agent_draft(agent, question, view, self._archive)

    def from_facts(
        self, question: str, *, match_id: str | None = None, mode: Mode = "fan", agent: AgentId | None = None
    ) -> answering.Draft:
        """The answer from the match and the archive alone: no web search and no model."""
        question, agent = self._question(question, agent)
        return self._draft(question, self._view(match_id, mode), agent)

    async def ask(
        self,
        question: str,
        *,
        match_id: str | None = None,
        mode: Mode = "fan",
        web: bool = False,
        agent: AgentId | None = None,
    ) -> CopilotAnswer:
        question, agent = self._question(question, agent)
        view = self._view(match_id, mode)
        draft = self._draft(question, view, agent)

        results: list[SearchResult] = []
        problem = None
        searched = False
        # The web is asked only for what the match cannot answer: results for "who is the best
        # player so far?" would be about anything but this match.
        if web and not draft.placed:
            if self._search is None:
                problem = "Web search is not set up."
            else:
                searched = True
                try:
                    found = await asyncio.wait_for(
                        self._search.search(question, MAX_SOURCES), SEARCH_TIMEOUT_S
                    )
                    results = found[:MAX_SOURCES]
                except (SearchFailure, TimeoutError) as exc:
                    problem = str(exc) or "The web search did not answer in time."

        intent, text = draft.intent, draft.answer
        if not draft.placed and results:
            intent = "web"
            text = f"From {self._search.name}: {results[0].snippet}"
        elif not draft.placed and web and not results and problem is None:
            text = f"The web search found nothing for that. {answering.HELP}"

        source = "scripted"
        key = view.match_id if view else "none"
        asked = self._model_calls.get(key, 0)
        if self._writer is not None and (draft.facts or results) and asked < self._max_model_calls:
            self._model_calls[key] = asked + 1
            spec = self._mentions.agents.get(agent) if agent else None
            speaker = Speaker(spec.name, spec.description) if spec else None
            try:
                written = await asyncio.wait_for(
                    self._writer.write(question, draft.facts, results, speaker), WRITER_TIMEOUT_S
                )
                if written.strip():
                    text, source = written.strip(), "agent"
            except Exception as exc:  # noqa: BLE001 - every model failure falls back to the scripted answer
                log.warning("the copilot writer failed (%s); using the scripted answer", exc)

        return CopilotAnswer(
            id=uuid.uuid4().hex[:8],
            question=question,
            intent=intent,
            answer=text,
            cards=draft.cards,
            charts=draft.charts,
            sources=[CopilotSource(title=r.title, url=r.url, snippet=r.snippet) for r in results],
            followups=list(answering.FOLLOWUPS[intent]),
            source=source,
            searched=searched,
            problem=problem,
            agent=agent,
        )
