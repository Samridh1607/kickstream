import random

import pytest

from kickstream.contracts import FanSettings
from kickstream.fans import rules
from kickstream.fans.rules import FanError
from kickstream.ports.social import IncomingComment, IncomingSuperChat

NOW = 1_000.0


def comment(n, text="Come on!", author=None, platform="x", **extra) -> IncomingComment:
    return IncomingComment(id=f"c{n}", platform=platform, author=author or f"Fan {n}", text=text, **extra)


def paid(n, amount=5.0, name="Asha", currency="USD", message="Go on") -> IncomingSuperChat:
    return IncomingSuperChat(f"s{n}", "youtube", name, amount, currency, message)


def state(x_available=False):
    return rules.empty_state(x_available)


def taken(comments, start=None, now=NOW, demo=False):
    return rules.take_comments(start or state(), comments, now, demo=demo)


# --- comments -----------------------------------------------------------------------------------


def test_a_new_fan_zone_reads_the_demo_feed_and_shows_nothing_by_itself():
    doc = state().doc
    assert (doc.settings.source, doc.source_state, doc.settings.auto_superchat) == ("demo", "demo", False)
    assert doc.summary.text == "No comments yet." and doc.comments == [] and doc.spotlight is None


def test_a_comment_is_taken_once_cleaned_and_marked_with_where_it_came_from():
    first = taken(
        [comment(1, "  What   a\n goal! 🔥 ", handle="@fan1", likes=3), comment(2, "x" * 400)], demo=True
    )
    one, two = first.doc.comments
    assert (one.text, one.handle, one.likes, one.mood, one.demo) == (
        "What a goal! 🔥",
        "@fan1",
        3,
        "positive",
        True,
    )
    assert len(two.text) == 280 and first.doc.summary.total == 2
    again = taken([comment(1, "Different text"), comment(3, "   "), comment(4, "ok", author=" ")], first)
    assert [c.id for c in again.doc.comments] == ["c1", "c2"]


def test_an_unknown_platform_is_filed_under_other_and_a_future_time_is_not_believed():
    doc = taken([comment(1, platform="myspace", at=NOW + 500), comment(2, at=NOW - 30)]).doc
    assert {c.id: (c.platform, c.at) for c in doc.comments} == {"c1": ("other", NOW), "c2": ("x", NOW - 30)}
    assert [c.id for c in doc.comments] == ["c2", "c1"]  # oldest first


@pytest.mark.parametrize(
    "text, mood",
    [
        ("Brilliant pass, pure class", "positive"),
        ("Awful defending, shocking", "negative"),
        ("Great pass but awful refereeing", "neutral"),
        ("Kick-off in five minutes", "neutral"),
        ("😡", "negative"),
    ],
)
def test_mood_is_read_from_the_words_fans_use(text, mood):
    assert rules.mood_of(text) == mood


def test_only_the_newest_comments_are_kept_and_liked_ones_outlive_them():
    full = taken([comment(n, at=NOW - 1000 + n) for n in range(1, 201)])
    liked = rules.like_comment(full, "c1", True)
    more = taken([comment(n) for n in range(201, 211)], liked)
    ids = [c.id for c in more.doc.comments]
    assert len(ids) == 200 and ids[0] == "c1" and "c2" not in ids and ids[-1] == "c210"
    assert more.doc.comments[0].liked is True
    with pytest.raises(FanError) as gone:
        rules.like_comment(more, "c2", True)
    assert gone.value.status == 404


# --- the summary --------------------------------------------------------------------------------


def test_the_summary_gives_the_pace_the_mood_the_topics_and_the_platforms():
    comments = [
        comment(1, "What a goal by Marrowby! #Kickstream", platform="x"),
        comment(2, "Marrowby is brilliant #Kickstream", platform="youtube"),
        comment(3, "Great goal, love it", platform="youtube"),
        comment(4, "Awful from the keeper", platform="twitch"),
        comment(5, "Old news", at=NOW - 500),
    ]
    summary = taken(comments).doc.summary
    assert (summary.per_minute, summary.total) == (2.0, 5)
    assert (summary.mood.positive, summary.mood.neutral, summary.mood.negative) == (75.0, 0.0, 25.0)
    assert [(t.label, t.count) for t in summary.topics[:3]] == [
        ("#kickstream", 2),
        ("Goal", 2),
        ("Marrowby", 2),
    ]
    assert [(s.platform, s.count) for s in summary.platforms] == [("x", 2), ("youtube", 2), ("twitch", 1)]
    assert summary.text == (
        "The chat is quiet (2 a minute) and mostly positive. Talking about #kickstream, Goal, Marrowby."
    )


def test_the_summary_goes_quiet_when_the_comments_are_old():
    old = taken([comment(1)])
    assert rules.refresh(old, NOW + 600).doc.summary.text == "No comments in the last two minutes."
    assert rules.refresh(old, NOW) is old


