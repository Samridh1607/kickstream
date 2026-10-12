import pytest

from kickstream.audience import rules
from kickstream.audience.rules import AudienceError, empty_state
from kickstream.contracts import Audience

NOW = 1_000.0
ANN, BEN, CAT = "voter-ann-0000001", "voter-ben-0000002", "voter-cat-0000003"


def refused(status, field):
    return pytest.raises(AudienceError, check=lambda e: (e.status, e.field) == (status, field))


def with_poll(duration=None, options=("Home", "Draw", "Away")):
    return rules.create_poll(empty_state(), "Who will win?", list(options), duration, NOW)


def counts(state):
    return [option.votes for option in state.doc.poll.options]


def asked(state, voter, text, at=NOW, nickname=""):
    return rules.ask(state, voter, text, nickname, at)


def qid(state, text):
    return next(q.id for q in state.doc.questions if q.text == text)


# --- voters ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "voter",
    [
        None,
        "",
        "short",
        "x" * 65,
        "has spaces in the id!",
        "tab\tin-the-identifier",
        "<script>alert(1)</script>",
    ],
)
def test_a_missing_or_malformed_voter_id_is_refused(voter):
    with refused(422, "voter"):
        rules.check_voter(voter)


def test_a_well_formed_voter_id_is_accepted():
    assert rules.check_voter(ANN) == ANN
    assert rules.check_voter("0f8fad5b-d9cb-469f-a165-70867728950e") == "0f8fad5b-d9cb-469f-a165-70867728950e"


# --- polls -----------------------------------------------------------------------------------


def test_a_new_poll_is_open_with_no_votes_and_off_air():
    state = with_poll(duration=60)
    poll = state.doc.poll
    assert (poll.question, poll.state, poll.closes_at) == ("Who will win?", "open", NOW + 60)
    assert [(o.text, o.votes) for o in poll.options] == [("Home", 0), ("Draw", 0), ("Away", 0)]
    assert len({o.id for o in poll.options}) == 3 and state.doc.poll_on_air is False
    assert with_poll().doc.poll.closes_at is None


@pytest.mark.parametrize(
    "question, options, duration, field",
    [
        ("   ", ["A", "B"], None, "question"),
        ("x" * 141, ["A", "B"], None, "question"),
        ("Q?", ["Only"], None, "options"),
        ("Q?", list("ABCDEFG"), None, "options"),
        ("Q?", ["A", "  "], None, "options"),
        ("Q?", ["A", "x" * 61], None, "options"),
        ("Q?", ["Same", " same "], None, "options"),
        ("Q?", ["A", "B"], 29, "duration_s"),
        ("Q?", ["A", "B"], 601, "duration_s"),
    ],
    ids=[
        "blank-question",
        "long-question",
        "one-option",
        "seven-options",
        "blank-option",
        "long-option",
        "duplicate-options",
        "too-short",
        "too-long",
    ],
)
def test_a_poll_outside_the_limits_is_refused(question, options, duration, field):
    with refused(422, field):
        rules.create_poll(empty_state(), question, options, duration, NOW)


def test_creating_a_poll_archives_the_current_one_closed_and_takes_it_off_air():
    state = with_poll()
    first = state.doc.poll
    state = rules.set_poll_on_air(rules.vote(state, ANN, first.options[0].id), True)
    state = rules.create_poll(state, "Next goal?", ["Home", "Away"], None, NOW + 5)
    assert state.doc.poll.question == "Next goal?" and state.doc.poll_on_air is False
    assert [(p.id, p.state, p.options[0].votes) for p in state.doc.history] == [(first.id, "closed", 1)]
    assert state.poll_votes == {}, "votes for the old poll do not carry into the new one"


def test_history_keeps_the_twenty_newest_polls():
    state = empty_state()
    for n in range(rules.MAX_HISTORY + 3):
        state = rules.create_poll(state, f"Poll {n}?", ["A", "B"], None, NOW + n)
    assert len(state.doc.history) == rules.MAX_HISTORY
    assert state.doc.history[0].question == f"Poll {rules.MAX_HISTORY + 1}?"


