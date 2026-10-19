import shutil
import subprocess

import pytest

from kickstream.adapters.agent_reels import AgentReelProducer, editor_prompt
from kickstream.adapters.ffmpeg_clips import FfmpegClipCutter, clip_args
from kickstream.adapters.model_client import openai_compatible
from kickstream.adapters.scripted_reels import ScriptedReelProducer
from kickstream.broadcasts import reels
from kickstream.contracts import (
    Broadcast,
    BroadcastMoment,
    BroadcastRecording,
    BroadcastScore,
    BroadcastStats,
)
from kickstream.ports.reels import ClipFailure, ReelBrief, ReelCandidate, ReelPick
from tests.fake_llm import FakeLLM

T0 = 1_000_000.0
needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is not installed")


def recording(started_at=T0, length_s=300.0) -> BroadcastRecording:
    return BroadcastRecording(
        file="2026-10-13-140000-rec.mp4", size_bytes=1, started_at=started_at, made_at=started_at + length_s
    )


def broadcast_moment(id_, kind, at, minute=10, team="home", commentary=None) -> BroadcastMoment:
    return BroadcastMoment(
        id=id_, kind=kind, team=team, minute=minute, at=at, score_home=1, score_away=0, commentary=commentary
    )


def broadcast(moments=(), recordings=(), score=True) -> Broadcast:
    stats = BroadcastStats(
        live_s=300,
        score=BroadcastScore(home="Northbridge FC", away="Harbour City", score_home=2, score_away=1)
        if score
        else None,
    )
    return Broadcast(
        id="b1",
        title="Derby day",
        description="The big one",
        record=True,
        state="ended",
        created_at=T0,
        sessions=[],
        recordings=list(recordings),
        moments=list(moments),
        stats=stats,
        reels=[],
        generating=False,
    )


# --- candidates and times ----------------------------------------------------------------------


def test_candidates_are_the_key_moments_inside_the_recording_with_their_offset():
    moments = [
        broadcast_moment("before", "goal", T0 - 5),
        broadcast_moment("k1", "goal", T0 + 42.5, minute=23, commentary="Top corner!"),
        broadcast_moment("k2", "red_card", T0 + 200, minute=60, team="away"),
        broadcast_moment("after", "goal", T0 + 400),
    ]
    found = reels.candidates(broadcast(moments), recording())
    assert [(c.id, c.offset_s) for c in found] == [("k1", 42.5), ("k2", 200.0)]
    assert found[0].label == "23' Goal · Northbridge FC (1-0)"
    assert (found[0].team, found[0].commentary, found[1].team) == (
        "Northbridge FC",
        "Top corner!",
        "Harbour City",
    )


@pytest.mark.parametrize(("length", "parts"), [(30, 1), (90, 2), (600, 3)])
def test_a_recording_without_moments_offers_evenly_spaced_parts(length, parts):
    found = reels.candidates(broadcast(), recording(length_s=length))
    assert [c.id for c in found] == [f"part-{n + 1}" for n in range(parts)]
    assert found[0].offset_s == pytest.approx(length / parts / 2)
    assert all(c.kind is None for c in found)


def test_the_main_recording_is_the_longest():
    short, long = recording(length_s=10), recording(T0 + 20, 200).model_copy(update={"file": "b.mp4"})
    assert reels.latest_recording(broadcast(recordings=[short, long])).file == "b.mp4"
    assert reels.latest_recording(broadcast()) is None


@pytest.mark.parametrize(
    ("offset", "length", "expected"),
    [(42, 300, (34, 15)), (3, 300, (0, 15)), (298, 300, (285, 15)), (5, 9, (0, 9))],
)
def test_a_reel_is_fifteen_seconds_around_its_moment_inside_the_recording(offset, length, expected):
    assert reels.window(offset, length) == expected


def test_the_brief_carries_the_score_and_no_more_picks_than_there_is_room_for():
    found = reels.candidates(broadcast(), recording())
    brief = reels.brief(broadcast(), found, max_reels=2)
    assert (brief.title, brief.score, brief.max_reels) == ("Derby day", "Northbridge FC 2-1 Harbour City", 2)
    assert reels.brief(broadcast(score=False), found, 10).max_reels == reels.MAX_PICKS


