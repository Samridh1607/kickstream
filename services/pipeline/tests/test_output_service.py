import asyncio
import itertools

import pytest

from kickstream.adapters.json_record_store import JsonRecordStore
from kickstream.output.rules import OutputError
from kickstream.output.service import OutputService, capture_address
from kickstream.ports.output import Quality, Target
from tests.output_fakes import FakeCapture, FakeEncoder, FakeNow, FakeSender, Sleeps, until

KEY = "sk-live-abcd-1234-wxyz"


class Kit:
    def __init__(self, tmp_path, **over) -> None:
        self.tmp_path = tmp_path
        self.capture, self.encoder, self.sleeps, self.now = FakeCapture(), FakeEncoder(), Sleeps(), FakeNow()
        self.senders: list[FakeSender] = []
        self.sender_options: dict = {}
        tokens = (f"token-{n}" for n in itertools.count(1))
        self.options = {
            "capture": self.capture,
            "encoder": self.encoder,
            "new_sender": lambda: FakeSender(self.senders, **self.sender_options),
            "program_url": "http://web.test/studio?output",
            "recordings_dir": tmp_path / "recordings",
            "now": self.now,
            "sleep": self.sleeps,
            "new_token": lambda: next(tokens),
            **over,
        }
        self.service = self.build()

    def build(self) -> OutputService:
        return OutputService(
            JsonRecordStore(self.tmp_path / "output.json"),
            JsonRecordStore(self.tmp_path / "output-keys.json", private=True),
            **self.options,
        )

    def doc(self):
        return self.service.view()

    def status(self, index=0):
        return self.doc().destinations[index].status

    async def live(self) -> None:
        """Start, and let the encoder produce its first piece of stream."""
        self.service.start()
        await until(lambda: self.capture.started)
        self.encoder.emit(b"first")
        await until(lambda: self.doc().state == "live")


@pytest.fixture
def kit(tmp_path):
    return Kit(tmp_path)


def refused(change):
    with pytest.raises(OutputError) as caught:
        change()
    return caught.value.status, caught.value.field


def add_youtube(kit, name="YouTube"):
    kit.service.add_destination(name, "youtube", "", KEY)
    return kit.doc().destinations[-1].id


async def test_start_is_refused_with_nothing_enabled_or_something_missing(kit):
    assert refused(kit.service.start) == (409, "destinations")
    add_youtube(kit)
    kit.encoder.missing = "ffmpeg was not found."
    with pytest.raises(OutputError) as caught:
        kit.service.start()
    assert (caught.value.status, caught.value.message) == (503, "ffmpeg was not found.")
    kit.encoder.missing, kit.capture.missing = None, "No browser was found."
    assert refused(kit.service.start) == (503, "output")
    assert kit.doc().state == "idle" and kit.encoder.started == []


def test_the_token_is_added_to_the_program_address_keeping_its_query():
    assert capture_address("http://h:1/studio?output", "t1") == "http://h:1/studio?output=&capture=t1"
    assert capture_address("http://h:1/program", "t1") == "http://h:1/program?capture=t1"
    assert (
        capture_address("http://h:1/studio?output&capture=old", "t2")
        == "http://h:1/studio?output=&capture=t2"
    )


