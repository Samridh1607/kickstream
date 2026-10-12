"""Every rule for polls, fan questions and the expert's answer.

Each rule takes a state and returns a new one; none mutates its argument. Time is passed in.
A broken limit raises `AudienceError`.
"""

import math
import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from typing import Literal

from kickstream.contracts import Audience, Draft, Poll, PollOption, QaOnAir, Question
from kickstream.domain.errors import Refusal
from kickstream.domain.types import Language

ASK_INTERVAL_S = 30
MAX_ACTIVE_QUESTIONS = 200
MAX_ANSWERED = 50
MAX_HISTORY = 20
MAX_ANSWER = 400
DEFAULT_QA_SECONDS = 30
_VOTER = re.compile(r"[A-Za-z0-9-]{16,64}")

_PRESETS: dict[Language, dict[str, str]] = {
    "en": {
        "winner": "Who will win?",
        "draw": "Draw",
        "next_goal": "Who scores next?",
        "none": "No more goals",
    },
    "es": {
        "winner": "¿Quién ganará?",
        "draw": "Empate",
        "next_goal": "¿Quién marca el próximo gol?",
        "none": "No habrá más goles",
    },
    "hi": {
        "winner": "कौन जीतेगा?",
        "draw": "ड्रॉ",
        "next_goal": "अगला गोल कौन करेगा?",
        "none": "अब कोई गोल नहीं",
    },
}


class AudienceError(Refusal):
    """A change the audience rules refuse."""


@dataclass(frozen=True)
class AudienceState:
    doc: Audience
    poll_votes: Mapping[str, str] = field(default_factory=dict)  # voter -> option id, current poll only
    upvotes: Mapping[str, frozenset[str]] = field(
        default_factory=dict
    )  # question id -> voters, author included
    authors: Mapping[str, str] = field(default_factory=dict)  # question id -> voter
    last_asked: Mapping[str, float] = field(default_factory=dict)  # voter -> time; not saved


def empty_state() -> AudienceState:
    return AudienceState(
        doc=Audience(revision=0, server_time=0.0, poll_on_air=False, history=[], questions=[])
    )


def new_id() -> str:
    return uuid.uuid4().hex[:8]


def _doc(state: AudienceState, **changes) -> AudienceState:
    return replace(state, doc=state.doc.model_copy(update=changes))


def check_voter(voter: str | None) -> str:
    if voter is None or _VOTER.fullmatch(voter) is None:
        raise AudienceError(422, "voter", "This browser's ID is missing or malformed.")
    return voter


def question_for(state: AudienceState, question_id: str) -> Question | None:
    return next((question for question in state.doc.questions if question.id == question_id), None)


def _question(state: AudienceState, question_id: str) -> Question:
    question = question_for(state, question_id)
    if question is None:
        raise AudienceError(404, "question", "That question is no longer in the list.")
    return question


def _swap(state: AudienceState, updated: Question) -> AudienceState:
    return _doc(state, questions=[updated if q.id == updated.id else q for q in state.doc.questions])


# --- polls -------------------------------------------------------------------------------------


def _archived(doc: Audience) -> list[Poll]:
    if doc.poll is None:
        return list(doc.history)
    return [doc.poll.model_copy(update={"state": "closed"}), *doc.history][:MAX_HISTORY]


def create_poll(
    state: AudienceState, question: str, options: list[str], duration_s: int | None, now: float
) -> AudienceState:
    question = question.strip()
    if not 1 <= len(question) <= 140:
        raise AudienceError(422, "question", "A poll question needs 1 to 140 characters.")
    texts = [option.strip() for option in options]
    if not 2 <= len(texts) <= 6:
        raise AudienceError(422, "options", "A poll needs 2 to 6 options.")
    if any(not 1 <= len(text) <= 60 for text in texts):
        raise AudienceError(422, "options", "Each option needs 1 to 60 characters.")
    if len({text.casefold() for text in texts}) != len(texts):
        raise AudienceError(422, "options", "Two options are the same.")
    if duration_s is not None and not 30 <= duration_s <= 600:
        raise AudienceError(422, "duration_s", "A timed poll runs for 30 seconds to 10 minutes.")
    # Option IDs are unique across polls, so a vote meant for an earlier poll can never land here.
    poll = Poll(
        id=new_id(),
        question=question,
        state="open",
        options=[PollOption(id=new_id(), text=text, votes=0) for text in texts],
        closes_at=None if duration_s is None else now + duration_s,
    )
    return replace(_doc(state, poll=poll, history=_archived(state.doc), poll_on_air=False), poll_votes={})


def preset_poll(
    state: AudienceState,
    kind: Literal["winner", "next_goal"],
    home: str,
    away: str,
    language: Language,
    duration_s: int | None,
    now: float,
) -> AudienceState:
    words = _PRESETS[language]
    options = [home, words["draw"], away] if kind == "winner" else [home, away, words["none"]]
    return create_poll(state, words[kind], options, duration_s, now)


