import re
from pathlib import Path

import pytest

from kickstream.output import rules
from kickstream.output.rules import OutputError
from kickstream.ports.output import Quality, Target

KEY = "sk-live-abcd-1234-wxyz"


def refused(change):
    with pytest.raises(OutputError) as caught:
        change()
    return caught.value.status, caught.value.field


def one(platform="youtube", url="", key=KEY, name="Main channel"):
    return rules.add_destination(rules.empty_state(), name, platform, url, key)


def test_the_qualities_are_the_two_the_spec_names():
    assert rules.QUALITIES == {"720p30": Quality(1280, 720, 3000), "1080p30": Quality(1920, 1080, 6000)}


def test_a_known_platform_gets_its_address_and_the_key_is_kept_beside_the_document():
    state = one()
    [dest] = state.doc.destinations
    assert (dest.name, dest.platform, dest.url) == (
        "Main channel",
        "youtube",
        "rtmp://a.rtmp.youtube.com/live2",
    )
    assert (dest.enabled, dest.status, dest.key_hint) == (True, "idle", "wxyz")
    assert state.keys == {dest.id: KEY}
    assert KEY not in rules.view(state, 5.0).model_dump_json()
    assert rules.view(state, 5.0).server_time == 5.0


def test_a_recording_is_switched_on_or_added_when_a_broadcast_asks_for_one():
    added = rules.ensure_recording(one())
    assert [(d.platform, d.name, d.enabled) for d in added.doc.destinations] == [
        ("youtube", "Main channel", True),
        ("file", "Recording", True),
    ]
    assert rules.ensure_recording(added) is added
    file_id = added.doc.destinations[1].id
    off = rules.edit_destination(added, file_id, name="Recording", url="", enabled=False)
    again = rules.ensure_recording(off)
    assert len(again.doc.destinations) == 2 and again.doc.destinations[1].enabled


def test_a_pasted_key_loses_the_spaces_around_it_and_a_short_key_shows_nothing():
    state = one(key=f"  {KEY}\n")
    assert list(state.keys.values()) == [KEY]
    assert one(key="12345678").doc.destinations[0].key_hint == ""


def test_x_and_custom_need_an_address_and_a_file_needs_neither():
    assert refused(lambda: one(platform="x")) == (422, "url")
    assert refused(lambda: one(platform="custom")) == (422, "url")
    assert (
        one(platform="custom", url="rtmps://ingest.example:443/app").doc.destinations[0].url
        == "rtmps://ingest.example:443/app"
    )
    state = one(platform="file", key="", url="rtmp://ignored.example/x")
    assert state.doc.destinations[0].url == "" and state.keys == {}


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/live",
        "rtmp://",
        "rtmp:///app",
        "rtmp://host/a b",
        "rtmp://host/" + "a" * 300,
        "example.com",
    ],
)
def test_an_address_that_is_not_rtmp_to_a_host_is_refused(url):
    assert refused(lambda: one(platform="custom", url=url)) == (422, "url")


@pytest.mark.parametrize("key", ["", "   ", "two words", "a" * 301, "line\nbreak"])
def test_a_key_must_be_1_to_300_characters_without_whitespace(key):
    assert refused(lambda: one(key=key)) == (422, "key")


@pytest.mark.parametrize("name", ["", "   ", "n" * 41])
def test_a_name_must_be_1_to_40_characters(name):
    assert refused(lambda: one(name=name)) == (422, "name")


def test_there_can_be_ten_destinations_and_no_more():
    state = rules.empty_state()
    for n in range(10):
        state = rules.add_destination(state, f"D{n}", "file", "", "")
    assert refused(lambda: rules.add_destination(state, "D10", "file", "", "")) == (409, "destinations")