@pytest.mark.parametrize(
    "language, question, options",
    [
        ("en", "Who will win?", ["Northbridge FC", "Draw", "Harbour City"]),
        ("es", "¿Quién ganará?", ["Northbridge FC", "Empate", "Harbour City"]),
        ("hi", "कौन जीतेगा?", ["Northbridge FC", "ड्रॉ", "Harbour City"]),
    ],
)
def test_the_winner_preset_is_built_from_the_match_in_the_program_language(language, question, options):
    poll = rules.preset_poll(
        empty_state(), "winner", "Northbridge FC", "Harbour City", language, 60, NOW
    ).doc.poll
    assert (poll.question, [o.text for o in poll.options], poll.closes_at) == (question, options, NOW + 60)


def test_the_next_goal_preset_offers_both_teams_and_no_more_goals():
    poll = rules.preset_poll(
        empty_state(), "next_goal", "Northbridge FC", "Harbour City", "en", None, NOW
    ).doc.poll
    assert (poll.question, [o.text for o in poll.options]) == (
        "Who scores next?",
        ["Northbridge FC", "Harbour City", "No more goals"],
    )


def test_closing_and_showing_a_poll():
    state = rules.set_poll_on_air(with_poll(), True)
    assert state.doc.poll_on_air is True
    closed = rules.close_poll(state)
    assert (closed.doc.poll.state, closed.doc.poll_on_air) == ("closed", True), (
        "a closed poll can stay on air"
    )
    with refused(409, "poll"):
        rules.close_poll(closed)
    with refused(409, "poll"):
        rules.close_poll(empty_state())
    with refused(409, "poll"):
        rules.set_poll_on_air(empty_state(), True)
    assert rules.set_poll_on_air(empty_state(), False).doc.poll_on_air is False


def test_an_earlier_poll_can_be_brought_back_closed():
    state = with_poll()
    first = state.doc.poll
    state = rules.vote(state, ANN, first.options[2].id)
    state = rules.create_poll(state, "Second?", ["A", "B"], None, NOW)
    second = state.doc.poll
    state = rules.restore_poll(state, first.id)
    assert (state.doc.poll.id, state.doc.poll.state, state.doc.poll.options[2].votes) == (
        first.id,
        "closed",
        1,
    )
    assert [p.id for p in state.doc.history] == [second.id]
    with refused(409, "poll"):
        rules.vote(state, BEN, first.options[0].id)
    with refused(404, "poll"):
        rules.restore_poll(state, "nope")


# --- voting ----------------------------------------------------------------------------------


def test_a_vote_counts_once_and_a_second_vote_from_the_same_browser_moves_it():
    state = with_poll()
    home, draw, away = (o.id for o in state.doc.poll.options)
    state = rules.vote(state, ANN, home)
    assert rules.vote(state, ANN, home) is state, "voting again for the same option changes nothing"
    state = rules.vote(rules.vote(state, BEN, home), ANN, away)
    assert counts(state) == [1, 0, 1]
    assert state.poll_votes == {ANN: away, BEN: home}
    for _ in range(5):
        state = rules.vote(rules.vote(state, ANN, draw), ANN, away)
    assert counts(state) == [1, 0, 1] and min(counts(state)) >= 0


def test_votes_are_refused_when_there_is_no_open_poll_or_the_option_is_not_in_it():
    with refused(409, "poll"):
        rules.vote(empty_state(), ANN, "o1")
    state = with_poll()
    old_option = state.doc.poll.options[0].id
    with refused(409, "poll"):
        rules.vote(rules.close_poll(state), ANN, old_option)
    replaced = rules.create_poll(state, "New?", ["A", "B"], None, NOW)
    with refused(409, "option"):
        rules.vote(replaced, ANN, "an-option-from-nowhere")


def test_option_ids_differ_between_polls_so_a_replayed_vote_cannot_land_on_a_new_poll():
    first = with_poll()
    second = rules.create_poll(first, "New?", ["A", "B", "C"], None, NOW)
    assert not {o.id for o in first.doc.poll.options} & {o.id for o in second.doc.poll.options}
    with refused(409, "option"):
        rules.vote(second, ANN, first.doc.poll.options[0].id)


# --- questions -------------------------------------------------------------------------------


