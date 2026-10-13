"""Where reels come from in a recording, how long they run, and what a producer may hand back.

A producer only picks candidates and writes the post: the times are decided here, so no model can
cut outside the recording.
"""

import re

from kickstream.contracts import Broadcast, BroadcastRecording
from kickstream.ports.reels import ReelBrief, ReelCandidate, ReelPick

REEL_S = 15.0
LEAD_S = 8.0  # of the reel, how much comes before its moment
MAX_PICKS = 4
MAX_HASHTAGS = 6
MAX_TITLE = 80
MAX_CAPTION = 300
MAX_HASHTAG = 30
KIND_LABELS = {
    "goal": "Goal",
    "red_card": "Red card",
    "big_chance": "Big chance",
    "momentum_swing": "Momentum swing",
    "sustained_pressure": "Sustained pressure",
}
_NOT_A_TAG = re.compile(r"[^0-9A-Za-z_]+")


def recording_length(recording: BroadcastRecording) -> float:
    return max(0.0, recording.made_at - recording.started_at)


def latest_recording(broadcast: Broadcast) -> BroadcastRecording | None:
    """The longest recording, which is the main one when a stream was restarted."""
    if not broadcast.recordings:
        return None
    return max(broadcast.recordings, key=recording_length)


def _team(broadcast: Broadcast, side: str) -> str | None:
    score = broadcast.stats.score
    if score is None:
        return None
    return score.home if side == "home" else score.away


def candidates(broadcast: Broadcast, recording: BroadcastRecording) -> list[ReelCandidate]:
    """The key moments inside the recording; plain stretches of it when there were none."""
    length = recording_length(recording)
    found = []
    for moment in broadcast.moments:
        offset = moment.at - recording.started_at
        if not 0 <= offset <= length:
            continue
        team = _team(broadcast, moment.team)
        kind = KIND_LABELS[moment.kind]
        label = f"{moment.minute}' {kind}" + (f" · {team}" if team else "")
        label += f" ({moment.score_home}-{moment.score_away})"
        found.append(
            ReelCandidate(
                id=moment.id,
                label=label,
                offset_s=round(offset, 2),
                kind=moment.kind,
                minute=moment.minute,
                team=team,
                commentary=moment.commentary,
            )
        )
    if found:
        return found
    parts = max(1, min(3, int(length // 60) + 1))
    return [
        ReelCandidate(
            id=f"part-{index + 1}",
            label=f"Part {index + 1} of {parts}",
            offset_s=round((index + 0.5) * length / parts, 2),
        )
        for index in range(parts)
    ]


def brief(broadcast: Broadcast, found: list[ReelCandidate], max_reels: int) -> ReelBrief:
    score = broadcast.stats.score
    line = f"{score.home} {score.score_home}-{score.score_away} {score.away}" if score else None
    return ReelBrief(
        title=broadcast.title,
        description=broadcast.description,
        score=line,
        candidates=tuple(found),
        max_reels=max(0, min(MAX_PICKS, max_reels)),
    )


def window(offset_s: float, length_s: float) -> tuple[float, float]:
    """Where a reel around a moment starts, and how long it runs, kept inside the recording."""
    duration = min(REEL_S, max(0.0, length_s))
    start = min(max(0.0, offset_s - LEAD_S), max(0.0, length_s - duration))
    return round(start, 2), round(duration, 2)


def hashtag(text: str) -> str | None:
    """`#WordsLikeThis`, or None when nothing usable is left."""
    words = [word for word in _NOT_A_TAG.split(text.lstrip("#")) if word]
    if not words:
        return None
    tag = "#" + "".join(word[:1].upper() + word[1:] for word in words)
    return tag[:MAX_HASHTAG]


def _clip(text: str, limit: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def checked(picks: list[ReelPick], found: list[ReelCandidate], limit: int) -> list[ReelPick]:
    """What a producer returned, made safe: known candidates once each, text within its limits."""
    known = {candidate.id for candidate in found}
    kept: list[ReelPick] = []
    for pick in picks:
        if len(kept) >= limit:
            break
        if pick.candidate_id not in known or any(k.candidate_id == pick.candidate_id for k in kept):
            continue
        title = _clip(pick.title, MAX_TITLE)
        if not title:
            continue
        tags: list[str] = []
        for raw in pick.hashtags:
            tag = hashtag(str(raw))
            if tag and tag.lower() not in (t.lower() for t in tags):
                tags.append(tag)
        kept.append(
            ReelPick(
                candidate_id=pick.candidate_id,
                title=title,
                caption=_clip(pick.caption, MAX_CAPTION),
                hashtags=tuple(tags[:MAX_HASHTAGS]),
            )
        )
    return kept