async def test_going_live_starts_the_encoder_then_the_page_then_a_sender_per_enabled_destination(kit):
    first = add_youtube(kit)
    kit.service.add_destination("Recording", "file", "", "")
    kit.service.add_destination("Spare", "custom", "rtmp://spare.example/app", "spare-key-000000")
    spare = kit.doc().destinations[2]
    kit.service.edit_destination(spare.id, name="Spare", url=spare.url, enabled=False)

    kit.service.start()
    assert kit.doc().state == "starting"
    assert refused(kit.service.start) == (409, "output")
    await until(lambda: kit.capture.started)
    assert kit.encoder.started == [Quality(1280, 720, 3000)]
    assert kit.capture.started == [("http://web.test/studio?output=&capture=token-1", 1280, 720)]
    assert kit.senders == []

    kit.encoder.emit(b"first")
    await until(lambda: len(kit.senders) == 2 and all(s.written for s in kit.senders))
    assert (kit.doc().state, kit.doc().started_at) == ("live", 5_000.0)
    assert kit.senders[0].target == Target("rtmp", f"rtmp://a.rtmp.youtube.com/live2/{KEY}")
    assert kit.senders[1].target.kind == "file"
    assert str(kit.tmp_path / "recordings") in kit.senders[1].target.location
    assert [s.written for s in kit.senders] == [[b"first"], [b"first"]]
    assert [d.status for d in kit.doc().destinations] == ["connecting", "connecting", "idle"]

    kit.now.at = 5_010.0
    kit.senders[0].go_live()
    assert (kit.status(0), kit.doc().destinations[0].live_since) == ("live", 5_010.0)
    assert kit.doc().destinations[0].id == first
    await kit.service.stop()


async def test_the_chosen_quality_sizes_the_encoder_and_the_page(kit):
    add_youtube(kit)
    kit.service.set_quality("1080p30")
    await kit.live()
    assert kit.encoder.started == [Quality(1920, 1080, 6000)]
    assert kit.capture.started[0][1:] == (1920, 1080)
    await kit.service.stop()


async def test_one_destination_failing_is_retried_without_touching_another(kit):
    add_youtube(kit)
    kit.service.add_destination("Other", "custom", "rtmp://other.example/app", "other-key-00000000")
    await kit.live()
    await until(lambda: len(kit.senders) == 2)
    for sender in kit.senders:
        sender.go_live()
    kit.sleeps.gate.clear()
    kit.senders[0].exit(f"Error opening rtmp://a.rtmp.youtube.com/live2/{KEY}: refused")
    await until(lambda: kit.status(0) == "retrying")
    reason = kit.doc().destinations[0].reason
    assert "refused" in reason and KEY not in reason
    assert kit.senders[0].stopped
    assert kit.status(1) == "live" and not kit.senders[1].stopped
    assert kit.sleeps.asked == [2]
    kit.sleeps.gate.set()
    await until(lambda: len(kit.senders) == 3 and kit.status(0) == "connecting")
    kit.encoder.emit(b"more")
    await until(lambda: kit.senders[2].written == [b"more"] and kit.senders[1].written[-1] == b"more")
    await kit.service.stop()


async def test_a_destination_that_keeps_failing_is_left_alone_after_ten_tries(kit):
    add_youtube(kit)
    kit.sender_options = {"exits_with": "Connection refused"}
    await kit.live()
    await until(lambda: kit.status() == "failed")
    assert len(kit.senders) == 10
    assert kit.sleeps.asked == [2, 4, 8, 16, 30, 30, 30, 30, 30]
    assert kit.doc().destinations[0].reason == "Connection refused"
    assert kit.doc().state == "live"
    await kit.service.stop()
    assert kit.status() == "failed"


async def test_time_live_resets_the_count_of_failures(kit):
    add_youtube(kit)
    await kit.live()
    for round_number in range(3):
        await until(lambda n=round_number: len(kit.senders) == n + 1)
        kit.senders[-1].go_live()
        kit.senders[-1].exit("dropped")
    await until(lambda: len(kit.senders) == 4)
    assert kit.sleeps.asked == [2, 2, 2]
    await kit.service.stop()


async def test_a_destination_that_falls_too_far_behind_is_restarted(tmp_path):
    kit = Kit(tmp_path, buffer_s=0.0001)  # room for about 39 bytes
    add_youtube(kit)
    kit.sender_options = {"blocked": True}
    await kit.live()
    await until(lambda: len(kit.senders) == 1)
    kit.sender_options = {}
    kit.sleeps.gate.clear()
    for _ in range(4):
        kit.encoder.emit(b"p" * 30)
    await until(lambda: kit.status() == "retrying")
    assert "behind" in kit.doc().destinations[0].reason
    assert kit.senders[0].stopped
    kit.sleeps.gate.set()
    await kit.service.stop()