def test_a_question_starts_with_its_authors_vote_and_a_default_nickname():
    state = asked(empty_state(), ANN, "  Why the substitution?  ")
    [question] = state.doc.questions
    assert (question.text, question.nickname, question.votes, question.state, question.asked_at) == (
        "Why the substitution?",
        "Fan",
        1,
        "open",
        NOW,
    )
    assert state.upvotes[question.id] == frozenset({ANN}) and state.authors[question.id] == ANN
    named = asked(empty_state(), BEN, "Who is pressing?", nickname="  Benny  ")
    assert named.doc.questions[0].nickname == "Benny"


@pytest.mark.parametrize(
    "text, nickname, field", [("   ", "", "text"), ("x" * 201, "", "text"), ("ok?", "x" * 25, "nickname")]
)
def test_a_question_outside_the_limits_is_refused(text, nickname, field):
    with refused(422, field):
        rules.ask(empty_state(), ANN, text, nickname, NOW)


def test_markup_in_a_question_is_kept_as_plain_text():
    state = asked(empty_state(), ANN, "<script>alert(1)</script> <b>why?</b>")
    assert state.doc.questions[0].text == "<script>alert(1)</script> <b>why?</b>"


def test_a_browser_can_ask_again_only_after_thirty_seconds():
    state = asked(empty_state(), ANN, "First?")
    with pytest.raises(
        AudienceError, check=lambda e: (e.status, e.field, e.retry_after) == (429, "text", 18)
    ):
        asked(state, ANN, "Second?", at=NOW + 12.5)
    asked(state, BEN, "Someone else?", at=NOW + 1)
    assert len(asked(state, ANN, "Second?", at=NOW + 30).doc.questions) == 2


def test_the_same_open_question_from_the_same_browser_is_refused():
    state = asked(empty_state(), ANN, "Why the change?")
    with refused(409, "text"):
        asked(state, ANN, "  why THE change?", at=NOW + 60)
    assert len(asked(state, BEN, "Why the change?", at=NOW + 60).doc.questions) == 2


def test_upvotes_toggle_and_the_author_cannot_add_to_their_own():
    state = asked(empty_state(), ANN, "Why?")
    question = state.doc.questions[0].id
    assert rules.upvote(state, ANN, question) is state
    state = rules.upvote(rules.upvote(state, BEN, question), CAT, question)
    assert state.doc.questions[0].votes == 3
    state = rules.upvote(state, BEN, question)
    assert state.doc.questions[0].votes == 2 and state.upvotes[question] == frozenset({ANN, CAT})
    for _ in range(4):
        state = rules.upvote(state, BEN, question)
    assert state.doc.questions[0].votes == 2
    with refused(404, "question"):
        rules.upvote(state, BEN, "nope")


def test_hidden_and_answered_questions_cannot_be_upvoted():
    state = asked(empty_state(), ANN, "Why?")
    question = state.doc.questions[0].id
    with refused(409, "question"):
        rules.upvote(rules.hide(state, question), BEN, question)


def test_hiding_keeps_votes_and_can_be_undone():
    state = asked(empty_state(), ANN, "Why?")
    question = state.doc.questions[0].id
    state = rules.upvote(state, BEN, question)
    hidden = rules.hide(state, question)
    assert (hidden.doc.questions[0].state, hidden.doc.questions[0].votes) == ("hidden", 2)
    assert rules.unhide(hidden, question).doc.questions[0].state == "open"
    with refused(404, "question"):
        rules.hide(state, "nope")


def test_a_full_list_drops_the_open_question_with_the_fewest_votes_oldest_first():
    state = empty_state()
    for n in range(rules.MAX_ACTIVE_QUESTIONS):
        state = asked(state, f"voter-number-{n:07d}", f"Question {n}?", at=NOW + n)
    first, second = qid(state, "Question 0?"), qid(state, "Question 1?")
    state = rules.hide(rules.upvote(state, CAT, second), first)
    state = asked(state, ANN, "One more?", at=NOW + 500)
    texts = {q.text for q in state.doc.questions}
    assert len(state.doc.questions) == rules.MAX_ACTIVE_QUESTIONS
    assert "Question 2?" not in texts, "the oldest open question with one vote went"
    assert {"Question 0?", "Question 1?", "One more?"} <= texts, "hidden and better-voted questions stay"
    assert qid(state, "One more?") in state.upvotes and len(state.upvotes) == rules.MAX_ACTIVE_QUESTIONS


