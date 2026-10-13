"""Every rule for changing the fan zone.

Each rule takes a state and returns a new one; none mutates its argument. Time and chance are passed
in, so the rules can be tested without a clock. A change that is refused raises `FanError`.

Everything a fan wrote is untrusted. It is cut to length here and only ever shown as plain text.
"""

import random
import re
import typing
import uuid
from collections import Counter
from dataclasses import dataclass, field, replace

from kickstream.contracts import (
    FanComment,
    FanMood,
    FanPoll,
    FanPollOption,
    FanRaised,
    FanSettings,
    FanShare,
    FanSummary,
    FanTopic,
    FanZone,
    Spotlight,
    SuperChat,
)
from kickstream.domain.errors import Refusal
from kickstream.ports.social import IncomingComment, IncomingSuperChat

MAX_COMMENTS = 200
MAX_LIKED = 20  # liked comments outlive the others, up to this many
MAX_SUPERCHATS = 50
MAX_QUEUE = 10
MAX_COMMENT = 280
MAX_NAME = 60
MAX_MESSAGE = 200
MAX_REMEMBERED_IDS = 2000
DEFAULT_SPOTLIGHT_S = 10
SUMMARY_WINDOW_S = 120
MAX_TOPICS = 6
TIER_FROM = (0.0, 5.0, 10.0, 20.0, 50.0)  # the amount at which each tier starts, tiers 1 to 5
PLATFORMS = frozenset(typing.get_args(FanComment.model_fields["platform"].annotation))
POOLS = ("commenters", "voters", "supporters")

_VOTE = re.compile(r"^\s*[#!]?\s*(?:vote\s+)?([1-6])\s*$", re.IGNORECASE)
_WORD = re.compile(r"#?[^\W\d_]{4,}", re.UNICODE)
_SPACE = re.compile(r"\s+")
# A rough reading of mood, by the words fans use at a match. It is a guide for the streamer, not a measure.
_POSITIVE = frozenset(
    "goal goals love great amazing brilliant beauty beautiful yes superb class worldie magic quality "
    "unreal legend fantastic incredible best perfect wow lovely brilliant".split()
)
_NEGATIVE = frozenset(
    "awful terrible robbed rubbish boo shocking poor worst never dive diving offside disgrace joke "
    "useless embarrassing terrible sack clueless".split()
)
_POSITIVE_MARKS = ("🔥", "😍", "👏", "❤", "🙌", "⚽")
_NEGATIVE_MARKS = ("😡", "👎", "🤬", "😤")
_STOPWORDS = frozenset(
    "that this with from have what they them were will your just like been when come there about "
    "going could should would their here more some than then very into over only even much such "
    "does this that these those really still again back make made take want need know think".split()
)


class FanError(Refusal):
    """A change the fan zone refuses."""


@dataclass(frozen=True)
class FanState:
    doc: FanZone
    # Who voted for what in the current poll: an account's key to (its name, the option's ID).
    votes: dict[str, tuple[str, str]] = field(default_factory=dict)
    # IDs already taken in, newest last, so a platform repeating itself adds nothing.
    seen: tuple[str, ...] = ()


def new_id() -> str:
    return uuid.uuid4().hex[:8]


def _with(state: FanState, **changes) -> FanState:
    return replace(state, doc=state.doc.model_copy(update=changes))


def _clean(text: str, limit: int) -> str:
    return _SPACE.sub(" ", text).strip()[:limit].strip()


def _platform(name: str) -> str:
    return name if name in PLATFORMS else "other"


# --- reading the chat ---------------------------------------------------------------------------


def mood_of(text: str) -> str:
    words = {word.lower() for word in re.findall(r"[^\W\d_]+", text, re.UNICODE)}
    positive = len(words & _POSITIVE) + sum(mark in text for mark in _POSITIVE_MARKS)
    negative = len(words & _NEGATIVE) + sum(mark in text for mark in _NEGATIVE_MARKS)
    return "positive" if positive > negative else "negative" if negative > positive else "neutral"


def _topics(comments: list[FanComment]) -> list[FanTopic]:
    counts: Counter[str] = Counter()
    for comment in comments:
        found = {word.lower() for word in _WORD.findall(comment.text)}
        counts.update(word for word in found if word.lstrip("#") not in _STOPWORDS)
    ranked = sorted(
        ((count, word) for word, count in counts.items() if count >= 2), key=lambda t: (-t[0], t[1])
    )
    return [
        FanTopic(label=word if word.startswith("#") else word.capitalize(), count=count)
        for count, word in ranked[:MAX_TOPICS]
    ]


