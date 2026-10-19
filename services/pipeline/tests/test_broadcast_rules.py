import pytest

from kickstream.broadcasts import rules
from kickstream.broadcasts.rules import BroadcastError
from kickstream.contracts import (
    Destination,
    EditedReel,
    MatchStatus,
    Narrative,
    Output,
    Recording,
    Reel,
)
from kickstream.domain.teams import AWAY, HOME
from tests.factories import moment

T0 = 1_000_000.0


def destination(id_="yt", platform="youtube", status="idle", **extra) -> Destination:
    fields = dict(
        id=id_, name=id_.upper(), platform=platform, url="", enabled=True, key_hint="", status=status
    )
    return Destination(**{**fields, **extra})


def output(state="idle", started_at=None, destinations=(), recordings=(), problem=None) -> Output:
    return Output(
        revision=1,
        server_time=0.0,
        destinations=list(destinations),
        quality="720p30",
        state=state,
        started_at=started_at,
        problem=problem,
        recordings=list(recordings),
    )


def created(title="Derby day", record=True) -> rules.BroadcastsState:
    return rules.create(rules.empty_state(ai=False), "b1", title, "Live from the stadium", record, T0)


def on_air(state=None, at=T0 + 10) -> rules.BroadcastsState:
    state = state or created()
    live = output("live", at, [destination(), destination("rec", "file")])
    return rules.observe_output(state, live, at, "auto")


def status(home=2, away=1) -> MatchStatus:
    return MatchStatus(
        match_id="m-1",
        state="live",
        minute=70,
        score_home=home,
        score_away=away,
        speed=1.0,
        home=HOME,
        away=AWAY,
    )


# --- creating and choosing ---------------------------------------------------------------------


def test_a_new_broadcast_is_ready_and_current_with_its_title_tidied():
    state = rules.create(rules.empty_state(ai=True), "b1", "  Derby   day ", " notes ", True, T0)
    broadcast = state.doc.broadcasts[0]
    assert (broadcast.title, broadcast.description, broadcast.state, broadcast.record) == (
        "Derby day",
        "notes",
        "ready",
        True,
    )
    assert state.doc.current_id == "b1"
    assert state.doc.ai is True


@pytest.mark.parametrize("title", ["", "   ", "x" * 81])
def test_a_broadcast_needs_a_title_of_reasonable_length(title):
    with pytest.raises(BroadcastError) as refused:
        rules.create(rules.empty_state(ai=False), "b1", title, "", True, T0)
    assert (refused.value.status, refused.value.field) == (422, "title")


def test_a_long_description_is_refused():
    with pytest.raises(BroadcastError) as refused:
        rules.create(rules.empty_state(ai=False), "b1", "Title", "x" * 501, True, T0)
    assert refused.value.field == "description"


def test_newest_broadcasts_come_first_and_a_live_one_stays_current():
    state = on_air()
    state = rules.create(state, "b2", "Next week", "", True, T0 + 20)
    assert [b.id for b in state.doc.broadcasts] == ["b2", "b1"]
    assert state.doc.current_id == "b1"


def test_an_ended_broadcast_cannot_go_live_again():
    state = rules.end(on_air(at=T0 + 10), "b1", T0 + 30)
    with pytest.raises(BroadcastError) as refused:
        rules.select(state, "b1")
    assert refused.value.status == 409


def test_ending_a_broadcast_that_never_got_on_air_keeps_it_ready():
    state = created()
    assert rules.end(state, "b1", T0 + 5) is state


def test_another_broadcast_cannot_be_chosen_while_one_is_live():
    state = rules.create(on_air(), "b2", "Other", "", True, T0)
    with pytest.raises(BroadcastError, match="is live"):
        rules.select(state, "b2")


def test_editing_and_deleting():
    state = rules.edit(created(), "b1", "Cup final", "New notes")
    assert state.doc.broadcasts[0].title == "Cup final"
    state = rules.delete(state, "b1")
    assert state.doc.broadcasts == [] and state.doc.current_id is None
    with pytest.raises(BroadcastError) as refused:
        rules.edit(state, "b1", "x", "")
    assert refused.value.status == 404