# --- the expert draft and going on air ---------------------------------------------------------


def one_question():
    state = asked(empty_state(), ANN, "Why the change?", nickname="Ann")
    return state, state.doc.questions[0].id


def test_a_draft_starts_writing_when_the_expert_is_available_and_unavailable_otherwise():
    state, question = one_question()
    assert rules.start_draft(state, question, True).doc.draft.model_dump() == {
        "question_id": question,
        "text": "",
        "state": "writing",
    }
    assert rules.start_draft(state, question, False).doc.draft.state == "unavailable"
    with refused(404, "question"):
        rules.start_draft(state, "nope", True)


def test_the_experts_answer_fills_the_draft_it_was_written_for():
    state, question = one_question()
    ready = rules.finish_draft(
        rules.start_draft(state, question, True), question, "  Fresh legs for the press.  "
    )
    assert (ready.doc.draft.text, ready.doc.draft.state) == ("Fresh legs for the press.", "ready")
    failed = rules.finish_draft(rules.start_draft(state, question, True), question, None)
    assert (failed.doc.draft.text, failed.doc.draft.state) == ("", "unavailable")
    long = rules.finish_draft(rules.start_draft(state, question, True), question, "x" * 900)
    assert len(long.doc.draft.text) == rules.MAX_ANSWER


def test_an_answer_that_arrives_too_late_is_ignored():
    state, question = one_question()
    state = asked(state, BEN, "Who is pressing?", at=NOW + 1)
    other = qid(state, "Who is pressing?")
    writing = rules.start_draft(state, question, True)

    discarded = rules.discard_draft(writing)
    assert rules.finish_draft(discarded, question, "Late.") is discarded

    moved_on = rules.start_draft(writing, other, True)
    assert rules.finish_draft(moved_on, question, "Late.") is moved_on

    typed = rules.set_draft_text(writing, "The streamer's own answer.")
    assert rules.finish_draft(typed, question, "Late.") is typed
    assert typed.doc.draft.state == "ready"


def test_the_draft_can_be_edited_within_its_limit():
    state, question = one_question()
    draft = rules.start_draft(state, question, False)
    assert rules.set_draft_text(draft, "Typed by hand.").doc.draft.model_dump() == {
        "question_id": question,
        "text": "Typed by hand.",
        "state": "ready",
    }
    with refused(422, "text"):
        rules.set_draft_text(draft, "x" * 401)
    with refused(409, "draft"):
        rules.set_draft_text(state, "No draft yet.")


def test_putting_an_answer_on_air_marks_the_question_answered_and_clears_the_draft():
    state, question = one_question()
    state = rules.set_draft_text(rules.start_draft(state, question, False), "  Fresh legs.  ")
    aired = rules.air(state, 30, NOW + 10)
    assert aired.doc.qa.model_dump() == {
        "question_id": question,
        "question": "Why the change?",
        "nickname": "Ann",
        "answer": "Fresh legs.",
        "ends_at": NOW + 40,
    }
    assert (aired.doc.questions[0].state, aired.doc.questions[0].answer, aired.doc.draft) == (
        "answered",
        "Fresh legs.",
        None,
    )


@pytest.mark.parametrize(
    "text, duration, status, field",
    [
        ("", 30, 422, "text"),
        ("   ", 30, 422, "text"),
        ("ok", 9, 422, "duration_s"),
        ("ok", 121, 422, "duration_s"),
    ],
)
def test_airing_needs_text_and_a_duration_in_range(text, duration, status, field):
    state, question = one_question()
    state = rules.start_draft(state, question, False)
    if text.strip():
        state = rules.set_draft_text(state, text)
    with refused(status, field):
        rules.air(state, duration, NOW)


def test_airing_with_no_draft_or_for_a_question_that_is_gone_is_refused():
    state, question = one_question()
    with refused(409, "draft"):
        rules.air(state, 30, NOW)
    drafted = rules.set_draft_text(rules.start_draft(state, question, False), "Answer.")
    gone = rules.AudienceState(doc=drafted.doc.model_copy(update={"questions": []}))
    with refused(404, "question"):
        rules.air(gone, 30, NOW)


