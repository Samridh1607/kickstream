"""Auto live commentary written by a Microsoft Agent Framework agent, from the facts on screen."""

from agent_framework import Agent
from agent_framework.openai import OpenAIChatCompletionClient

from kickstream.ports.commentary import CommentaryContext, CommentaryError

COMMENTATOR = "auto-commentator"
MAX_CHARS = 420

_INSTRUCTIONS = (
    "[role:auto-commentator] You are the voice of a 24/7 football live stream. The user names the screen now on "
    "air and gives its facts. Speak two or three short sentences, at most 60 words, as a lively TV commentator "
    "would: introduce what viewers are looking at when the screen has just arrived, or add something new about it "
    "when it has been on air a while. Use only the facts given; never invent names, numbers or events. If there is "
    "no match, talk about what the screen shows. Plain English, no lists, no emoji, no hashtags. Reply with the "
    "spoken text only."
)


def commentary_prompt(ctx: CommentaryContext) -> str:
    lines = [
        f"Screen: {ctx.scene}",
        f"About the screen: {ctx.blurb}",
        f"Agent shown: {ctx.agent or 'none'}",
        "The screen has just arrived." if ctx.opening else "The screen has been on air a while.",
        "Facts:",
    ]
    lines += [f"- {label}: {value}" for label, value in ctx.facts] or ["- none yet"]
    return "\n".join(lines)


class AgentCommentaryWriter:
    def __init__(self, base_url: str, model: str, api_key: str) -> None:
        self.model = model
        self._base_url = base_url
        self._api_key = api_key

    async def write(self, ctx: CommentaryContext) -> str:
        client = OpenAIChatCompletionClient(model=self.model, base_url=self._base_url, api_key=self._api_key)
        agent = Agent(client=client, name=COMMENTATOR, instructions=_INSTRUCTIONS)
        response = await agent.run(commentary_prompt(ctx))
        text = " ".join((response.text or "").split()).strip().strip('"')
        if len(text) < 12:
            raise CommentaryError("the model wrote nothing usable")
        return text[:MAX_CHARS]