def summarize(comments: list[FanComment], superchats: list[SuperChat], now: float) -> FanSummary:
    recent = [comment for comment in comments if comment.at >= now - SUMMARY_WINDOW_S]
    per_minute = round(len(recent) / (SUMMARY_WINDOW_S / 60), 1)
    moods = Counter(comment.mood for comment in recent)
    total = len(recent) or 1
    mood = FanMood(
        positive=round(moods["positive"] / total * 100, 1) if recent else 0.0,
        neutral=round(moods["neutral"] / total * 100, 1) if recent else 0.0,
        negative=round(moods["negative"] / total * 100, 1) if recent else 0.0,
    )
    topics = _topics(recent)
    platforms = Counter(comment.platform for comment in comments).most_common(5)
    raised: Counter[str] = Counter()
    for superchat in superchats:
        raised[superchat.currency] += superchat.amount

    if not recent:
        text = "No comments in the last two minutes." if comments else "No comments yet."
    else:
        pace = "flying" if per_minute >= 30 else "busy" if per_minute >= 10 else "quiet"
        feeling = (
            "mostly positive" if mood.positive >= 60 else "turning sour" if mood.negative >= 40 else "mixed"
        )
        text = f"The chat is {pace} ({per_minute:g} a minute) and {feeling}."
        if topics:
            text += f" Talking about {', '.join(topic.label for topic in topics[:3])}."
    return FanSummary(
        text=text,
        per_minute=per_minute,
        total=len(comments),
        mood=mood,
        topics=topics,
        platforms=[FanShare(platform=platform, count=count) for platform, count in platforms],
        raised=[
            FanRaised(currency=currency, amount=round(amount, 2))
            for currency, amount in raised.most_common(5)
        ],
    )


def refresh(state: FanState, now: float) -> FanState:
    summary = summarize(state.doc.comments, state.doc.superchats, now)
    return state if summary == state.doc.summary else _with(state, summary=summary)


# --- taking in what the platforms send ----------------------------------------------------------


def _remember(state: FanState, ids: list[str]) -> tuple[str, ...]:
    return (*state.seen, *ids)[-MAX_REMEMBERED_IDS:]


def _trimmed(comments: list[FanComment]) -> list[FanComment]:
    """The newest comments, and the liked ones even when they are old."""
    if len(comments) <= MAX_COMMENTS:
        return comments
    liked = [comment for comment in comments if comment.liked][-MAX_LIKED:]
    kept = {comment.id for comment in liked}
    room = MAX_COMMENTS - len(liked)
    newest = [comment for comment in comments if comment.id not in kept][-room:]
    return sorted([*liked, *newest], key=lambda comment: comment.at)


def take_comments(state: FanState, incoming: list[IncomingComment], now: float, *, demo: bool) -> FanState:
    seen = set(state.seen)
    poll = state.doc.poll
    voting = poll is not None and poll.state == "open"
    votes = dict(state.votes)
    added: list[FanComment] = []
    taken: list[str] = []
    for item in incoming:
        text, author = _clean(item.text, MAX_COMMENT), _clean(item.author, MAX_NAME)
        if not item.id or item.id in seen or not text or not author:
            continue
        seen.add(item.id)
        taken.append(item.id)
        platform = _platform(item.platform)
        vote = _VOTE.match(text) if voting else None
        if vote and int(vote.group(1)) <= len(poll.options):
            # A vote is counted, not shown: a wall of numbers would bury the comments.
            votes[f"{platform}:{item.handle or author}"] = (author, poll.options[int(vote.group(1)) - 1].id)
            continue
        added.append(
            FanComment(
                id=item.id[:80],
                platform=platform,
                author=author,
                handle=_clean(item.handle, MAX_NAME) if item.handle else None,
                text=text,
                likes=max(0, item.likes),
                at=item.at if item.at is not None and item.at <= now else now,
                liked=False,
                mood=mood_of(text),
                demo=demo,
            )
        )
    if not taken:
        return state
    changes: dict = {}
    if added:
        changes["comments"] = _trimmed(sorted([*state.doc.comments, *added], key=lambda comment: comment.at))
    if votes != state.votes:
        changes["poll"] = _counted(poll, votes)
    return refresh(replace(_with(state, **changes), votes=votes, seen=_remember(state, taken)), now)