async def test_the_browser_dying_restarts_the_whole_run_once(kit):
    add_youtube(kit)
    await kit.live()
    await until(lambda: len(kit.senders) == 1)
    kit.capture.die()
    await until(lambda: len(kit.capture.started) == 2)
    assert kit.doc().state == "starting" and kit.status() == "connecting"
    assert kit.capture.token == "token-2"
    assert len(kit.encoder.started) == 2 and kit.senders[0].stopped
    kit.encoder.emit(b"again")
    await until(lambda: kit.doc().state == "live" and len(kit.senders) == 2)

    kit.now.at += 59
    kit.capture.die()
    await until(lambda: kit.doc().state == "idle")
    assert kit.doc().problem == "The hidden browser stopped."
    assert len(kit.capture.started) == 2 and kit.senders[1].stopped
    assert not kit.service.accepts("token-2")


async def test_a_failure_long_after_the_last_one_restarts_again(kit):
    add_youtube(kit)
    await kit.live()
    kit.encoder.die()
    await until(lambda: len(kit.encoder.started) == 2)
    kit.encoder.emit(b"again")
    await until(lambda: kit.doc().state == "live")
    kit.now.at += 61
    kit.encoder.die()
    await until(lambda: len(kit.encoder.started) == 3)
    assert kit.doc().state == "starting" and kit.doc().problem is None
    await kit.service.stop()


async def test_no_video_within_the_start_limit_stops_the_run(tmp_path):
    kit = Kit(tmp_path, start_timeout_s=0.05)
    add_youtube(kit)
    kit.service.start()
    await until(lambda: kit.doc().state == "idle")
    assert "did not start" in kit.doc().problem
    assert len(kit.capture.started) == 1 and kit.capture.stopped == 1 and kit.encoder.stopped == 1


async def test_a_page_that_cannot_capture_stops_the_run_with_its_reason(kit):
    add_youtube(kit)
    kit.capture.fails = "The program page did not start."
    kit.service.start()
    await until(lambda: kit.doc().state == "idle")
    assert kit.doc().problem == "The program page did not start."
    assert len(kit.encoder.started) == 1 and kit.encoder.stopped == 1


async def test_stop_ends_everything_and_lists_the_recording(kit):
    add_youtube(kit)
    kit.service.add_destination("Recording", "file", "", "")
    await kit.live()
    await until(lambda: len(kit.senders) == 2)
    kit.senders[1].go_live()
    await kit.service.stop()
    assert kit.doc().state == "idle" and kit.doc().problem is None
    assert [d.status for d in kit.doc().destinations] == ["idle", "idle"]
    assert all(sender.stopped for sender in kit.senders)
    assert kit.capture.stopped == 1 and kit.encoder.stopped == 1
    [recording] = kit.doc().recordings
    assert recording.file.endswith(".mp4") and recording.size_bytes == 2048 and recording.made_at == 5_000.0
    await kit.service.stop()  # stopping when idle does nothing
    kit.service.start()  # and a new run can begin
    await kit.service.stop()
    assert kit.doc().state == "idle"


async def test_only_the_current_run_s_page_may_send_video(kit):
    add_youtube(kit)
    assert not kit.service.accepts("")
    await kit.live()
    assert kit.service.accepts("token-1")
    assert not kit.service.accepts("token-0") and not kit.service.accepts("")

    async def chunks(*pieces):
        for piece in pieces:
            yield piece

    await kit.service.feed("token-0", chunks(b"stale"))
    assert kit.encoder.written == []
    await kit.service.feed("token-1", chunks(b"one", b"two"))
    assert kit.encoder.written == [b"one", b"two"]
    # The page's socket closing while live means the page stopped: the run restarts.
    await until(lambda: len(kit.capture.started) == 2)
    assert not kit.service.accepts("token-1") and kit.service.accepts("token-2")
    await kit.service.stop()