def close_poll(state: AudienceState) -> AudienceState:
    poll = state.doc.poll
    if poll is None or poll.state == "closed":
        raise AudienceError(409, "poll", "There is no open poll to close.")
    return _doc(state, poll=poll.model_copy(update={"state": "closed", "closes_at": None}))


def set_poll_on_air(state: AudienceState, on: bool) -> AudienceState:
    if on and state.doc.poll is None:
        raise AudienceError(409, "poll", "There is no poll to show.")
    return _doc(state, poll_on_air=on)


def restore_poll(state: AudienceState, poll_id: str) -> AudienceState:
    earlier = next((poll for poll in state.doc.history if poll.id == poll_id), None)
    if earlier is None:
        raise AudienceError(404, "poll", "That poll is no longer in the history.")
    history = [poll for poll in _archived(state.doc) if poll.id != poll_id][:MAX_HISTORY]
    return replace(_doc(state, poll=earlier, history=history), poll_votes={})


def vote(state: AudienceState, voter: str, option_id: str) -> AudienceState:
    poll = state.doc.poll
    if poll is None or poll.state == "closed":
        raise AudienceError(409, "poll", "This poll is closed.")
    if all(option.id != option_id for option in poll.options):
        raise AudienceError(409, "option", "That option belongs to an earlier poll.")
    previous = state.poll_votes.get(voter)
    if previous == option_id:
        return state

    def recount(option: PollOption) -> PollOption:
        change = (option.id == option_id) - (option.id == previous)
        return option.model_copy(update={"votes": max(0, option.votes + change)}) if change else option

    counted = poll.model_copy(update={"options": [recount(option) for option in poll.options]})
    return replace(_doc(state, poll=counted), poll_votes={**state.poll_votes, voter: option_id})


# --- questions ---------------------------------------------------------------------------------


def _without(state: AudienceState, question_id: str) -> AudienceState:
    return replace(
        _doc(state, questions=[q for q in state.doc.questions if q.id != question_id]),
        upvotes={k: v for k, v in state.upvotes.items() if k != question_id},
        authors={k: v for k, v in state.authors.items() if k != question_id},
    )


def ask(state: AudienceState, voter: str, text: str, nickname: str, now: float) -> AudienceState:
    text, nickname = text.strip(), nickname.strip()
    if not 1 <= len(text) <= 200:
        raise AudienceError(422, "text", "A question needs 1 to 200 characters.")
    if len(nickname) > 24:
        raise AudienceError(422, "nickname", "A nickname can be at most 24 characters.")
    last = state.last_asked.get(voter)
    if last is not None and now - last < ASK_INTERVAL_S:
        wait = math.ceil(ASK_INTERVAL_S - (now - last))
        raise AudienceError(429, "text", f"You can ask again in {wait} seconds.", retry_after=wait)
    active = [q for q in state.doc.questions if q.state != "answered"]
    if any(state.authors.get(q.id) == voter and q.text.casefold() == text.casefold() for q in active):
        raise AudienceError(409, "text", "You have already asked that.")
    if len(active) >= MAX_ACTIVE_QUESTIONS:
        open_questions = [q for q in active if q.state == "open"]
        if not open_questions:
            raise AudienceError(422, "questions", "The question list is full.")
        state = _without(state, min(open_questions, key=lambda q: (q.votes, q.asked_at)).id)
    question = Question(
        id=new_id(), text=text, nickname=nickname or "Fan", votes=1, state="open", asked_at=now
    )
    return replace(
        _doc(state, questions=[*state.doc.questions, question]),
        upvotes={**state.upvotes, question.id: frozenset({voter})},
        authors={**state.authors, question.id: voter},
        last_asked={**state.last_asked, voter: now},
    )


def upvote(state: AudienceState, voter: str, question_id: str) -> AudienceState:
    question = _question(state, question_id)
    if question.state != "open":
        raise AudienceError(409, "question", "That question is no longer open for votes.")
    if state.authors.get(question_id) == voter:
        return state
    voters = state.upvotes.get(question_id, frozenset())
    voters = voters - {voter} if voter in voters else voters | {voter}
    return replace(
        _swap(state, question.model_copy(update={"votes": len(voters)})),
        upvotes={**state.upvotes, question_id: voters},
    )


def _set_state(state: AudienceState, question_id: str, wanted: str, allowed_from: str) -> AudienceState:
    question = _question(state, question_id)
    if question.state != allowed_from:
        raise AudienceError(409, "question", f"Only a question that is {allowed_from} can be made {wanted}.")
    return _swap(state, question.model_copy(update={"state": wanted}))


def hide(state: AudienceState, question_id: str) -> AudienceState:
    return _set_state(state, question_id, "hidden", "open")