def tier_of(amount: float) -> int:
    return max(tier for tier, start in enumerate(TIER_FROM, 1) if amount >= start)


def _money(amount: float, currency: str) -> str:
    return f"{currency} {amount:,.2f}"


def _superchat(item: IncomingSuperChat, now: float, demo: bool) -> SuperChat | None:
    name, currency = _clean(item.name, MAX_NAME), item.currency.strip().upper()
    if not item.id or not name or not item.amount > 0 or len(currency) != 3 or not currency.isalpha():
        return None
    return SuperChat(
        id=item.id[:80],
        platform=_platform(item.platform),
        name=name,
        amount=round(item.amount, 2),
        currency=currency,
        message=_clean(item.message, MAX_MESSAGE),
        tier=tier_of(item.amount),
        at=now,
        demo=demo,
    )


def take_superchats(
    state: FanState, incoming: list[IncomingSuperChat], now: float, *, demo: bool
) -> FanState:
    seen = set(state.seen)
    added = []
    for item in incoming:
        superchat = None if item.id in seen else _superchat(item, now, demo)
        if superchat is not None:
            seen.add(superchat.id)
            added.append(superchat)
    if not added:
        return state
    state = replace(
        _with(state, superchats=[*state.doc.superchats, *added][-MAX_SUPERCHATS:]),
        seen=_remember(state, [superchat.id for superchat in added]),
    )
    if state.doc.settings.auto_superchat:
        for superchat in added:
            state = _show(state, _thanks(superchat), now)
    return refresh(state, now)


def add_superchat(
    state: FanState, name: str, amount: float, currency: str, message: str, now: float
) -> FanState:
    """One the streamer types in, for a payment that reached them some other way."""
    item = IncomingSuperChat(f"manual-{new_id()}", "other", name, amount, currency, message)
    if _superchat(item, now, False) is None:
        raise FanError(
            422, "superchat", "A superchat needs a name, an amount above zero and a three-letter currency."
        )
    return take_superchats(state, [item], now, demo=False)


# --- the spotlight ------------------------------------------------------------------------------


def _show(state: FanState, spotlight: Spotlight, now: float) -> FanState:
    if state.doc.spotlight is None:
        on_air = spotlight.model_copy(update={"ends_at": now + spotlight.duration_s})
        return _with(state, spotlight=on_air)
    return _with(state, spotlight_queue=[*state.doc.spotlight_queue, spotlight][-MAX_QUEUE:])


def _thanks(superchat: SuperChat) -> Spotlight:
    return Spotlight(
        id=new_id(),
        kind="superchat",
        title="Superchat",
        text=superchat.message,
        name=superchat.name,
        detail=_money(superchat.amount, superchat.currency),
        tier=superchat.tier,
        duration_s=DEFAULT_SPOTLIGHT_S + 2 * superchat.tier,
    )


def spotlight_comment(state: FanState, comment_id: str, now: float) -> FanState:
    comment = next((item for item in state.doc.comments if item.id == comment_id), None)
    if comment is None:
        raise FanError(404, "comment", "That comment is no longer in the list.")
    spotlight = Spotlight(
        id=new_id(),
        kind="comment",
        title="Fan comment",
        text=comment.text,
        name=comment.author,
        detail=comment.platform,
        duration_s=DEFAULT_SPOTLIGHT_S,
    )
    return _show(state, spotlight, now)


def spotlight_superchat(state: FanState, superchat_id: str, now: float) -> FanState:
    superchat = next((item for item in state.doc.superchats if item.id == superchat_id), None)
    if superchat is None:
        raise FanError(404, "superchat", "That superchat is no longer in the list.")
    return _show(state, _thanks(superchat), now)


def spotlight_message(state: FanState, title: str, text: str, duration_s: int, now: float) -> FanState:
    title, text = _clean(title, 80), _clean(text, MAX_COMMENT)
    if not text:
        raise FanError(422, "text", "A message needs 1 to 280 characters of text.")
    if not 3 <= duration_s <= 60:
        raise FanError(422, "duration_s", "A message stays up for 3 to 60 seconds.")
    spotlight = Spotlight(id=new_id(), kind="message", title=title, text=text, duration_s=duration_s)
    return _show(state, spotlight, now)


