"""Narratives written by a team of Microsoft Agent Framework agents.

Commentator and Tactical Analyst work on a key moment concurrently; the Localizer then
translates both. The Recap Writer produces both recap modes; the Localizer translates them.
The model endpoint is any OpenAI-compatible Chat Completions endpoint.
"""

import json

from agent_framework import Agent
from agent_framework.openai import OpenAIChatCompletionClient
from agent_framework.orchestrations import ConcurrentBuilder

from kickstream.domain.labels import fact_text
from kickstream.domain.types import MODES, Variant
from kickstream.ports.writer import MomentContext, NarrationError, RecapContext, WrittenRecap, WrittenText

COMMENTATOR = "commentator"
ANALYST = "tactical_analyst"
RECAP_WRITER = "recap_writer"
LOCALIZER = "localizer"
_WRITER_FOR_MODE = {"fan": COMMENTATOR, "analyst": ANALYST}

_INSTRUCTIONS = {
    COMMENTATOR: (
        "[role:commentator] You are a live football commentator speaking to fans. Write one or two short, vivid "
        "sentences in English about the key moment the user describes. Use only the facts given; do not invent "
        "names, numbers or events. Reply with the sentences only."),
    ANALYST: (
        "[role:tactical_analyst] You are a football tactical analyst. In two or three sentences in English, explain "
        "what changed and why this moment matters, citing the numbers given. Use only the facts given; do not "
        "invent names, numbers or events. Reply with the sentences only."),
    RECAP_WRITER: (
        "[role:recap_writer] You write football match recaps from the summary the user gives. Use only the facts "
        "given. Reply with JSON only, in exactly this shape: "
        '{"fan": {"title": "...", "bullets": ["...", "...", "..."], "text": "..."}, '
        '"analyst": {"title": "...", "bullets": ["...", "...", "..."], "text": "..."}}. '
        "The fan version is short and vivid. The analyst version explains the numbers. Write in English."),
    LOCALIZER: (
        "[role:localizer] You translate football text. The user sends a JSON object. Translate every string value "
        "into Spanish and into Hindi. Keep player names, club names, numbers and the JSON structure unchanged. "
        'Reply with JSON only, in exactly this shape: {"es": <the object in Spanish>, "hi": <the object in Hindi>}.'),
}


def parse_json(text: str) -> dict:
    """Read one JSON object from model output, tolerating code fences and surrounding prose."""
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise NarrationError("no JSON object in model output")
    try:
        value = json.loads(text[start:end + 1])
    except ValueError as exc:
        raise NarrationError(f"invalid JSON in model output: {exc}") from exc
    if not isinstance(value, dict):
        raise NarrationError("model output is not a JSON object")
    return value


def _stats_line(ctx: MomentContext | RecapContext) -> str:
    home, away = ctx.stats.home, ctx.stats.away
    return (f"shots {home.shots}-{away.shots}, shots on target {home.shots_on_target}-{away.shots_on_target}, "
            f"possession {home.possession}%-{away.possession}%, expected goals {home.xg}-{away.xg} "
            f"({ctx.home.name} first)")


def moment_prompt(ctx: MomentContext) -> str:
    moment = ctx.moment
    team = (ctx.home if moment.team == "home" else ctx.away).name
    lines = [
        f"Match: {ctx.home.name} vs {ctx.away.name}",
        f"Minute: {moment.minute}",
        f"Key moment: {moment.kind.replace('_', ' ')}",
        f"Team: {team}",
        f"Player: {ctx.player_name or 'not applicable'}",
        f"Score: {ctx.home.name} {moment.score_home}-{moment.score_away} {ctx.away.name}",
        f"Numbers that triggered this moment: {fact_text(moment.facts, 'en')}",
    ]
    if ctx.stats is not None:
        lines.append(f"Match so far: {_stats_line(ctx)}")
    return "\n".join(lines)


def recap_prompt(ctx: RecapContext) -> str:
    home, away = ctx.stats.home, ctx.stats.away
    lines = [
        f"Recap for: {ctx.period.replace('_', ' ')}",
        f"Score: {ctx.home.name} {home.goals}-{away.goals} {ctx.away.name}",
        f"Match numbers: {_stats_line(ctx)}",
        "Key moments:",
    ]
    for moment in ctx.moments:
        team = (ctx.home if moment.team == "home" else ctx.away).name
        lines.append(f"- {moment.minute}' {moment.kind.replace('_', ' ')} for {team} ({fact_text(moment.facts, 'en')})")
    return "\n".join(lines)


class AgentNarrativeWriter:
    def __init__(self, base_url: str, model: str, api_key: str) -> None:
        self.model = model
        self._base_url = base_url
        self._api_key = api_key

    def _agent(self, name: str) -> Agent:
        # One client per agent: the Chat Completions client must not serve overlapping calls.
        client = OpenAIChatCompletionClient(model=self.model, base_url=self._base_url, api_key=self._api_key)
        return Agent(client=client, name=name, instructions=_INSTRUCTIONS[name])

    async def write_moment(self, ctx: MomentContext) -> dict[Variant, WrittenText]:
        workflow = ConcurrentBuilder(participants=[self._agent(COMMENTATOR), self._agent(ANALYST)]).build()
        result = await workflow.run(moment_prompt(ctx))
        outputs = result.get_outputs()
        if not outputs:
            raise NarrationError("the commentary workflow produced no output")
        by_author = {message.author_name: (message.text or "").strip() for message in outputs[0].messages}
        english = {mode: by_author.get(author, "") for mode, author in _WRITER_FOR_MODE.items()}
        if not all(english.values()):
            raise NarrationError("an agent returned no text")
        translated = await self._localize(english)

        written: dict[Variant, WrittenText] = {}
        for mode in MODES:
            written[(mode, "en")] = WrittenText(english[mode], _WRITER_FOR_MODE[mode])
            for language in ("es", "hi"):
                text = translated[language].get(mode)
                if not isinstance(text, str):
                    raise NarrationError(f"localizer omitted {mode} in {language}")
                written[(mode, language)] = WrittenText(text, LOCALIZER)
        return written

    async def write_recap(self, ctx: RecapContext) -> dict[Variant, WrittenRecap]:
        response = await self._agent(RECAP_WRITER).run(recap_prompt(ctx))
        english = parse_json(response.text or "")
        translated = await self._localize(english)

        written: dict[Variant, WrittenRecap] = {}
        for mode in MODES:
            written[(mode, "en")] = self._recap(english.get(mode), RECAP_WRITER)
            for language in ("es", "hi"):
                written[(mode, language)] = self._recap(translated[language].get(mode), LOCALIZER)
        return written

    @staticmethod
    def _recap(raw, agent: str) -> WrittenRecap:
        try:
            title, bullets, text = raw["title"], raw["bullets"], raw["text"]
            if not (isinstance(title, str) and isinstance(text, str) and isinstance(bullets, list)
                    and len(bullets) == 3 and all(isinstance(bullet, str) for bullet in bullets)):
                raise TypeError("wrong field types")
        except (KeyError, TypeError) as exc:
            raise NarrationError(f"recap from {agent} has the wrong shape: {exc}") from exc
        return WrittenRecap(title, (bullets[0], bullets[1], bullets[2]), text, agent)

    async def _localize(self, english: dict) -> dict:
        response = await self._agent(LOCALIZER).run(json.dumps(english, ensure_ascii=False))
        translated = parse_json(response.text or "")
        for language in ("es", "hi"):
            if not isinstance(translated.get(language), dict):
                raise NarrationError(f"localizer omitted {language}")
        return translated