def test_a_live_broadcast_cannot_be_deleted():
    with pytest.raises(BroadcastError, match="End the broadcast"):
        rules.delete(on_air(), "b1")


# --- following the output ----------------------------------------------------------------------


def test_nothing_happens_while_the_output_is_off_or_starting():
    state = created()
    assert rules.observe_output(state, output(), T0, "auto") is state
    assert rules.observe_output(state, output("starting"), T0, "auto") is state


def test_going_live_opens_a_session_on_the_current_broadcast_with_the_destinations_that_are_on():
    state = created()
    live = output(
        "live",
        T0 + 3,
        [destination(), destination("tw", "twitch", enabled=False), destination("rec", "file")],
    )
    state = rules.observe_output(state, live, T0 + 4, "auto")
    broadcast = state.doc.broadcasts[0]
    assert broadcast.state == "live"
    session = broadcast.sessions[0]
    assert session.started_at == T0 + 3 and session.ended_at is None
    assert [(d.id, d.outcome) for d in session.destinations] == [("yt", "off"), ("rec", "off")]


def test_a_stream_started_without_a_broadcast_is_kept_in_one_made_for_it():
    state = rules.observe_output(rules.empty_state(ai=False), output("live", T0, [destination()]), T0, "auto")
    broadcast = state.doc.broadcasts[0]
    assert broadcast.id == "auto" and broadcast.state == "live"
    assert broadcast.title.startswith("Broadcast · ")
    assert state.doc.current_id == "auto"


def test_each_destination_keeps_how_it_fared():
    state = on_air()
    failing = output(
        "live",
        T0 + 10,
        [destination(status="live"), destination("rec", "file", status="failed", reason="disk full")],
    )
    state = rules.observe_output(state, failing, T0 + 20, "auto")
    # A destination that was live once stays live, even if it fails later.
    later = output("live", T0 + 10, [destination(status="failed", reason="gone"), destination("rec", "file")])
    state = rules.observe_output(state, later, T0 + 30, "auto")
    outcomes = {d.id: (d.outcome, d.reason) for d in state.doc.broadcasts[0].sessions[0].destinations}
    assert outcomes == {"yt": ("live", None), "rec": ("failed", "disk full")}


def test_recordings_made_while_live_are_kept_with_when_they_began():
    state = on_air()
    recording_dest = destination("rec", "file", status="live", live_since=T0 + 11)
    state = rules.observe_output(state, output("live", T0 + 10, [recording_dest]), T0 + 12, "auto")
    old = Recording(file="2026-01-01-000000-rec.mp4", size_bytes=10, made_at=T0 - 100)
    new = Recording(file="2026-10-13-140000-rec.mp4", size_bytes=4096, made_at=T0 + 70)
    stopped = output("idle", None, [destination("rec", "file")], recordings=[new, old])
    state = rules.observe_output(state, stopped, T0 + 71, "auto")
    broadcast = state.doc.broadcasts[0]
    assert [(r.file, r.started_at, r.made_at) for r in broadcast.recordings] == [
        ("2026-10-13-140000-rec.mp4", T0 + 11, T0 + 70)
    ]


def test_a_stream_that_stops_by_itself_leaves_the_broadcast_ready_with_the_reason():
    state = on_air(at=T0 + 10)
    state = rules.observe_output(state, output(problem="The encoder stopped."), T0 + 70, "auto")
    broadcast = state.doc.broadcasts[0]
    assert broadcast.state == "ready" and broadcast.problem == "The encoder stopped."
    assert broadcast.sessions[0].ended_at == T0 + 70
    assert broadcast.stats.live_s == 60
    # Going live again opens a second session on the same broadcast.
    state = rules.observe_output(state, output("live", T0 + 100, [destination()]), T0 + 100, "auto")
    assert len(state.doc.broadcasts) == 1
    assert [s.started_at for s in state.doc.broadcasts[0].sessions] == [T0 + 10, T0 + 100]