# --- what a producer may hand back -------------------------------------------------------------


CANDIDATES = [ReelCandidate("k1", "Goal", 10), ReelCandidate("k2", "Chance", 50)]


def test_only_known_candidates_are_kept_once_each_with_tidy_text():
    picks = [
        ReelPick("nope", "Made up", "", ()),
        ReelPick("k1", "  What   a goal ", "c" * 400, ("#goal", "Big Win!", "goal", "", "##")),
        ReelPick("k1", "Again", "", ()),
        ReelPick("k2", "   ", "", ()),
    ]
    kept = reels.checked(picks, CANDIDATES, limit=4)
    assert len(kept) == 1
    assert kept[0].title == "What a goal"
    assert len(kept[0].caption) == reels.MAX_CAPTION and kept[0].caption.endswith("…")
    assert kept[0].hashtags == ("#Goal", "#BigWin")


def test_no_more_picks_than_the_limit():
    picks = [ReelPick("k1", "a", "", ()), ReelPick("k2", "b", "", ())]
    assert [p.candidate_id for p in reels.checked(picks, CANDIDATES, limit=1)] == ["k1"]


# --- the template producer ---------------------------------------------------------------------


def brief(candidates, max_reels=4, score="Northbridge FC 2-1 Harbour City") -> ReelBrief:
    return ReelBrief("Derby day", "The big one", score, tuple(candidates), max_reels)


async def test_templates_pick_goals_first_then_keep_the_picks_in_order_of_play():
    found = [
        ReelCandidate("p", "Pressure", 10, "sustained_pressure", 5, "Harbour City"),
        ReelCandidate("g", "Goal", 90, "goal", 30, "Northbridge FC", "Top corner!"),
        ReelCandidate("c", "Chance", 50, "big_chance", 20, "Harbour City"),
    ]
    picks = await ScriptedReelProducer().produce(brief(found, max_reels=2))
    assert [p.candidate_id for p in picks] == ["c", "g"]
    goal = picks[1]
    assert goal.title == "GOAL! Northbridge FC score in the 30'"
    assert goal.caption == "Top corner! Final score: Northbridge FC 2-1 Harbour City."
    assert "Goal" in goal.hashtags and "Northbridge FC" in goal.hashtags


async def test_templates_write_plain_parts_from_the_broadcast():
    picks = await ScriptedReelProducer().produce(
        brief([ReelCandidate("part-1", "Part 1 of 1", 15)], score=None)
    )
    assert picks[0].title == "Derby day · Part 1 of 1" and picks[0].caption == "The big one"
    assert (
        reels.checked(picks, [ReelCandidate("part-1", "Part 1 of 1", 15)], 4)[0].hashtags[0] == "#Kickstream"
    )


# --- the agents --------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def server():
    fake = FakeLLM()
    fake.start()
    yield fake
    fake.stop()


@pytest.fixture
def llm(server):
    server.reset()
    return server


def producer(llm) -> AgentReelProducer:
    return AgentReelProducer(openai_compatible(llm.base_url, "fake-model", "test-key"), "fake-model")


FOUND = [
    ReelCandidate("k1", "23' Goal · Northbridge FC (1-0)", 40, "goal", 23, "Northbridge FC", "Top corner!"),
    ReelCandidate("k2", "60' Red card · Harbour City (1-0)", 200, "red_card", 60, "Harbour City"),
    ReelCandidate("k3", "80' Big chance · Harbour City (1-0)", 250, "big_chance", 80, "Harbour City"),
]


async def test_the_editor_picks_and_the_copywriter_writes_each_pick(llm):
    picks = await producer(llm).produce(brief(FOUND, max_reels=2))
    assert [call["role"] for call in llm.calls] == ["highlight_editor", "social_copywriter"]
    # The fake editor lists the moments last first; the first two are kept.
    assert [(p.candidate_id, p.title, p.caption) for p in picks] == [
        ("k3", "Title k3", "Caption k3"),
        ("k2", "Title k2", "Caption k2"),
    ]
    assert picks[0].hashtags == ("#Fake", "goal")
    editor = llm.calls[0]["user"]
    assert "Choose at most 2." in editor and "[k1] 23' Goal · Northbridge FC (1-0): Top corner!" in editor
    assert "Final score: Northbridge FC 2-1 Harbour City" in editor
    writer = llm.calls[1]["user"]
    assert "[k3]" in writer and "editor's note: why k3" in writer and "[k1]" not in writer


