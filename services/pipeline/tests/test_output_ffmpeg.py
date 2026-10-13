import asyncio
import json
import shutil
import socket
import subprocess
import sys
import time

import pytest

from kickstream.adapters import ffmpeg
from kickstream.adapters.ffmpeg import FfmpegEncoder, FfmpegSender, encoder_args, sender_args
from kickstream.ports.output import Quality, Target
from tests.output_fakes import until

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is not installed")
QUALITY = Quality(1280, 720, 3000)


def test_the_encoder_is_asked_for_the_chosen_size_rate_and_a_keyframe_every_two_seconds():
    args = encoder_args(QUALITY)
    assert "scale=1280:720,fps=30" in args
    assert args[args.index("-b:v") + 1] == "3000k" and args[args.index("-g") + 1] == "60"
    assert args[args.index("-b:a") + 1] == "128k"
    assert args[-3:] == ["-f", "mpegts", "pipe:1"]


def test_the_encoder_does_not_hold_pictures_back_because_a_still_program_sends_few():
    args = encoder_args(QUALITY)
    # Before the input: it is the decoder's option, and frame threads would delay a one-a-second picture by seconds.
    assert args.index("-flags") < args.index("-i") and args[args.index("-flags") + 1] == "low_delay"


def test_a_sender_copies_without_encoding_to_flv_or_to_a_file_that_plays_if_cut_short():
    rtmp = sender_args(Target("rtmp", "rtmp://host/app/key"))
    assert rtmp[rtmp.index("-c") + 1] == "copy" and rtmp[-3:] == ["-f", "flv", "rtmp://host/app/key"]
    file = sender_args(Target("file", "out.mp4"))
    assert "+frag_keyframe+empty_moov+default_base_moof" in file and file[-1] == "out.mp4"
    assert file[file.index("-c") + 1] == "copy"


def test_a_missing_ffmpeg_is_reported_in_words():
    assert FfmpegEncoder("no-such-ffmpeg-binary").available().startswith("ffmpeg was not found")


@pytest.fixture(scope="module")
def recording(tmp_path_factory):
    """Three seconds of test picture and tone, in the format the program page records."""
    path = tmp_path_factory.mktemp("sample") / "sample.webm"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440",
         "-t", "3", "-c:v", "libvpx", "-b:v", "600k", "-c:a", "libopus", "-f", "webm", str(path)],
        check=True,
    )  # fmt: skip
    return path.read_bytes()


def probe(path) -> list[dict]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    )  # fmt: skip
    return json.loads(out.stdout)["streams"]


@needs_ffmpeg
async def test_a_recording_becomes_an_mp4_at_the_chosen_size_with_sound(tmp_path, recording):
    assert FfmpegEncoder().available() is None
    encoder, sender = FfmpegEncoder(), FfmpegSender()
    target = Target("file", str(tmp_path / "recordings" / "out.mp4"))
    live = []
    await encoder.start(QUALITY)
    await sender.start(target, lambda: live.append(True))

    async def pass_on():
        async for chunk in encoder.output():
            assert len(chunk) % 188 == 0
            await sender.write(chunk)

    passing = asyncio.create_task(pass_on())
    for start in range(0, len(recording), 32_000):
        await encoder.write(recording[start : start + 32_000])
    await until(lambda: live, limit_s=30)
    await asyncio.sleep(1)
    await encoder.stop()
    await asyncio.wait_for(passing, 5)
    await sender.stop()
    await asyncio.wait_for(sender.wait(), 5)

    streams = {stream["codec_name"]: stream for stream in probe(target.location)}
    assert (streams["h264"]["width"], streams["h264"]["height"]) == (1280, 720)
    assert "aac" in streams
    await encoder.write(b"late")  # writing to a stopped encoder is dropped, not an error
    await sender.write(b"late")


@needs_ffmpeg
async def test_a_destination_that_refuses_the_connection_ends_the_sender_with_a_reason(recording):
    with socket.socket() as probe_socket:
        probe_socket.bind(("127.0.0.1", 0))
        port = probe_socket.getsockname()[1]
    encoder, sender = FfmpegEncoder(), FfmpegSender()
    live = []
    await encoder.start(QUALITY)
    await sender.start(Target("rtmp", f"rtmp://127.0.0.1:{port}/live/secret-key"), lambda: live.append(True))

    async def pass_on():
        async for chunk in encoder.output():
            await sender.write(chunk)

    passing = asyncio.create_task(pass_on())
    await encoder.write(recording)
    reason = await asyncio.wait_for(sender.wait(), 30)
    assert reason and not live
    await sender.stop()
    await encoder.stop()
    await asyncio.wait_for(passing, 5)


@needs_ffmpeg
async def test_a_sender_whose_input_ends_finishes_by_itself(tmp_path):
    sender = FfmpegSender(grace_s=0.5)
    await sender.start(Target("file", str(tmp_path / "never.mp4")), lambda: None)
    await asyncio.wait_for(sender.stop(), 5)
    await asyncio.wait_for(sender.wait(), 5)
    await sender.stop()  # twice is harmless


async def test_stopping_kills_a_sender_that_ignores_the_end_of_its_input(monkeypatch):
    # A stand-in that keeps running after its input closes; no ffmpeg needed.
    monkeypatch.setattr(ffmpeg, "sender_args", lambda target: ["-c", "import time; time.sleep(60)"])
    sender = FfmpegSender(sys.executable, grace_s=0.3)
    await sender.start(Target("file", "unused.mp4"), lambda: None)
    process = sender._process
    await asyncio.sleep(0.5)  # let it start
    assert process.returncode is None
    began = time.monotonic()
    await asyncio.wait_for(sender.stop(), 5)
    assert time.monotonic() - began < 3
    assert process.returncode is not None  # really gone, not just abandoned
    await asyncio.wait_for(sender.wait(), 5)
    await asyncio.wait_for(sender.stop(), 5)  # twice is harmless