def test_editing_without_a_key_keeps_the_stored_one_and_a_new_key_replaces_it():
    state = one()
    dest = state.doc.destinations[0]
    kept = rules.edit_destination(state, dest.id, name="Second", url="rtmp://b.example/live", enabled=False)
    assert kept.keys == {dest.id: KEY}
    assert (kept.doc.destinations[0].name, kept.doc.destinations[0].enabled) == ("Second", False)
    assert kept.doc.destinations[0].url == "rtmp://b.example/live"
    replaced = rules.edit_destination(
        state, dest.id, name="Main", url=dest.url, enabled=True, key="new-key-9999-0000"
    )
    assert replaced.keys == {dest.id: "new-key-9999-0000"}
    assert replaced.doc.destinations[0].key_hint == "0000"
    assert refused(lambda: rules.edit_destination(state, "nope", name="x", url="", enabled=True)) == (
        404,
        "destination",
    )


def test_removing_a_destination_removes_its_key():
    state = one()
    gone = rules.remove_destination(state, state.doc.destinations[0].id)
    assert gone.doc.destinations == [] and gone.keys == {}
    assert refused(lambda: rules.remove_destination(state, "nope")) == (404, "destination")


def test_quality_is_one_of_the_two():
    assert rules.set_quality(rules.empty_state(), "1080p30").doc.quality == "1080p30"
    assert refused(lambda: rules.set_quality(rules.empty_state(), "4k")) == (422, "quality")


def test_going_live_needs_an_enabled_destination_with_a_key():
    assert refused(lambda: rules.begin(rules.empty_state())) == (409, "destinations")
    state = one()
    dest = state.doc.destinations[0]
    off = rules.edit_destination(state, dest.id, name=dest.name, url=dest.url, enabled=False)
    assert refused(lambda: rules.begin(off)) == (409, "destinations")
    keyless = rules.OutputState(doc=state.doc, keys={})
    assert refused(lambda: rules.begin(keyless)) == (409, "key")


def test_a_run_moves_through_starting_live_stopping_and_back_to_idle():
    state = rules.add_destination(one(), "Recording", "file", "", "")
    first, second = state.doc.destinations
    state = rules.edit_destination(state, second.id, name="Recording", url="", enabled=False)
    started = rules.begin(state)
    assert started.doc.state == "starting" and started.doc.started_at is None
    assert [d.status for d in started.doc.destinations] == ["connecting", "idle"]
    assert refused(lambda: rules.begin(started)) == (409, "output")
    live = rules.went_live(started, 50.0)
    assert (live.doc.state, live.doc.started_at) == ("live", 50.0)
    assert rules.went_live(live, 60.0) is live
    again = rules.restarting(rules.mark(live, first.id, "live", now=51.0))
    assert again.doc.state == "starting" and again.doc.destinations[0].status == "connecting"
    assert rules.stopping(live).doc.state == "stopping"
    assert rules.stopping(rules.empty_state()).doc.state == "idle"
    done = rules.finish(rules.mark(live, first.id, "live", now=51.0), "The encoder stopped.")
    assert (done.doc.state, done.doc.started_at, done.doc.problem) == ("idle", None, "The encoder stopped.")
    assert done.doc.destinations[0].status == "idle" and done.doc.destinations[0].live_since is None
    assert rules.begin(done).doc.problem is None


@pytest.mark.parametrize("state_name", ["starting", "live", "stopping"])
def test_nothing_can_be_changed_while_a_run_is_in_progress(state_name):
    state = one()
    dest = state.doc.destinations[0]
    busy = rules.OutputState(doc=state.doc.model_copy(update={"state": state_name}), keys=state.keys)
    assert refused(lambda: rules.add_destination(busy, "More", "file", "", "")) == (409, "output")
    assert refused(lambda: rules.edit_destination(busy, dest.id, name="x", url=dest.url, enabled=True)) == (
        409,
        "output",
    )
    assert refused(lambda: rules.remove_destination(busy, dest.id)) == (409, "output")
    assert refused(lambda: rules.set_quality(busy, "1080p30")) == (409, "output")


def test_a_destination_status_carries_its_reason_and_when_it_went_live():
    state = rules.begin(one())
    dest_id = state.doc.destinations[0].id
    live = rules.mark(state, dest_id, "live", now=70.0)
    assert (live.doc.destinations[0].status, live.doc.destinations[0].live_since) == ("live", 70.0)
    retrying = rules.mark(live, dest_id, "retrying", "Connection refused")
    assert (retrying.doc.destinations[0].status, retrying.doc.destinations[0].reason) == (
        "retrying",
        "Connection refused",
    )
    assert rules.mark(state, "gone", "live", now=1.0) is state
    failed = rules.finish(rules.mark(state, dest_id, "failed", "Bad key"), None)
    assert (failed.doc.destinations[0].status, failed.doc.destinations[0].reason) == ("failed", "Bad key")