# --- polls --------------------------------------------------------------------------------------


def with_poll(minutes=None, start=None):
    return rules.open_poll(
        start or state(), " Who wins? ", ["Northbridge", " Harbour ", "", "Draw"], minutes, NOW
    )


def test_a_poll_opens_with_its_options_numbered_and_no_votes():
    poll = with_poll(minutes=5).doc.poll
    assert (poll.question, poll.state, poll.closes_at) == ("Who wins?", "open", NOW + 300)
    assert [(o.id, o.text, o.votes) for o in poll.options] == [
        ("o1", "Northbridge", 0),
        ("o2", "Harbour", 0),
        ("o3", "Draw", 0),
    ]


@pytest.mark.parametrize(
    "question, options, minutes, field",
    [
        ("", ["a", "b"], None, "question"),
        ("q" * 141, ["a", "b"], None, "question"),
        ("Who?", ["only one"], None, "options"),
        ("Who?", list("abcdefg"), None, "options"),
        ("Who?", ["a", "A"], None, "options"),
        ("Who?", ["a", "b" * 61], None, "options"),
        ("Who?", ["a", "b"], 0, "minutes"),
        ("Who?", ["a", "b"], 61, "minutes"),
    ],
)
def test_a_poll_that_breaks_a_limit_is_refused(question, options, minutes, field):
    with pytest.raises(FanError) as refused:
        rules.open_poll(state(), question, options, minutes, NOW)
    assert (refused.value.status, refused.value.field) == (422, field)


def test_fans_vote_by_commenting_a_number_once_each_and_the_last_vote_counts():
    voted = taken(
        [
            comment(1, "1", author="Ana", handle="@ana"),
            comment(2, " #2 ", author="Ben"),
            comment(3, "vote 2", author="Cy"),
            comment(4, "2", author="Ana", handle="@ana"),  # Ana changes her mind
            comment(5, "7", author="Dee"),  # no such option: an ordinary comment
            comment(6, "2 goals already!", author="Eve"),
        ],
        with_poll(),
    )
    assert [o.votes for o in voted.doc.poll.options] == [0, 3, 0]
    assert [c.text for c in voted.doc.comments] == ["7", "2 goals already!"]
    assert rules.pool_names(voted, "voters") == ["Ana", "Ben", "Cy"]


def test_the_same_name_on_two_platforms_is_two_voters():
    voted = taken(
        [comment(1, "1", author="Ana", platform="x"), comment(2, "1", author="Ana", platform="twitch")],
        with_poll(),
    )
    assert voted.doc.poll.options[0].votes == 2


def test_a_closed_poll_takes_no_votes_and_a_new_poll_starts_from_nothing():
    closed = rules.close_poll(taken([comment(1, "1")], with_poll()))
    after = taken([comment(2, "2")], closed)
    assert [o.votes for o in after.doc.poll.options] == [1, 0, 0] and after.doc.comments[-1].text == "2"
    assert rules.close_poll(closed) is closed
    again = with_poll(start=after)
    assert again.votes == {} and sum(o.votes for o in again.doc.poll.options) == 0


def test_a_timed_poll_closes_itself():
    poll = with_poll(minutes=1)
    assert rules.next_deadline(poll) == NOW + 60
    assert rules.expire(poll, NOW + 59) is poll
    assert rules.expire(poll, NOW + 60).doc.poll.state == "closed"


def test_a_poll_goes_on_air_and_off_and_cannot_go_on_air_when_there_is_none():
    on = rules.set_poll_air(with_poll(), True)
    assert on.doc.poll_on_air and rules.set_poll_air(on, True) is on
    removed = rules.remove_poll(on)
    assert removed.doc.poll is None and removed.doc.poll_on_air is False
    with pytest.raises(FanError) as none:
        rules.set_poll_air(state(), True)
    assert none.value.status == 409


def test_the_result_names_the_option_in_front_and_needs_a_vote():
    with pytest.raises(FanError) as empty:
        rules.announce_poll(with_poll(), NOW)
    assert empty.value.message == "No one has voted yet."
    voted = taken([comment(1, "2"), comment(2, "2"), comment(3, "1")], with_poll())
    shown = rules.announce_poll(voted, NOW).doc.spotlight
    assert (shown.kind, shown.title, shown.text, shown.detail) == (
        "poll_result",
        "Who wins?",
        "Harbour",
        "67% of 3 votes",
    )


# --- superchats ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "amount, tier", [(1, 1), (4.99, 1), (5, 2), (10, 3), (20, 4), (49, 4), (50, 5), (900, 5)]
)
def test_a_superchat_is_coloured_by_its_size(amount, tier):
    assert rules.tier_of(amount) == tier