async def test_an_editor_that_picks_nothing_known_is_a_failure(llm):
    llm.replies["highlight_editor"] = '{"picks": [{"id": "made-up"}]}'
    with pytest.raises(ValueError, match="no known moment"):
        await producer(llm).produce(brief(FOUND))


async def test_a_copywriter_reply_without_reels_is_a_failure(llm):
    llm.replies["social_copywriter"] = '{"posts": []}'
    with pytest.raises(ValueError, match="no reels"):
        await producer(llm).produce(brief(FOUND))


def test_the_editor_prompt_lists_each_candidate_on_its_own_line():
    prompt = editor_prompt(brief(FOUND))
    assert prompt.splitlines()[-3:] == [
        "[k1] 23' Goal · Northbridge FC (1-0): Top corner!",
        "[k2] 60' Red card · Harbour City (1-0)",
        "[k3] 80' Big chance · Harbour City (1-0)",
    ]


# --- cutting clips -----------------------------------------------------------------------------


def test_a_clip_is_vertical_with_the_whole_picture_over_a_blurred_fill_and_starts_playing_at_once(tmp_path):
    args = clip_args(tmp_path / "in.mp4", 12.5, 15, tmp_path / "out.mp4")
    assert args[args.index("-ss") + 1] == "12.50" and args.index("-ss") < args.index("-i")
    assert args[args.index("-t") + 1] == "15.00"
    graph = args[args.index("-filter_complex") + 1]
    assert "crop=1080:1920" in graph and "boxblur" in graph and "overlay=(W-w)/2:(H-h)/2" in graph
    assert args[args.index("-movflags") + 1] == "+faststart"
    assert args[args.index("-c:v") + 1] == "libx264"


def test_a_missing_ffmpeg_is_reported_in_words():
    assert FfmpegClipCutter("no-such-ffmpeg-binary").available().startswith("ffmpeg was not found")


async def test_a_missing_recording_is_reported_in_words(tmp_path):
    with pytest.raises(ClipFailure, match="no longer on this computer"):
        await FfmpegClipCutter().cut(tmp_path / "gone.mp4", 0, 5, tmp_path / "out.mp4")


@pytest.fixture(scope="module")
def sample(tmp_path_factory):
    """Six seconds of 1280x720 test picture and tone, as the recordings are made."""
    path = tmp_path_factory.mktemp("sample") / "sample.mp4"
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
            "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
            "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-y", str(path),
        ],
        check=True,
    )  # fmt: skip
    return path


def probe(path) -> dict:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration",
            "-of", "json", str(path),
        ],
        check=True, capture_output=True, text=True,
    ).stdout  # fmt: skip
    import json

    return json.loads(out)


@needs_ffmpeg
async def test_a_real_clip_is_a_vertical_mp4_of_the_stretch_asked_for(sample, tmp_path):
    out = tmp_path / "reels" / "r1.mp4"
    size = await FfmpegClipCutter().cut(sample, 1.0, 3.0, out)
    assert size == out.stat().st_size > 10_000
    assert not (tmp_path / "reels" / "r1.part.mp4").exists()
    if shutil.which("ffprobe"):
        found = probe(out)
        video = next(s for s in found["streams"] if s["codec_type"] == "video")
        assert (video["codec_name"], video["width"], video["height"]) == ("h264", 1080, 1920)
        assert any(s["codec_type"] == "audio" and s["codec_name"] == "aac" for s in found["streams"])
        assert float(found["format"]["duration"]) == pytest.approx(3.0, abs=0.3)


@needs_ffmpeg
async def test_a_file_ffmpeg_cannot_read_is_a_failure_with_its_reason(tmp_path):
    broken = tmp_path / "broken.mp4"
    broken.write_bytes(b"not a video")
    with pytest.raises(ClipFailure, match="ffmpeg could not cut the clip"):
        await FfmpegClipCutter().cut(broken, 0, 3, tmp_path / "out.mp4")
    assert not (tmp_path / "out.mp4").exists()
