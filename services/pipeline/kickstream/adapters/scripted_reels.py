"""Reels picked by rank and written from templates. Needs no network; used whenever the agents are unavailable."""

from kickstream.ports.reels import ReelBrief, ReelCandidate, ReelPick

_RANK = {"goal": 0, "red_card": 1, "big_chance": 2, "momentum_swing": 3, "sustained_pressure": 4}
_TITLES = {
    "goal": "GOAL! {team} score in the {minute}'",
    "red_card": "Red card drama in the {minute}'",
    "big_chance": "So close! {team}'s big chance",
    "momentum_swing": "{team} seize control",
    "sustained_pressure": "{team} turn up the pressure",
}
_CAPTIONS = {
    "goal": "{team} find the net in minute {minute}. Watch it again.",
    "red_card": "A red card in minute {minute} changes everything.",
    "big_chance": "{team} were inches away in minute {minute}.",
    "momentum_swing": "The game turns {team}'s way around minute {minute}.",
    "sustained_pressure": "{team} pin their opponents back around minute {minute}.",
}
_TAGS = {
    "goal": "Goal",
    "red_card": "RedCard",
    "big_chance": "SoClose",
    "momentum_swing": "Momentum",
    "sustained_pressure": "Pressure",
}


class ScriptedReelProducer:
    name = "template"

    async def produce(self, brief: ReelBrief) -> list[ReelPick]:
        ranked = sorted(brief.candidates, key=lambda c: (_RANK.get(c.kind or "", len(_RANK)), c.offset_s))
        chosen = sorted(ranked[: brief.max_reels], key=lambda c: c.offset_s)
        return [self._write(brief, candidate) for candidate in chosen]

    @staticmethod
    def _write(brief: ReelBrief, candidate: ReelCandidate) -> ReelPick:
        tags = ["Kickstream", "Highlights"]
        if candidate.kind is None:
            caption = brief.description or f"A moment from {brief.title}."
            return ReelPick(
                candidate.id, f"{brief.title} · {candidate.label}", caption, (*tags, "LiveStream")
            )
        fields = {"team": candidate.team or "The attack", "minute": candidate.minute}
        caption = candidate.commentary or _CAPTIONS[candidate.kind].format(**fields)
        if brief.score:
            caption = f"{caption} Final score: {brief.score}."
        tags = [*tags, "Football", _TAGS[candidate.kind]]
        if candidate.team:
            tags.append(candidate.team)
        return ReelPick(candidate.id, _TITLES[candidate.kind].format(**fields), caption, tuple(tags))