def clear_spotlight(state: FanState, now: float) -> FanState:
    if not state.doc.spotlight_queue:
        return _with(state, spotlight=None) if state.doc.spotlight is not None else state
    following, *rest = state.doc.spotlight_queue
    return _with(
        state,
        spotlight=following.model_copy(update={"ends_at": now + following.duration_s}),
        spotlight_queue=rest,
    )


def like_comment(state: FanState, comment_id: str, liked: bool) -> FanState:
    if not any(comment.id == comment_id for comment in state.doc.comments):
        raise FanError(404, "comment", "That comment is no longer in the list.")
    comments = [
        comment.model_copy(update={"liked": liked}) if comment.id == comment_id else comment
        for comment in state.doc.comments
    ]
    return _with(state, comments=comments)


# --- polls --------------------------------------------------------------------------------------


def _counted(poll: FanPoll, votes: dict[str, tuple[str, str]]) -> FanPoll:
    counts = Counter(option_id for _, option_id in votes.values())
    options = [option.model_copy(update={"votes": counts[option.id]}) for option in poll.options]
    return poll.model_copy(update={"options": options})


def open_poll(
    state: FanState, question: str, options: list[str], minutes: int | None, now: float
) -> FanState:
    question = _clean(question, 500)
    choices = [_clean(option, 500) for option in options]
    choices = [choice for choice in choices if choice]
    if not 1 <= len(question) <= 140:
        raise FanError(422, "question", "A poll question must be 1 to 140 characters.")
    if not 2 <= len(choices) <= 6:
        raise FanError(422, "options", "A poll needs 2 to 6 options.")
    if any(len(choice) > 60 for choice in choices):
        raise FanError(422, "options", "A poll option can be at most 60 characters.")
    if len({choice.lower() for choice in choices}) != len(choices):
        raise FanError(422, "options", "Each poll option must be different.")
    if minutes is not None and not 1 <= minutes <= 60:
        raise FanError(422, "minutes", "A timed poll runs for 1 to 60 minutes.")
    poll = FanPoll(
        id=new_id(),
        question=question,
        options=[FanPollOption(id=f"o{n}", text=choice, votes=0) for n, choice in enumerate(choices, 1)],
        state="open",
        opened_at=now,
        closes_at=None if minutes is None else now + minutes * 60,
    )
    return replace(_with(state, poll=poll), votes={})


def _need_poll(state: FanState) -> FanPoll:
    if state.doc.poll is None:
        raise FanError(409, "poll", "There is no poll.")
    return state.doc.poll


def close_poll(state: FanState) -> FanState:
    poll = _need_poll(state)
    if poll.state == "closed":
        return state
    return _with(state, poll=poll.model_copy(update={"state": "closed", "closes_at": None}))


def set_poll_air(state: FanState, on_air: bool) -> FanState:
    if on_air:
        _need_poll(state)
    return state if state.doc.poll_on_air == on_air else _with(state, poll_on_air=on_air)


def remove_poll(state: FanState) -> FanState:
    if state.doc.poll is None:
        return state
    return replace(_with(state, poll=None, poll_on_air=False), votes={})


def leader(poll: FanPoll) -> tuple[FanPollOption, float] | None:
    """The option in front and its share of the votes, or None while no one has voted."""
    total = sum(option.votes for option in poll.options)
    if total == 0:
        return None
    best = max(poll.options, key=lambda option: option.votes)
    return best, best.votes / total * 100


def announce_poll(state: FanState, now: float) -> FanState:
    poll = _need_poll(state)
    front = leader(poll)
    if front is None:
        raise FanError(409, "poll", "No one has voted yet.")
    option, share = front
    spotlight = Spotlight(
        id=new_id(),
        kind="poll_result",
        title=poll.question[:80],
        text=option.text,
        detail=f"{share:.0f}% of {sum(o.votes for o in poll.options)} votes",
        duration_s=DEFAULT_SPOTLIGHT_S,
    )
    return _show(state, spotlight, now)


# --- quick actions ------------------------------------------------------------------------------


