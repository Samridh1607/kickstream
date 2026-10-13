"""Reels picked and written by two Microsoft Agent Framework agents, one after the other.

The Highlight Editor chooses the moments worth a reel and says why; the Social Copywriter writes the
post for each. Neither chooses times or sees the video: they work from the moments' descriptions.
"""

from agent_framework import Agent
from agent_framework.openai import OpenAIChatCompletionClient

from kickstream.adapters.agent_writer import parse_json
from kickstream.ports.reels import ReelBrief, ReelPick

HIGHLIGHT_EDITOR = "highlight_editor"
SOCIAL_COPYWRITER = "social_copywriter"

_INSTRUCTIONS = {
    HIGHLIGHT_EDITOR: (
        "[role:highlight_editor] You are a sports video editor choosing moments of a recorded live broadcast "
        "to turn into short vertical reels. The user lists the candidate moments, one per line, each starting "
        "with its id in square brackets. Choose the ones most worth a reel, best first: goals and red cards, "
        "then big chances, then the rest. Choose no more than the number the user asks for. Use only ids from "
        'the list. Reply with JSON only, in exactly this shape: {"picks": [{"id": "...", "why": "..."}]}.'
    ),
    SOCIAL_COPYWRITER: (
        "[role:social_copywriter] You write the posts for short vertical football reels on TikTok, Instagram "
        "Reels and YouTube Shorts. For each reel the user lists, write a punchy title of at most 60 characters, "
        "a caption of one or two sentences of at most 200 characters, and 3 to 5 hashtags. Use only the facts "
        "given; do not invent names, numbers or events. Reply with JSON only, in exactly this shape: "
        '{"reels": [{"id": "...", "title": "...", "caption": "...", "hashtags": ["#..."]}]}.'
    ),
}


def _about(brief: ReelBrief) -> list[str]:
    lines = [f"Broadcast: {brief.title}"]
    if brief.description:
        lines.append(f"About: {' '.join(brief.description.split())}")
    if brief.score:
        lines.append(f"Final score: {brief.score}")
    return lines


def editor_prompt(brief: ReelBrief) -> str:
    lines = [*_about(brief), f"Choose at most {brief.max_reels}.", "Candidate moments:"]
    for candidate in brief.candidates:
        line = f"[{candidate.id}] {candidate.label}"
        lines.append(f"{line}: {' '.join(candidate.commentary.split())}" if candidate.commentary else line)
    return "\n".join(lines)


def writer_prompt(brief: ReelBrief, picks: list[tuple[str, str]]) -> str:
    by_id = {candidate.id: candidate for candidate in brief.candidates}
    lines = [*_about(brief), "Reels to write:"]
    for candidate_id, why in picks:
        candidate = by_id[candidate_id]
        line = f"[{candidate_id}] {candidate.label}"
        if candidate.commentary:
            line += f": {' '.join(candidate.commentary.split())}"
        lines.append(f"{line} (editor's note: {why})" if why else line)
    return "\n".join(lines)


def _picks(reply: dict, brief: ReelBrief) -> list[tuple[str, str]]:
    known = {candidate.id for candidate in brief.candidates}
    raw = reply.get("picks")
    if not isinstance(raw, list):
        raise ValueError("the highlight editor's reply has no picks")
    chosen: list[tuple[str, str]] = []
    for item in raw:
        if not isinstance(item, dict) or item.get("id") not in known:
            continue
        if any(candidate_id == item["id"] for candidate_id, _ in chosen):
            continue
        why = item.get("why")
        chosen.append((item["id"], " ".join(why.split()) if isinstance(why, str) else ""))
    if not chosen:
        raise ValueError("the highlight editor picked no known moment")
    return chosen[: brief.max_reels]


def _posts(reply: dict, picks: list[tuple[str, str]]) -> list[ReelPick]:
    raw = reply.get("reels")
    if not isinstance(raw, list):
        raise ValueError("the social copywriter's reply has no reels")
    written = {item.get("id"): item for item in raw if isinstance(item, dict)}
    posts = []
    for candidate_id, _ in picks:
        item = written.get(candidate_id)
        if item is None:
            continue
        title, caption, hashtags = item.get("title"), item.get("caption", ""), item.get("hashtags", [])
        if not isinstance(title, str) or not isinstance(caption, str) or not isinstance(hashtags, list):
            continue
        posts.append(ReelPick(candidate_id, title, caption, tuple(str(tag) for tag in hashtags)))
    if not posts:
        raise ValueError("the social copywriter wrote no usable post")
    return posts


class AgentReelProducer:
    name = "AI agents"

    def __init__(self, base_url: str, model: str, api_key: str) -> None:
        self.model = model
        self._base_url = base_url
        self._api_key = api_key

    def _agent(self, name: str) -> Agent:
        client = OpenAIChatCompletionClient(model=self.model, base_url=self._base_url, api_key=self._api_key)
        return Agent(client=client, name=name, instructions=_INSTRUCTIONS[name])

    async def produce(self, brief: ReelBrief) -> list[ReelPick]:
        edited = await self._agent(HIGHLIGHT_EDITOR).run(editor_prompt(brief))
        picks = _picks(parse_json(edited.text or ""), brief)
        written = await self._agent(SOCIAL_COPYWRITER).run(writer_prompt(brief, picks))
        return _posts(parse_json(written.text or ""), picks)
