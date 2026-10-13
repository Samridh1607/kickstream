import asyncio

import pytest

from kickstream.adapters.json_record_store import JsonRecordStore
from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.adapters.scripted_reels import ScriptedReelProducer
from kickstream.broadcasts.rules import BroadcastError
from kickstream.broadcasts.service import BroadcastService
from kickstream.broadcasts.stage import BroadcastStage
from kickstream.contracts import Output, Recording
from kickstream.domain.errors import Refusal
from kickstream.ports.bus import INSIGHTS
from tests.broadcast_fakes import FakeCutter, FakeProducer
from tests.factories import moment
from tests.output_fakes import FakeNow, until
from tests.test_broadcast_rules import destination, output

T0 = 5_000.0
FILE = "2026-10-13-140000-rec.mp4"


class FakeOutput:
    def __init__(self) -> None:
        self.doc = output()
        self.calls: list[str] = []
        self.refuse: Refusal | None = None
        self._listeners: set[asyncio.Event] = set()

    def view(self) -> Output:
        return self.doc

    async def changes(self):
        listener = asyncio.Event()
        self._listeners.add(listener)
        try:
            yield self.doc
            while True:
                await listener.wait()
                listener.clear()
                yield self.doc
        finally:
            self._listeners.discard(listener)

    def set(self, doc: Output) -> None:
        self.doc = doc
        for listener in self._listeners:
            listener.set()

    def ensure_recording(self) -> None:
        self.calls.append("ensure_recording")

    def start(self) -> None:
        if self.refuse is not None:
            raise self.refuse
        self.calls.append("start")

    async def stop(self) -> None:
        self.calls.append("stop")
        self.set(output(recordings=self.doc.recordings))


class Rig:
    def __init__(self, tmp_path, *, producer=None, cutter=None) -> None:
        self.tmp_path = tmp_path
        self.output = FakeOutput()
        self.now = FakeNow(T0)
        self.producer = producer
        self.cutter = cutter or FakeCutter()
        self.ids = iter(f"id{n}" for n in range(1000))
        self.service = self.make()

    def make(self) -> BroadcastService:
        return BroadcastService(
            JsonRecordStore(self.tmp_path / "broadcasts.json"),
            output=self.output,
            producer=self.producer,
            fallback=ScriptedReelProducer(),
            cutter=self.cutter,
            recordings_dir=self.tmp_path / "recordings",
            reels_dir=self.tmp_path / "reels",
            now=self.now,
            new_id=lambda: next(self.ids),
            producer_timeout_s=0.2,
        )

    def broadcast(self, broadcast_id="id0"):
        return next(b for b in self.service.view().broadcasts if b.id == broadcast_id)

    async def record(self, length_s=120.0) -> None:
        """Go live with a recording destination, play `length_s`, and stop: the recording is listed."""
        self.output.set(output("live", T0, [destination("rec", "file", status="live", live_since=T0)]))
        await until(lambda: self.broadcast().state == "live")
        self.now.at = T0 + length_s
        recordings = self.tmp_path / "recordings"
        recordings.mkdir(exist_ok=True)
        (recordings / FILE).write_bytes(b"x" * 4096)
        recording = Recording(file=FILE, size_bytes=4096, made_at=T0 + length_s)
        self.output.set(output(destinations=[destination("rec", "file")], recordings=[recording]))


@pytest.fixture
async def rig(tmp_path):
    made = Rig(tmp_path)
    task = asyncio.create_task(made.service.run())
    yield made
    task.cancel()
    await made.service.stop()


async def settle() -> None:
    for _ in range(5):
        await asyncio.sleep(0)


def test_a_broadcast_is_saved_and_there_after_a_restart(tmp_path):
    first = Rig(tmp_path)
    first.service.create("Derby day", "notes", True)
    again = first.make()
    assert [(b.id, b.title, b.state) for b in again.view().broadcasts] == [("id0", "Derby day", "ready")]
    assert again.view().current_id == "id0" and again.view().ai is False
    assert Rig(tmp_path, producer=FakeProducer()).service.view().ai is True


def test_going_live_turns_the_recording_on_and_starts_the_stream(tmp_path):
    rig = Rig(tmp_path)
    recorded = rig.service.create("With recording", "", True)
    rig.service.go_live(recorded)
    assert rig.output.calls == ["ensure_recording", "start"]
    rig.output.calls.clear()
    plain = rig.service.create("Without", "", False)
    rig.service.go_live(plain)
    assert rig.output.calls == ["start"]


def test_a_stream_that_cannot_start_says_why(tmp_path):
    rig = Rig(tmp_path)
    rig.output.refuse = Refusal(409, "destinations", "Turn on at least one destination first.")
    with pytest.raises(Refusal, match="Turn on"):
        rig.service.go_live(rig.service.create("x", "", False))


async def test_the_session_follows_the_output_and_end_stops_the_stream(rig):
    rig.service.create("Derby day", "", True)
    rig.output.set(output("live", T0, [destination(status="live")]))
    await until(lambda: rig.broadcast().state == "live")
    rig.now.at = T0 + 90
    await rig.service.end("id0")
    assert "stop" in rig.output.calls
    broadcast = rig.broadcast()
    assert broadcast.state == "ended" and broadcast.stats.live_s == 90
    assert broadcast.sessions[0].destinations[0].outcome == "live"