def test_a_restart_while_live_does_not_close_the_session():
    state = on_air()
    state = rules.observe_output(state, output("starting", None, [destination()]), T0 + 30, "auto")
    state = rules.observe_output(state, output("live", T0 + 31, [destination()]), T0 + 31, "auto")
    assert len(state.doc.broadcasts[0].sessions) == 1


def test_ending_closes_the_session_and_the_broadcast_and_counts_time_on_air():
    state = rules.end(on_air(at=T0 + 10), "b1", T0 + 130)
    broadcast = state.doc.broadcasts[0]
    assert broadcast.state == "ended" and broadcast.stats.live_s == 120
    assert state.doc.current_id is None
    assert rules.end(state, "b1", T0 + 500) is state


def test_the_view_counts_time_on_air_up_to_now():
    doc = rules.view(on_air(at=T0 + 10), T0 + 55)
    assert doc.broadcasts[0].stats.live_s == 45 and doc.server_time == T0 + 55


# --- the match ---------------------------------------------------------------------------------


def test_the_score_key_moments_and_their_commentary_are_kept_while_live():
    state = rules.observe_status(on_air(), status(2, 1))
    state = rules.observe_moment(state, moment(1, kind="goal", minute=67), T0 + 40)
    state = rules.observe_moment(state, moment(1, kind="goal", minute=67), T0 + 41)  # seen twice
    narrative = Narrative(
        id="n1",
        match_id="m-1",
        minute=67,
        moment_id="m-1-k1",
        mode="fan",
        language="en",
        text="What a strike!",
        source="scripted",
        agent="commentator",
        evidence=[],
        team="home",
    )
    state = rules.observe_narrative(state, narrative)
    state = rules.observe_narrative(state, narrative.model_copy(update={"text": "Again", "language": "es"}))
    broadcast = state.doc.broadcasts[0]
    assert broadcast.stats.score.model_dump() == {
        "home": HOME.name,
        "away": AWAY.name,
        "score_home": 2,
        "score_away": 1,
    }
    assert [(m.id, m.minute, m.at, m.commentary) for m in broadcast.moments] == [
        ("m-1-k1", 67, T0 + 40, "What a strike!")
    ]


def test_the_match_is_ignored_off_air():
    state = created()
    assert rules.observe_status(state, status()) is state
    assert rules.observe_moment(state, moment(), T0) is state


# --- reels -------------------------------------------------------------------------------------


def recorded(length_s=120.0) -> rules.BroadcastsState:
    state = on_air(at=T0 + 10)
    recording = Recording(file="2026-10-13-140000-rec.mp4", size_bytes=4096, made_at=T0 + 10 + length_s)
    stopped = output("idle", None, [destination("rec", "file")], recordings=[recording])
    return rules.end(rules.observe_output(state, stopped, T0 + 10 + length_s, "auto"), "b1", T0 + 200)


def reel(id_="r1", state="rendering") -> Reel:
    return Reel(
        id=id_,
        recording="2026-10-13-140000-rec.mp4",
        start_s=0,
        duration_s=15,
        title="Goal",
        caption="",
        hashtags=[],
        state=state,
        agent="template",
        made_at=T0,
    )


def test_reels_need_a_broadcast_off_air_with_a_long_enough_recording():
    with pytest.raises(BroadcastError, match="off air"):
        rules.begin_reels(on_air(), "b1")
    with pytest.raises(BroadcastError, match="no recording"):
        rules.begin_reels(created(), "b1")
    with pytest.raises(BroadcastError, match="too short"):
        rules.begin_reels(recorded(length_s=1), "b1")
    state = rules.begin_reels(recorded(), "b1")
    assert state.doc.broadcasts[0].generating is True
    with pytest.raises(BroadcastError, match="already"):
        rules.begin_reels(state, "b1")


