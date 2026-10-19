"""Ask Copilot's answers as MCP tools, for any agent or assistant that speaks the Model Context Protocol.

Each tool is one of Ask Copilot's answers from match facts: the same drafts the chat pane shows, with the
facts each rests on. The caller brings its own model; nothing here calls one or searches the web. Every
tool only reads.
"""

from collections.abc import Iterable

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from pydantic import BaseModel

from kickstream.contracts import CopilotCard
from kickstream.copilot.mentions import AgentId
from kickstream.copilot.service import CopilotError, CopilotService
from kickstream.domain.types import Mode

PATH = "/mcp"
_READ_ONLY = ToolAnnotations(readOnlyHint=True, idempotentHint=True, openWorldHint=False)
_INSTRUCTIONS = (
    "Kickstream follows one football match at a time and remembers the matches before it. These tools answer "
    "from what its match agents recorded: the score and stats, the forecast, tactics, players, highlights and "
    "the play history. Leave match_id out for the match playing now. Each answer lists the facts it rests on; "
    "state nothing beyond them."
)


class FactAnswer(BaseModel):
    intent: str
    answer: str
    facts: list[str]
    cards: list[CopilotCard]


def build_mcp(copilot: CopilotService, *, hosts: Iterable[str] = ()) -> FastMCP:
    names = ["127.0.0.1", "localhost", "[::1]", *hosts]
    allowed = [*names, *(f"{name}:*" for name in names)]
    server = FastMCP(
        "kickstream",
        instructions=_INSTRUCTIONS,
        streamable_http_path=PATH,
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True, allowed_hosts=allowed
        ),
    )

    def answer(question: str, match_id: str | None, mode: Mode, agent: AgentId | None = None) -> FactAnswer:
        try:
            draft = copilot.from_facts(question, match_id=match_id, mode=mode, agent=agent)
        except CopilotError as exc:
            raise ToolError(exc.message) from exc
        return FactAnswer(intent=draft.intent, answer=draft.answer, facts=draft.facts, cards=draft.cards)

    @server.tool(annotations=_READ_ONLY)
    def ask_copilot(question: str, match_id: str | None = None, mode: Mode = "fan") -> FactAnswer:
        """Ask Copilot anything about the match or the matches before it. Tag an agent with @, e.g. @tactics."""
        return answer(question, match_id, mode)

    @server.tool(annotations=_READ_ONLY)
    def match_state(match_id: str | None = None, mode: Mode = "fan") -> FactAnswer:
        """The score, the clock and both sides' numbers."""
        return answer("What is the score and how are the stats?", match_id, mode)

    @server.tool(annotations=_READ_ONLY)
    def win_prediction(match_id: str | None = None, mode: Mode = "fan") -> FactAnswer:
        """The Prediction Agent's chances of a home win, a draw and an away win, and the next goal."""
        return answer("Who will win from here?", match_id, mode, "prediction")

    @server.tool(annotations=_READ_ONLY)
    def tactics(match_id: str | None = None, mode: Mode = "fan") -> FactAnswer:
        """The Tactical Analyst's patterns, pressure, rhythm and who is in control."""
        return answer("What are the tactics?", match_id, mode, "tactical_analyst")

    @server.tool(annotations=_READ_ONLY)
    def player_report(player: str, match_id: str | None = None, mode: Mode = "fan") -> FactAnswer:
        """The Player Tracking Agent's numbers for one player, by name, and their record in earlier matches."""
        return answer(f"Tell me about {player}", match_id, mode, "player_tracking")

    @server.tool(annotations=_READ_ONLY)
    def head_to_head(match_id: str | None = None, mode: Mode = "fan") -> FactAnswer:
        """The two clubs' results against each other in the matches on record."""
        return answer("Show me the head to head", match_id, mode)

    @server.tool(annotations=_READ_ONLY)
    def highlight(
        question: str = "Show the last goal's play card", match_id: str | None = None
    ) -> FactAnswer:
        """A play card from the Highlights Agent: a goal, a big chance or a hidden highlight, as asked."""
        return answer(question, match_id, "fan", "highlights")

    @server.tool(annotations=_READ_ONLY)
    def play_history(player: str | None = None, match_id: str | None = None) -> FactAnswer:
        """The match's key moments, or one player's plays when a player is named."""
        question = f"{player} play history" if player else "Show the play history"
        return answer(question, match_id, "fan", "event_interpreter")

    @server.tool(annotations=_READ_ONLY)
    def why_it_matters(match_id: str | None = None, mode: Mode = "fan") -> FactAnswer:
        """The Explainability Agent's latest explanations of why a finding matters."""
        return answer("Why does it matter?", match_id, mode, "explainability")

    @server.tool(annotations=_READ_ONLY)
    def where_play_is(match_id: str | None = None, mode: Mode = "fan") -> FactAnswer:
        """The Visualization Agent's read of where play is happening, by third and by flank."""
        return answer("Where is play happening?", match_id, mode, "visualization")

    return server