async def test_ending_a_broadcast_that_never_went_live_does_not_touch_the_stream(rig):
    rig.service.create("Never mind", "", True)
    await rig.service.end("id0")
    assert rig.output.calls == [] and rig.broadcast().state == "ready"
    with pytest.raises(BroadcastError) as missing:
        await rig.service.end("nope")
    assert missing.value.status == 404


async def test_the_match_is_kept_while_live(rig, tmp_path):
    bus = InMemoryEventBus()
    stage = BroadcastStage(bus, rig.service)
    running = asyncio.create_task(stage.run())
    try:
        rig.service.create("Derby day", "", True)
        rig.output.set(output("live", T0, [destination()]))
        await until(lambda: rig.broadcast().state == "live")
        rig.now.at = T0 + 30
        await bus.publish(INSIGHTS, "m-1", moment(1, minute=12))
        await until(lambda: rig.broadcast().moments)
    finally:
        running.cancel()
    broadcast = rig.broadcast()
    assert [(m.id, m.at) for m in broadcast.moments] == [("m-1-k1", T0 + 30)]


async def test_reels_are_written_by_the_agents_and_cut_from_the_recording(tmp_path):
    rig = Rig(tmp_path, producer=FakeProducer())
    task = asyncio.create_task(rig.service.run())
    try:
        rig.service.create("Derby day", "", True)
        await settle()
        await rig.record(length_s=120)
        await until(lambda: rig.broadcast().recordings)
        await rig.service.end("id0")
        rig.service.generate_reels("id0")
        assert rig.broadcast().generating is True
        await until(lambda: not rig.broadcast().generating)
    finally:
        task.cancel()
    broadcast = rig.broadcast()
    # No key moments: the recording's two minutes give three parts, 15 s around their middles.
    assert [(r.title, r.state, r.agent, r.start_s, r.duration_s) for r in broadcast.reels] == [
        ("Agent part-1", "ready", "AI agents", 12.0, 15.0),
        ("Agent part-2", "ready", "AI agents", 52.0, 15.0),
        ("Agent part-3", "ready", "AI agents", 92.0, 15.0),
    ]
    assert broadcast.reels[0].hashtags == ["#Agent", "#Reel"]
    assert all(cut[0] == tmp_path / "recordings" / FILE for cut in rig.cutter.cuts)
    reel = broadcast.reels[0]
    assert rig.service.reel_file("id0", reel.id) == tmp_path / "reels" / "id0" / f"{reel.id}.mp4"
    assert rig.service.recording_file("id0", FILE) == tmp_path / "recordings" / FILE
    assert rig.service.recording_file("id0", "../broadcasts.json") is None
    assert rig.service.reel_file("other", reel.id) is None


@pytest.mark.parametrize(
    "producer", [FakeProducer(fails=RuntimeError("model down")), FakeProducer(stalls=True)]
)
async def test_when_the_agents_fail_or_stall_the_templates_write_the_reels(tmp_path, producer):
    rig = Rig(tmp_path, producer=producer)
    task = asyncio.create_task(rig.service.run())
    try:
        rig.service.create("Derby day", "", True)
        await settle()
        await rig.record()
        await until(lambda: rig.broadcast().recordings)
        await rig.service.end("id0")
        rig.service.generate_reels("id0")
        await until(lambda: not rig.broadcast().generating)
    finally:
        task.cancel()
    assert {r.agent for r in rig.broadcast().reels} == {"template"}
    assert rig.broadcast().reels[0].title == "Derby day · Part 1 of 3"


async def test_a_clip_that_cannot_be_cut_is_marked_failed_and_the_rest_are_made(rig):
    rig.service.create("Derby day", "", True)
    await settle()
    await rig.record()
    await until(lambda: rig.broadcast().recordings)
    await rig.service.end("id0")
    rig.cutter.fails_at = 12.0
    rig.service.generate_reels("id0")
    await until(lambda: not rig.broadcast().generating)
    reels = rig.broadcast().reels
    assert [(r.state, r.reason) for r in reels] == [
        ("failed", "ffmpeg could not cut the clip: broken"),
        ("ready", None),
        ("ready", None),
    ]


async def test_reels_need_ffmpeg(rig):
    rig.service.create("Derby day", "", True)
    rig.cutter.missing = "ffmpeg was not found."
    with pytest.raises(BroadcastError) as refused:
        rig.service.generate_reels("id0")
    assert (refused.value.status, refused.value.message) == (503, "ffmpeg was not found.")


async def test_deleting_a_reel_or_a_broadcast_removes_its_files(rig, tmp_path):
    rig.service.create("Derby day", "", True)
    await settle()
    await rig.record()
    await until(lambda: rig.broadcast().recordings)
    await rig.service.end("id0")
    rig.service.generate_reels("id0")
    await until(lambda: not rig.broadcast().generating)
    first, *rest = rig.broadcast().reels
    rig.service.delete_reel("id0", first.id)
    assert not (tmp_path / "reels" / "id0" / f"{first.id}.mp4").exists()
    assert [r.id for r in rig.broadcast().reels] == [r.id for r in rest]
    rig.service.delete("id0")
    assert not (tmp_path / "reels" / "id0").exists()
    assert (tmp_path / "recordings" / FILE).exists()  # the recording is the output's, and stays
    assert rig.service.view().broadcasts == []