def test_a_reel_is_added_finished_and_deleted():
    state = rules.add_reel(rules.begin_reels(recorded(), "b1"), "b1", reel())
    with pytest.raises(BroadcastError, match="Wait"):
        rules.delete_reel(state, "b1", "r1")
    state = rules.end_reels(rules.finish_reel(state, "b1", "r1", 5000, None), "b1")
    broadcast = state.doc.broadcasts[0]
    assert (broadcast.reels[0].state, broadcast.reels[0].size_bytes, broadcast.generating) == (
        "ready",
        5000,
        False,
    )
    failed = rules.finish_reel(state, "b1", "r1", None, "ffmpeg failed")
    assert (failed.doc.broadcasts[0].reels[0].state, failed.doc.broadcasts[0].reels[0].reason) == (
        "failed",
        "ffmpeg failed",
    )
    assert rules.delete_reel(state, "b1", "r1").doc.broadcasts[0].reels == []


def test_only_a_finished_reel_takes_an_edited_version_and_can_go_back_to_the_original():
    edit = EditedReel(name="Derby day - edit.mp4", size_bytes=9_000_000, added_at=T0)
    cutting = rules.add_reel(rules.begin_reels(recorded(), "b1"), "b1", reel())
    with pytest.raises(BroadcastError, match="finished") as refused:
        rules.set_edited(cutting, "b1", "r1", edit)
    assert refused.value.status == 409
    with pytest.raises(BroadcastError, match="no longer exists"):
        rules.set_edited(cutting, "b1", "nope", edit)

    ready = rules.finish_reel(cutting, "b1", "r1", 5000, None)
    edited = rules.set_edited(ready, "b1", "r1", edit)
    assert edited.doc.broadcasts[0].reels[0].edited == edit
    assert rules.set_edited(edited, "b1", "r1", None).doc.broadcasts[0].reels[0].edited is None


def test_a_broadcast_keeps_a_limited_number_of_reels():
    state = recorded()
    for n in range(rules.MAX_REELS):
        state = rules.add_reel(state, "b1", reel(f"r{n}", "ready"))
    with pytest.raises(BroadcastError, match="at most"):
        rules.begin_reels(state, "b1")


# --- storage -----------------------------------------------------------------------------------


def test_saved_and_loaded_after_a_restart_nothing_is_live_or_being_made():
    state = rules.add_reel(rules.begin_reels(recorded(), "b1"), "b1", reel())
    state = rules.create(state, "b2", "Second", "", True, T0 + 300)
    state = on_air(state, at=T0 + 310)
    loaded = rules.load(rules.dump(state), ai=True)
    by_id = {b.id: b for b in loaded.doc.broadcasts}
    assert by_id["b2"].state == "ready" and by_id["b2"].problem == rules.CUT_SHORT
    assert by_id["b2"].sessions[0].ended_at == T0 + 310
    assert by_id["b1"].generating is False
    assert (by_id["b1"].reels[0].state, by_id["b1"].reels[0].reason) == ("failed", rules.UNFINISHED)
    assert loaded.doc.ai is True


def test_broadcasts_saved_with_audience_stats_still_load():
    state = rules.create(rules.empty_state(ai=False), "b1", "Derby", "", False, T0)
    record = rules.dump(state)
    record["doc"]["broadcasts"][0]["stats"].update(
        {"polls": [{"id": "p1", "question": "Who wins?", "votes": 7}], "questions": 3}
    )
    loaded = rules.load(record, ai=False)
    assert rules.get(loaded, "b1").stats.live_s == 0.0
    assert rules.get(loaded, "b1").title == "Derby"
    assert "polls" in record["doc"]["broadcasts"][0]["stats"]


def test_a_malformed_saved_file_is_refused_in_a_way_the_service_sets_aside():
    record = {
        "doc": {
            "revision": 0,
            "server_time": 0.0,
            "broadcasts": [{"stats": None}],
            "current_id": None,
            "ai": False,
        }
    }
    with pytest.raises((ValueError, TypeError, KeyError, IndexError)):
        rules.load(record, ai=False)
