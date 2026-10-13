import asyncio
import logging
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from kickstream.adapters.chromium_capture import ChromiumCapture, browser_args, find_browser
from kickstream.adapters.process_group import KillOnExit
from kickstream.ports.output import OutputFailure

needs_browser = pytest.mark.skipif(
    find_browser(None) is None, reason="no Chromium-based browser is installed"
)
SLEEPER = [sys.executable, "-c", "import time; time.sleep(120)"]

CAPTURES = """<!doctype html><title>t</title><body style="margin:0"><div id="tick" style="height:100vh"></div><script>
// A still page may send no picture at all; this one changes, as the real program does with its clock.
setInterval(() => { tick.style.background = `hsl(${Date.now() % 360} 50% 30%)`; }, 100);
const wanted = new URLSearchParams(location.search).get("size") || "1280x720";
window.__kickstreamStartCapture = async () => {
  const [width, height] = wanted.split("x").map(Number);
  if (window.devicePixelRatio !== 1) throw new Error(`pixel ratio ${devicePixelRatio}`);
  if (window.innerWidth !== width || window.innerHeight !== height) throw new Error(`page ${innerWidth}x${innerHeight}`);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { width, height, frameRate: 30 }, audio: false, preferCurrentTab: true, selfBrowserSurface: "include" });
  const track = stream.getVideoTracks()[0];
  const surface = track.getSettings().displaySurface;
  if (surface !== "browser") throw new Error(`surface ${surface}`);
  // What is really recorded: the settings are final once the track has produced a frame.
  const probe = document.createElement("video");
  probe.muted = true;
  probe.srcObject = new MediaStream([track]);
  await probe.play();
  for (let waited = 0; !probe.videoWidth && waited < 8000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  const got = track.getSettings();
  const seen = `${got.width}x${got.height} (video ${probe.videoWidth}x${probe.videoHeight})`;
  if (got.width !== width || got.height !== height || probe.videoWidth !== width || probe.videoHeight !== height)
    throw new Error(`captured ${seen}`);
};
</script>"""
REFUSES = "<!doctype html><script>window.__kickstreamStartCapture = async () => { throw new Error('no camera here'); };</script>"
NEVER_SETTLES = (
    "<!doctype html><script>window.__kickstreamStartCapture = () => new Promise(() => {});</script>"
)
NEVER_READY = "<!doctype html><title>nothing</title>"


@pytest.fixture
def pages():
    """A local web server with the three pages above."""
    bodies = {"/captures": CAPTURES, "/refuses": REFUSES, "/never": NEVER_READY, "/hangs": NEVER_SETTLES}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = bodies.get(self.path.split("?")[0], "").encode()
            self.send_response(200 if body else 404)
            self.send_header("content-type", "text/html")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def test_the_browser_is_never_told_to_pick_a_screen_by_itself(tmp_path):
    args = browser_args(tmp_path, 1280, 720)
    assert "--use-fake-ui-for-media-stream" not in args
    assert "--auto-accept-this-tab-capture" in args and "--headless=new" in args
    assert "--window-size=1280,720" in args and f"--user-data-dir={tmp_path}" in args


def test_a_configured_browser_that_does_not_exist_is_not_found():
    assert find_browser("no-such-browser-binary") is None
    capture = ChromiumCapture("no-such-browser-binary")
    assert capture.available().startswith("No Chromium-based browser was found")


def test_closing_the_group_ends_the_processes_in_it():
    process = subprocess.Popen(SLEEPER)
    group = KillOnExit()
    group.add(process.pid)
    group.close()
    assert process.wait(timeout=10) is not None
    group.close()  # twice is harmless


@pytest.mark.skipif(sys.platform != "win32", reason="only Windows can tie a process to its parent's life")
def test_a_process_in_the_group_dies_when_its_owner_is_killed():
    owner = subprocess.Popen(
        [sys.executable, "-c",
         "import subprocess, sys, time\n"
         "from kickstream.adapters.process_group import KillOnExit\n"
         f"child = subprocess.Popen({SLEEPER!r})\n"
         "group = KillOnExit(); group.add(child.pid)\n"
         "print(child.pid, flush=True); time.sleep(120)\n"],
        stdout=subprocess.PIPE, text=True,
    )  # fmt: skip
    child_pid = int(owner.stdout.readline())
    owner.kill()
    owner.wait(timeout=10)

    def alive() -> bool:
        listed = subprocess.run(
            ["tasklist", "/FI", f"PID eq {child_pid}", "/NH"], capture_output=True, text=True
        )
        return str(child_pid) in listed.stdout

    for _ in range(50):
        if not alive():
            break
        threading.Event().wait(0.1)
    assert not alive()


@needs_browser
async def test_the_page_records_its_own_tab_at_the_asked_size_and_stop_ends_the_browser(pages):
    capture = ChromiumCapture()
    assert capture.available() is None
    await capture.start(f"{pages}/captures", 1280, 720)
    waiting = asyncio.create_task(capture.wait())
    await asyncio.sleep(0.2)
    assert not waiting.done()
    await capture.stop()
    await asyncio.wait_for(waiting, 10)
    await capture.stop()  # twice is harmless


@needs_browser
async def test_a_page_that_cannot_capture_reports_why_and_leaves_no_browser(pages):
    capture = ChromiumCapture()
    with pytest.raises(OutputFailure, match="no camera here"):
        await capture.start(f"{pages}/refuses", 1280, 720)
    await asyncio.wait_for(capture.wait(), 10)


@needs_browser
async def test_a_page_that_never_becomes_ready_is_given_up_on(pages, caplog):
    caplog.set_level(logging.DEBUG)
    capture = ChromiumCapture(start_timeout_s=3.0)
    began = time.monotonic()
    with pytest.raises(OutputFailure, match="did not start") as raised:
        await capture.start(f"{pages}/never?output=&capture=secret-token", 1280, 720)
    assert time.monotonic() - began < 6.0
    assert "secret-token" not in str(raised.value)
    assert str(raised.value).endswith(f"{pages}/never?output=")
    assert all("secret-token" not in record.getMessage() for record in caplog.records)
    await asyncio.wait_for(capture.wait(), 10)


@needs_browser
async def test_a_page_whose_recording_never_begins_is_given_up_on(pages):
    capture = ChromiumCapture(start_timeout_s=4.0)
    began = time.monotonic()
    with pytest.raises(OutputFailure, match="did not begin recording"):
        await capture.start(f"{pages}/hangs", 1280, 720)
    assert time.monotonic() - began < 7.0
    await asyncio.wait_for(capture.wait(), 10)


@needs_browser
async def test_a_proxy_in_the_environment_is_not_used_for_the_browser_connection(pages, monkeypatch):
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        monkeypatch.setenv(name, "http://127.0.0.1:9")
    capture = ChromiumCapture()
    await capture.start(f"{pages}/captures", 1280, 720)
    await capture.stop()


@needs_browser
async def test_the_picture_recorded_is_exactly_the_chosen_size_at_full_hd_too(pages):
    capture = ChromiumCapture()
    await capture.start(f"{pages}/captures?size=1920x1080", 1920, 1080)
    await capture.stop()