async def test_a_token_that_is_not_plain_text_is_refused_not_an_error(kit):
    add_youtube(kit)
    await kit.live()
    assert not kit.service.accepts("é") and not kit.service.accepts("token-1é")
    assert kit.service.accepts("token-1")

    async def chunks():
        yield b"never"

    await kit.service.feed("é", chunks())
    assert kit.encoder.written == []
    await kit.service.stop()


async def test_an_old_page_finishing_does_not_disturb_the_run_that_replaced_it(kit):
    add_youtube(kit)
    await kit.live()
    release = asyncio.Event()

    async def old_page():
        yield b"old"
        await release.wait()
        yield b"late"

    feeding = asyncio.create_task(kit.service.feed("token-1", old_page()))
    await until(lambda: kit.encoder.written == [b"old"])
    kit.capture.die()
    await until(lambda: len(kit.capture.started) == 2)
    kit.encoder.emit(b"again")
    await until(lambda: kit.doc().state == "live")

    release.set()
    await feeding
    assert kit.encoder.written == [b"old"]  # the late piece never reached the new encoder
    kit.encoder.emit(b"still")
    await until(lambda: kit.senders[-1].written[-1:] == [b"still"])
    assert kit.doc().state == "live" and len(kit.capture.started) == 2
    await kit.service.stop()


async def test_destinations_survive_a_restart_with_their_keys_and_nothing_running(kit):
    dest_id = add_youtube(kit)
    kit.service.set_quality("1080p30")
    await kit.live()
    assert KEY not in kit.doc().model_dump_json()
    assert KEY not in (kit.tmp_path / "output.json").read_text(encoding="utf-8")
    again = kit.build()
    assert again.view().state == "idle" and again.view().quality == "1080p30"
    assert (again.view().destinations[0].id, again.view().destinations[0].key_hint) == (dest_id, "wxyz")
    again.start()  # the key came back with it
    await again.stop()
    assert again.view().state == "idle"
    await kit.service.stop()


async def test_a_corrupt_file_is_set_aside_and_the_output_starts_empty(tmp_path):
    (tmp_path / "output.json").write_text('{"doc": {"revision": "x"}}', encoding="utf-8")
    kit = Kit(tmp_path)
    assert kit.doc().destinations == []
    assert (tmp_path / "output.json.corrupt").exists()


async def test_a_change_that_cannot_be_saved_is_refused_and_not_applied(kit, monkeypatch):
    def fail(self, record):
        raise OSError("disk full")

    monkeypatch.setattr(JsonRecordStore, "save", fail)
    assert refused(lambda: add_youtube(kit)) == (503, "output")
    assert kit.doc().destinations == [] and kit.doc().revision == 0


async def test_pages_get_the_document_now_and_after_each_change(kit):
    stream = kit.service.changes()
    assert (await anext(stream)).revision == 0
    add_youtube(kit)
    assert [d.name for d in (await anext(stream)).destinations] == ["YouTube"]
    await stream.aclose()


async def test_stopping_right_after_starting_leaves_the_service_idle_and_startable(kit):
    add_youtube(kit)
    kit.service.start()
    await kit.service.stop()
    assert kit.doc().state == "idle" and kit.doc().problem is None
    assert not kit.service.accepts("token-1")
    kit.service.start()
    await kit.service.stop()
    assert kit.doc().state == "idle"


async def test_a_second_stop_during_clean_up_skips_nothing(kit):
    add_youtube(kit)
    kit.sender_options = {"stop_takes": 0.05}
    await kit.live()
    await until(lambda: len(kit.senders) == 1)
    first = asyncio.create_task(kit.service.stop())
    await asyncio.sleep(0.01)
    second = asyncio.create_task(kit.service.stop())
    await asyncio.sleep(0.01)
    kit.service._run.cancel()  # even a cancel from outside (app shutdown) must not cut the clean-up short
    await asyncio.gather(first, second)
    assert kit.doc().state == "idle"
    assert kit.capture.stopped == 1 and kit.encoder.stopped == 1 and kit.senders[0].stopped