def test_retries_wait_2_4_8_16_30_and_then_30():
    assert [rules.retry_delay(n) for n in range(1, 9)] == [2, 4, 8, 16, 30, 30, 30, 30]
    assert rules.MAX_FAILURES == 10


def test_a_failure_reason_never_carries_the_key():
    text = f"Error opening output rtmp://a.example/live2/{KEY}: I/O error"
    assert KEY not in rules.redact(text, KEY)
    assert "rtmp://a.example/live2/" in rules.redact(text, KEY)
    assert rules.redact("Plain failure", "") == "Plain failure"
    assert len(rules.redact("x" * 900, KEY)) == 200


def test_a_target_is_the_address_with_the_key_or_a_new_file():
    state = one(platform="custom", url="rtmp://ingest.example/app/")
    dest = state.doc.destinations[0]
    assert rules.target_for(dest, KEY, Path("rec"), 0.0) == Target("rtmp", f"rtmp://ingest.example/app/{KEY}")
    file_dest = one(platform="file", key="").doc.destinations[0]
    target = rules.target_for(file_dest, "", Path("rec"), 1_800_000_000.0)
    assert target.kind == "file"
    assert re.fullmatch(
        rf"\d{{4}}-\d{{2}}-\d{{2}}-\d{{6}}-{re.escape(file_dest.id)}\.mp4", Path(target.location).name
    )
    assert Path(target.location).parent == Path("rec")


def test_two_file_destinations_started_in_the_same_second_get_different_recordings():
    state = rules.add_destination(one(platform="file", key=""), "Second", "file", "", "")
    first, second = state.doc.destinations
    now = 1_800_000_000.0
    a = rules.target_for(first, "", Path("rec"), now)
    b = rules.target_for(second, "", Path("rec"), now)
    assert a.location != b.location
    assert Path(a.location).name.endswith(f"-{first.id}.mp4")
    assert Path(b.location).name.endswith(f"-{second.id}.mp4")


def test_the_twenty_newest_recordings_are_listed_newest_first():
    state = rules.empty_state()
    for n in range(22):
        state = rules.add_recording(state, f"r{n}.mp4", 1000 + n, float(n))
    assert len(state.doc.recordings) == 20
    assert (state.doc.recordings[0].file, state.doc.recordings[0].size_bytes) == ("r21.mp4", 1021)
    assert state.doc.recordings[-1].file == "r2.mp4"


def test_a_saved_state_loads_idle_with_its_keys_and_nothing_secret_in_the_document_record():
    state = rules.went_live(rules.begin(one()), 9.0)
    dest_id = state.doc.destinations[0].id
    state = rules.mark(state, dest_id, "live", now=9.0)
    record, keys = rules.dump(state), rules.dump_keys(state)
    assert KEY not in str(record) and keys == {"keys": {dest_id: KEY}}
    loaded = rules.load(record, keys)
    assert (loaded.doc.state, loaded.doc.started_at, loaded.doc.problem) == ("idle", None, None)
    assert (loaded.doc.destinations[0].status, loaded.doc.destinations[0].live_since) == ("idle", None)
    assert loaded.keys == {dest_id: KEY}


def test_a_destination_whose_key_was_lost_shows_no_key():
    state = one()
    loaded = rules.load(rules.dump(state), None)
    assert loaded.keys == {} and loaded.doc.destinations[0].key_hint == ""
    stray = rules.load(rules.dump(state), {"keys": {"someone-else": "k", state.doc.destinations[0].id: 5}})
    assert stray.keys == {}


def test_a_record_of_the_wrong_shape_cannot_be_loaded():
    with pytest.raises((ValueError, TypeError, KeyError)):
        rules.load({"doc": {"revision": "x"}}, None)
    with pytest.raises((ValueError, TypeError, KeyError)):
        rules.load({}, None)