def test_superchats_are_listed_with_the_name_and_added_to_what_was_raised():
    paid_up = rules.take_superchats(
        state(), [paid(1, 5), paid(2, 20, name="Ben"), paid(1, 99)], NOW, demo=False
    )
    assert [(s.name, s.amount, s.tier) for s in paid_up.doc.superchats] == [
        ("Asha", 5.0, 2),
        ("Ben", 20.0, 4),
    ]
    assert [(r.currency, r.amount) for r in paid_up.doc.summary.raised] == [("USD", 25.0)]
    assert paid_up.doc.spotlight is None  # nothing goes on air by itself unless the streamer asks
    assert rules.pool_names(paid_up, "supporters") == ["Asha", "Ben"]


@pytest.mark.parametrize(
    "item",
    [paid(1, 0), paid(1, -5), paid(1, name="  "), paid(1, currency="dollars"), paid(1, currency="U$")],
    ids=["zero", "negative", "no name", "long currency", "odd currency"],
)
def test_a_malformed_superchat_from_a_platform_is_left_out(item):
    assert rules.take_superchats(state(), [item], NOW, demo=False).doc.superchats == []


def test_a_superchat_typed_in_by_the_streamer_is_checked():
    added = rules.add_superchat(state(), " Asha ", 12.345, "inr", "Jai ho", NOW)
    [superchat] = added.doc.superchats
    assert (superchat.name, superchat.amount, superchat.currency, superchat.platform) == (
        "Asha",
        12.35,
        "INR",
        "other",
    )
    with pytest.raises(FanError) as refused:
        rules.add_superchat(state(), "Asha", 0, "USD", "", NOW)
    assert refused.value.status == 422


def test_with_automatic_superchats_each_one_is_thanked_on_air_in_turn():
    auto = rules.set_settings(state(), FanSettings(source="demo", auto_superchat=True))
    shown = rules.take_superchats(
        auto, [paid(1, 50, message="Up the Bridge!"), paid(2, 5, name="Ben")], NOW, demo=False
    )
    first = shown.doc.spotlight
    assert (first.kind, first.name, first.detail, first.text, first.tier) == (
        "superchat",
        "Asha",
        "USD 50.00",
        "Up the Bridge!",
        5,
    )
    assert first.ends_at == NOW + first.duration_s and first.duration_s == 20
    assert [s.name for s in shown.doc.spotlight_queue] == ["Ben"]


# --- the spotlight ------------------------------------------------------------------------------


def test_one_thing_is_on_air_at_a_time_and_the_rest_wait_their_turn():
    chat = rules.take_superchats(taken([comment(1, "What a game")]), [paid(1)], NOW, demo=False)
    one = rules.spotlight_comment(chat, "c1", NOW)
    two = rules.spotlight_superchat(one, "s1", NOW)
    three = rules.spotlight_message(two, "Half-time", " Back in 15 ", 8, NOW)
    assert (three.doc.spotlight.kind, three.doc.spotlight.name, three.doc.spotlight.detail) == (
        "comment",
        "Fan 1",
        "x",
    )
    assert [s.kind for s in three.doc.spotlight_queue] == ["superchat", "message"]
    assert rules.next_deadline(three) == NOW + 10

    later = rules.expire(three, NOW + 10)
    assert later.doc.spotlight.kind == "superchat" and later.doc.spotlight.ends_at == NOW + 10 + 14
    cleared = rules.clear_spotlight(rules.clear_spotlight(later, NOW + 11), NOW + 12)
    assert cleared.doc.spotlight is None and cleared.doc.spotlight_queue == []
    assert rules.clear_spotlight(cleared, NOW) is cleared


def test_what_was_waiting_still_gets_its_full_time_however_late_its_turn_comes():
    queued = rules.spotlight_message(rules.spotlight_message(state(), "", "One", 5, NOW), "", "Two", 5, NOW)
    late = rules.expire(queued, NOW + 3600)
    assert (late.doc.spotlight.text, late.doc.spotlight.ends_at) == ("Two", NOW + 3605)
    assert rules.expire(late, NOW + 3605).doc.spotlight is None


def test_the_waiting_list_keeps_the_newest_ten():
    full = state()
    for n in range(13):
        full = rules.spotlight_message(full, "", f"Message {n}", 5, NOW)
    assert [s.text for s in full.doc.spotlight_queue] == [f"Message {n}" for n in range(3, 13)]


@pytest.mark.parametrize(
    "text, seconds, field",
    [("", 8, "text"), ("   ", 8, "text"), ("Hi", 2, "duration_s"), ("Hi", 61, "duration_s")],
)
def test_a_custom_message_needs_text_and_a_sensible_time(text, seconds, field):
    with pytest.raises(FanError) as refused:
        rules.spotlight_message(state(), "", text, seconds, NOW)
    assert refused.value.field == field