def pool_names(state: FanState, pool: str) -> list[str]:
    """Everyone who could be picked, once each, in a fixed order."""
    if pool == "commenters":
        names = [comment.author for comment in state.doc.comments]
    elif pool == "voters":
        names = [name for name, _ in state.votes.values()]
    elif pool == "supporters":
        names = [superchat.name for superchat in state.doc.superchats]
    else:
        raise FanError(422, "pool", f"A winner is picked from one of: {', '.join(POOLS)}.")
    return sorted(set(names))


def pick_winner(state: FanState, pool: str, rng: random.Random, now: float) -> FanState:
    names = pool_names(state, pool)
    if not names:
        raise FanError(409, "pool", f"There are no {pool} to pick from yet.")
    spotlight = Spotlight(
        id=new_id(),
        kind="winner",
        title="Winner",
        text=f"Picked from {len(names)} {pool if len(names) != 1 else pool[:-1]}.",
        name=rng.choice(names),
        duration_s=DEFAULT_SPOTLIGHT_S + 5,
    )
    return _show(state, spotlight, now)


def set_settings(state: FanState, settings: FanSettings) -> FanState:
    if settings.source == "x" and not state.doc.x_available:
        raise FanError(
            409,
            "source",
            "X is not set up. Put KICKSTREAM_X_BEARER_TOKEN and KICKSTREAM_X_QUERY in .env and restart.",
        )
    if settings == state.doc.settings:
        return state
    source_state = {"off": "off", "demo": "demo", "x": "live"}[settings.source]
    return _with(state, settings=settings, source_state=source_state, problem=None)


def set_source_health(state: FanState, problem: str | None) -> FanState:
    if state.doc.settings.source == "off":
        return state
    healthy = "demo" if state.doc.settings.source == "demo" else "live"
    source_state = "failing" if problem else healthy
    if (state.doc.source_state, state.doc.problem) == (source_state, problem):
        return state
    return _with(state, source_state=source_state, problem=problem)


def clear(state: FanState, now: float) -> FanState:
    emptied = _with(
        state, comments=[], superchats=[], poll=None, poll_on_air=False, spotlight=None, spotlight_queue=[]
    )
    return refresh(replace(emptied, votes={}), now)


# --- deadlines ----------------------------------------------------------------------------------


def next_deadline(state: FanState) -> float | None:
    times = []
    if state.doc.spotlight is not None and state.doc.spotlight.ends_at is not None:
        times.append(state.doc.spotlight.ends_at)
    if state.doc.poll is not None and state.doc.poll.closes_at is not None:
        times.append(state.doc.poll.closes_at)
    return min(times) if times else None


def expire(state: FanState, now: float) -> FanState:
    """Settle everything whose time has come. Returns the same object when nothing was due."""
    spotlight = state.doc.spotlight
    while spotlight is not None and spotlight.ends_at is not None and spotlight.ends_at <= now:
        state = clear_spotlight(state, now)
        spotlight = state.doc.spotlight
    poll = state.doc.poll
    if poll is not None and poll.closes_at is not None and poll.closes_at <= now:
        state = close_poll(state)
    return state


# --- saving and loading -------------------------------------------------------------------------


def empty_state(x_available: bool) -> FanState:
    doc = FanZone(
        revision=0,
        server_time=0.0,
        settings=FanSettings(source="demo", auto_superchat=False),
        source_state="demo",
        x_available=x_available,
        comments=[],
        summary=summarize([], [], 0.0),
        poll_on_air=False,
        superchats=[],
        spotlight_queue=[],
    )
    return FanState(doc)


def dump(state: FanState) -> dict:
    return {
        "doc": state.doc.model_dump(mode="json"),
        "votes": {key: list(vote) for key, vote in state.votes.items()},
    }


def load(record: dict, x_available: bool) -> FanState:
    """Raises ValueError, TypeError or KeyError for a record that cannot be used."""
    doc = FanZone.model_validate(record["doc"])
    settings = doc.settings
    if settings.source == "x" and not x_available:
        settings = settings.model_copy(update={"source": "off"})
    source_state = {"off": "off", "demo": "demo", "x": "live"}[settings.source]
    doc = doc.model_copy(
        update={
            "settings": settings,
            "source_state": source_state,
            "problem": None,
            "x_available": x_available,
        }
    )
    votes = {str(key): (str(vote[0]), str(vote[1])) for key, vote in dict(record.get("votes", {})).items()}
    seen = tuple(item.id for item in (*doc.comments, *doc.superchats))
    return FanState(doc, votes, seen)
