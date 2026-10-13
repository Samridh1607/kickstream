"""Explanations written by a Microsoft Agent Framework agent, from the facts a match agent found."""

from agent_framework import Agent
from agent_framework.openai import OpenAIChatCompletionClient

from kickstream.adapters.agent_writer import parse_json
from kickstream.domain.types import MODES, Mode
from kickstream.ports.explainer import ExplainContext, ExplainError, WrittenExplanation

EXPLAINABILITY = "explainability"

_INSTRUCTIONS = (
    "[role:explainability] You explain to football viewers why something an analysis found matters. The user "
    "gives the finding and its facts. Write it twice: for a fan, in plain and vivid words with no jargon; and "
    "for an analyst, citing the numbers. Each has a headline of at most 60 characters and one or two sentences "
    "on why it matters. Use only the facts given; do not invent names, numbers or events. Write in English. "
    'Reply with JSON only, in exactly this shape: {"fan": {"headline": "...", "why": "..."}, '
    '"analyst": {"headline": "...", "why": "..."}}.'
)


def explain_prompt(ctx: ExplainContext) -> str:
    lines = [
        f"Match: {ctx.home} vs {ctx.away}",
        f"Minute: {ctx.minute}",
        f"Finding: {ctx.topic.replace(':', ', ').replace('_', ' ')}",
        f"Team: {ctx.team or 'not applicable'}",
        "Facts:",
    ]
    lines += [f"- {label}: {value}" for label, value in ctx.facts]
    return "\n".join(lines)


class AgentExplainer:
    def __init__(self, base_url: str, model: str, api_key: str) -> None:
        self.model = model
        self._base_url = base_url
        self._api_key = api_key

    async def explain(self, ctx: ExplainContext) -> dict[Mode, WrittenExplanation]:
        client = OpenAIChatCompletionClient(model=self.model, base_url=self._base_url, api_key=self._api_key)
        agent = Agent(client=client, name=EXPLAINABILITY, instructions=_INSTRUCTIONS)
        response = await agent.run(explain_prompt(ctx))
        try:
            raw = parse_json(response.text or "")
        except Exception as exc:  # noqa: BLE001 - the writer's parse error is this port's error
            raise ExplainError(str(exc)) from exc
        written = {}
        for mode in MODES:
            item = raw.get(mode)
            if not isinstance(item, dict):
                raise ExplainError(f"the model omitted the {mode} wording")
            headline, why = item.get("headline"), item.get("why")
            if not isinstance(headline, str) or not isinstance(why, str):
                raise ExplainError(f"the {mode} wording has the wrong shape")
            written[mode] = WrittenExplanation(headline[:80], why, EXPLAINABILITY)
        return written