def test_something_that_has_left_the_list_cannot_be_put_on_air():
    for change in (rules.spotlight_comment, rules.spotlight_superchat):
        with pytest.raises(FanError) as gone:
            change(state(), "nope", NOW)
        assert gone.value.status == 404


# --- quick actions ------------------------------------------------------------------------------


def test_a_winner_is_one_name_from_the_pool_and_everyone_has_one_chance():
    chat = taken([comment(1, author="Ana"), comment(2, author="Ana"), comment(3, author="Ben")])
    assert rules.pool_names(chat, "commenters") == ["Ana", "Ben"]
    picks = {
        rules.pick_winner(chat, "commenters", random.Random(seed), NOW).doc.spotlight.name
        for seed in range(20)
    }
    assert picks == {"Ana", "Ben"}
    shown = rules.pick_winner(chat, "commenters", random.Random(1), NOW).doc.spotlight
    assert (shown.kind, shown.title, shown.text) == ("winner", "Winner", "Picked from 2 commenters.")


def test_a_winner_needs_someone_to_pick_from():
    with pytest.raises(FanError) as empty:
        rules.pick_winner(state(), "supporters", random.Random(1), NOW)
    assert (empty.value.status, empty.value.message) == (409, "There are no supporters to pick from yet.")
    with pytest.raises(FanError) as unknown:
        rules.pool_names(state(), "referees")
    assert unknown.value.status == 422


def test_clearing_empties_the_zone_and_keeps_the_settings():
    busy = rules.set_poll_air(taken([comment(1), comment(2, "1")], with_poll()), True)
    busy = rules.spotlight_message(rules.take_superchats(busy, [paid(1)], NOW, demo=False), "", "Hi", 5, NOW)
    emptied = rules.clear(busy, NOW)
    doc = emptied.doc
    assert (doc.comments, doc.superchats, doc.poll, doc.spotlight, doc.poll_on_air) == (
        [],
        [],
        None,
        None,
        False,
    )
    assert (
        emptied.votes == {} and doc.settings == busy.doc.settings and doc.summary.text == "No comments yet."
    )
    # What was cleared stays remembered, so the platform sending it again does not bring it back.
    assert taken([comment(1)], emptied).doc.comments == []


# --- sources ------------------------------------------------------------------------------------


def test_x_can_be_chosen_only_when_it_is_set_up():
    with pytest.raises(FanError) as refused:
        rules.set_settings(state(), FanSettings(source="x", auto_superchat=False))
    assert refused.value.status == 409 and "KICKSTREAM_X_BEARER_TOKEN" in refused.value.message
    chosen = rules.set_settings(state(x_available=True), FanSettings(source="x", auto_superchat=False))
    assert chosen.doc.source_state == "live"
    off = rules.set_settings(chosen, FanSettings(source="off", auto_superchat=False))
    assert off.doc.source_state == "off" and rules.set_settings(off, off.doc.settings) is off


def test_a_source_that_fails_is_reported_and_recovers():
    live = rules.set_settings(state(x_available=True), FanSettings(source="x", auto_superchat=False))
    failing = rules.set_source_health(live, "X's limit on searches was reached.")
    assert (failing.doc.source_state, failing.doc.problem) == (
        "failing",
        "X's limit on searches was reached.",
    )
    assert rules.set_source_health(failing, failing.doc.problem) is failing
    assert rules.set_source_health(failing, None).doc.source_state == "live"
    off = rules.set_settings(live, FanSettings(source="off", auto_superchat=False))
    assert rules.set_source_health(off, "ignored") is off


# --- saving -------------------------------------------------------------------------------------


def test_a_saved_fan_zone_loads_as_it_was():
    busy = rules.set_poll_air(taken([comment(1), comment(2, "1", author="Ana")], with_poll()), True)
    busy = rules.take_superchats(busy, [paid(1)], NOW, demo=False)
    loaded = rules.load(rules.dump(busy), x_available=False)
    assert loaded.doc == busy.doc and loaded.votes == busy.votes
    assert taken([comment(1)], loaded).doc.comments == busy.doc.comments  # still known


def test_a_saved_choice_of_x_falls_back_to_off_when_x_is_no_longer_set_up():
    live = rules.set_settings(state(x_available=True), FanSettings(source="x", auto_superchat=False))
    failing = rules.set_source_health(live, "down")
    loaded = rules.load(rules.dump(failing), x_available=False)
    assert (loaded.doc.settings.source, loaded.doc.source_state, loaded.doc.problem) == ("off", "off", None)
    assert loaded.doc.x_available is False


def test_an_unusable_record_is_reported_not_loaded():
    with pytest.raises((ValueError, TypeError, KeyError)):
        rules.load({"doc": {"revision": "many"}}, x_available=False)
    with pytest.raises((ValueError, TypeError, KeyError)):
        rules.load({}, x_available=False)