def unhide(state: AudienceState, question_id: str) -> AudienceState:
    return _set_state(state, question_id, "open", "hidden")


# --- the expert draft and going on air -----------------------------------------------------------


def start_draft(state: AudienceState, question_id: str, expert_available: bool) -> AudienceState:
    _question(state, question_id)
    return _doc(
        state,
        draft=Draft(question_id=question_id, text="", state="writing" if expert_available else "unavailable"),
    )


def finish_draft(state: AudienceState, question_id: str, text: str | None) -> AudienceState:
    """Deliver the expert's answer, unless the draft it was written for has since moved on."""
    draft = state.doc.draft
    if draft is None or draft.question_id != question_id or draft.state != "writing":
        return state
    answer = (text or "").strip()[:MAX_ANSWER]
    return _doc(
        state, draft=draft.model_copy(update={"text": answer, "state": "ready" if answer else "unavailable"})
    )


def set_draft_text(state: AudienceState, text: str) -> AudienceState:
    draft = state.doc.draft
    if draft is None:
        raise AudienceError(409, "draft", "There is no draft to edit. Choose a question first.")
    if len(text) > MAX_ANSWER:
        raise AudienceError(422, "text", f"An answer can be at most {MAX_ANSWER} characters.")
    return _doc(state, draft=draft.model_copy(update={"text": text, "state": "ready"}))


def discard_draft(state: AudienceState) -> AudienceState:
    return _doc(state, draft=None)


def air(state: AudienceState, duration_s: int, now: float) -> AudienceState:
    draft = state.doc.draft
    if draft is None:
        raise AudienceError(409, "draft", "There is no answer to put on air.")
    answer = draft.text.strip()
    if not answer:
        raise AudienceError(422, "text", "Write an answer before putting it on air.")
    if not 10 <= duration_s <= 120:
        raise AudienceError(422, "duration_s", "An answer stays on air for 10 to 120 seconds.")
    question = _question(state, draft.question_id)
    state = _swap(state, question.model_copy(update={"state": "answered", "answer": answer}))
    answered = [q for q in state.doc.questions if q.state == "answered"]
    for surplus in answered[: max(0, len(answered) - MAX_ANSWERED)]:
        state = _without(state, surplus.id)
    on_air = QaOnAir(
        question_id=question.id,
        question=question.text,
        nickname=question.nickname,
        answer=answer,
        ends_at=now + duration_s,
    )
    return _doc(state, qa=on_air, draft=None)


def clear_qa(state: AudienceState) -> AudienceState:
    return _doc(state, qa=None)


# --- deadlines ---------------------------------------------------------------------------------


def next_deadline(state: AudienceState) -> float | None:
    times = []
    poll = state.doc.poll
    if poll is not None and poll.state == "open" and poll.closes_at is not None:
        times.append(poll.closes_at)
    if state.doc.qa is not None:
        times.append(state.doc.qa.ends_at)
    return min(times) if times else None


def expire(state: AudienceState, now: float) -> AudienceState:
    """Settle everything whose time has come. Returns the same object when nothing was due."""
    poll = state.doc.poll
    if poll is not None and poll.state == "open" and poll.closes_at is not None and poll.closes_at <= now:
        state = close_poll(state)
    if state.doc.qa is not None and state.doc.qa.ends_at <= now:
        state = clear_qa(state)
    return state


# --- views -------------------------------------------------------------------------------------


def _ordered(questions: list[Question]) -> list[Question]:
    return sorted(questions, key=lambda q: (-q.votes, q.asked_at))


def studio_view(state: AudienceState, now: float) -> Audience:
    return state.doc.model_copy(update={"server_time": now, "questions": _ordered(state.doc.questions)})


def fan_view(state: AudienceState, now: float) -> Audience:
    """What fans may see: no hidden questions and no draft."""
    visible = [question for question in state.doc.questions if question.state != "hidden"]
    return state.doc.model_copy(update={"server_time": now, "questions": _ordered(visible), "draft": None})


# --- saving ------------------------------------------------------------------------------------


def dump(state: AudienceState) -> dict:
    return {
        "doc": state.doc.model_dump(mode="json"),
        "poll_votes": dict(state.poll_votes),
        "upvotes": {question_id: sorted(voters) for question_id, voters in state.upvotes.items()},
        "authors": dict(state.authors),
    }


def load(raw: dict) -> AudienceState:
    doc = Audience.model_validate(raw["doc"])
    poll_votes, upvotes, authors = raw.get("poll_votes", {}), raw.get("upvotes", {}), raw.get("authors", {})
    if not all(isinstance(part, dict) for part in (poll_votes, upvotes, authors)):
        raise ValueError("the audience record is malformed")
    return AudienceState(
        doc=doc,
        poll_votes=dict(poll_votes),
        authors=dict(authors),
        upvotes={question_id: frozenset(voters) for question_id, voters in upvotes.items()},
    )