def test_only_the_fifty_most_recently_answered_questions_are_kept():
    state = empty_state()
    for n in range(rules.MAX_ANSWERED + 2):
        state = asked(state, f"voter-number-{n:07d}", f"Question {n}?", at=NOW + n)
        question = qid(state, f"Question {n}?")
        state = rules.air(
            rules.set_draft_text(rules.start_draft(state, question, False), "Answer."), 30, NOW + n
        )
    answered = [q for q in state.doc.questions if q.state == "answered"]
    assert len(answered) == rules.MAX_ANSWERED and "Question 0?" not in {q.text for q in answered}
    assert len(state.upvotes) == rules.MAX_ANSWERED


# --- deadlines -------------------------------------------------------------------------------


def test_a_timed_poll_closes_and_a_qa_leaves_the_program_when_their_time_comes():
    state, question = one_question()
    state = rules.create_poll(state, "Who will win?", ["A", "B"], 60, NOW)
    state = rules.air(rules.set_draft_text(rules.start_draft(state, question, False), "Answer."), 30, NOW)
    assert rules.next_deadline(state) == NOW + 30
    assert rules.expire(state, NOW + 29.9) is state
    state = rules.expire(state, NOW + 30)
    assert state.doc.qa is None and state.doc.poll.state == "open" and rules.next_deadline(state) == NOW + 60
    state = rules.expire(state, NOW + 60)
    assert state.doc.poll.state == "closed" and rules.next_deadline(state) is None
    assert rules.next_deadline(with_poll()) is None, "an untimed poll has no deadline"


def test_the_qa_can_be_taken_off_early():
    state, question = one_question()
    state = rules.air(rules.set_draft_text(rules.start_draft(state, question, False), "Answer."), 30, NOW)
    assert rules.clear_qa(state).doc.qa is None


# --- views -----------------------------------------------------------------------------------


def test_the_fan_view_orders_questions_and_never_carries_hidden_ones_or_the_draft():
    state = asked(empty_state(), ANN, "Oldest?", at=NOW)
    state = asked(state, BEN, "Popular?", at=NOW + 1)
    state = asked(state, CAT, "Rude one", at=NOW + 2)
    state = rules.upvote(state, ANN, qid(state, "Popular?"))
    state = rules.hide(state, qid(state, "Rude one"))
    state = rules.start_draft(state, qid(state, "Oldest?"), False)

    fan = rules.fan_view(state, NOW + 50)
    assert [q.text for q in fan.questions] == ["Popular?", "Oldest?"]
    assert fan.draft is None and fan.server_time == NOW + 50
    assert "Rude one" not in fan.model_dump_json()

    studio = rules.studio_view(state, NOW + 50)
    assert [q.text for q in studio.questions] == ["Popular?", "Oldest?", "Rude one"]
    assert studio.draft is not None
    assert state.doc.questions[0].text == "Oldest?", "views sort a copy"


# --- saving ----------------------------------------------------------------------------------


def test_state_survives_a_dump_and_load_except_the_ask_timers():
    state = with_poll(duration=60)
    state = rules.vote(state, ANN, state.doc.poll.options[1].id)
    state = asked(state, ANN, "Why?")
    state = rules.upvote(state, BEN, state.doc.questions[0].id)
    loaded = rules.load(rules.dump(state))
    assert (loaded.doc, loaded.poll_votes, loaded.upvotes, loaded.authors) == (
        state.doc,
        state.poll_votes,
        state.upvotes,
        state.authors,
    )
    assert loaded.last_asked == {}
    import json

    assert rules.load(json.loads(json.dumps(rules.dump(state)))).upvotes == state.upvotes


@pytest.mark.parametrize(
    "raw", [{}, {"doc": {"revision": "x"}}, {"doc": None}, {"doc": {}, "poll_votes": []}]
)
def test_a_bad_record_cannot_be_loaded(raw):
    with pytest.raises((ValueError, TypeError, KeyError)):
        rules.load(raw)


def test_an_empty_state_is_a_valid_document():
    assert Audience.model_validate(empty_state().doc.model_dump()) == empty_state().doc