async def test_cancelling_the_caller_of_stop_does_not_abort_the_clean_up(kit):
    add_youtube(kit)
    kit.sender_options = {"stop_takes": 0.05}
    await kit.live()
    await until(lambda: len(kit.senders) == 1)
    caller = asyncio.create_task(kit.service.stop())
    await asyncio.sleep(0.01)
    caller.cancel()
    await asyncio.gather(caller, return_exceptions=True)
    await until(lambda: kit.doc().state == "idle")
    assert kit.capture.stopped == 1 and kit.encoder.stopped == 1 and kit.senders[0].stopped


@pytest.mark.parametrize("where", ["start", "write", "stop"])
async def test_a_sender_failing_in_an_unexpected_way_is_retried_like_any_other(kit, where, caplog):
    add_youtube(kit)
    kit.service.add_destination("Other", "custom", "rtmp://other.example/app", "other-key-00000000")
    kit.sender_options = {"fails_in": where, "only": "youtube"}
    kit.sleeps.gate.clear()  # hold the retry so the failed state can be seen
    await kit.live()
    await until(lambda: len(kit.senders) == 2)
    kit.senders[1].go_live()
    if where == "stop":
        kit.senders[0].exit("dropped")
    await until(lambda: kit.status(0) == "retrying")
    assert kit.doc().destinations[0].reason and KEY not in kit.doc().destinations[0].reason
    assert kit.status(1) == "live" and not kit.senders[1].stopped
    assert KEY not in caplog.text
    kit.sleeps.gate.set()
    await until(lambda: len(kit.senders) >= 3)
    await kit.service.stop()


async def test_an_unexpected_error_in_the_run_is_reported_not_swallowed(kit):
    add_youtube(kit)
    kit.capture.crash = RuntimeError("browser exploded")
    kit.service.start()
    await until(lambda: kit.doc().state == "idle")
    assert kit.doc().problem == "The stream stopped unexpectedly."
    assert kit.encoder.stopped == 1
    kit.capture.crash = None
    kit.service.start()  # nothing is left wedged
    await kit.service.stop()


async def test_one_part_failing_to_stop_does_not_stop_the_others_being_stopped(kit):
    add_youtube(kit)
    kit.capture.stop_raises = True
    await kit.live()
    await until(lambda: len(kit.senders) == 1)
    await kit.service.stop()
    assert kit.doc().state == "idle"
    assert kit.capture.stopped == 1 and kit.encoder.stopped == 1 and kit.senders[0].stopped


@pytest.mark.parametrize("platform", ["youtube", "file"])
async def test_stopping_while_a_dropped_sender_is_being_stopped_still_stops_it(kit, platform):
    if platform == "youtube":
        add_youtube(kit)
    else:
        kit.service.add_destination("Recording", "file", "", "")
    kit.sender_options = {"stop_takes": 0.05}
    await kit.live()
    await until(lambda: len(kit.senders) == 1)
    kit.senders[0].exit("dropped")
    await asyncio.sleep(0.01)  # the relay is now inside its sender's slow stop
    await kit.service.stop()
    assert kit.senders[0].stopped and kit.doc().state == "idle"
    assert kit.capture.stopped == 1 and kit.encoder.stopped == 1
    assert len(kit.doc().recordings) == (1 if platform == "file" else 0)


async def test_a_sender_that_cannot_even_be_made_is_retried(tmp_path):
    made: list[FakeSender] = []
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("no sender for rtmp://x/" + KEY)
        return FakeSender(made)

    kit = Kit(tmp_path, new_sender=flaky)
    add_youtube(kit)
    kit.sleeps.gate.clear()
    await kit.live()
    await until(lambda: kit.status() == "retrying")
    assert kit.doc().destinations[0].reason and KEY not in kit.doc().destinations[0].reason
    kit.sleeps.gate.set()
    await until(lambda: len(made) == 1 and kit.status() == "connecting")
    await kit.service.stop()
