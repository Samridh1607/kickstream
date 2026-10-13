import json
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from kickstream.adapters.clocks import InstantClock
from kickstream.app import Settings, create_app
from tests.output_fakes import FakeCapture, FakeEncoder, FakeNow, FakeSender

BASE = "/api/studio/output"
KEY = "sk-live-abcd-1234-wxyz"
YOUTUBE = {"name": "YouTube", "platform": "youtube", "key": KEY}


class Rig:
    def __init__(self, tmp_path) -> None:
        self.capture, self.encoder, self.senders = FakeCapture(), FakeEncoder(), []
        settings = Settings(
            None,
            None,
            None,
            cache_dir=tmp_path / "cache",
            data_dir=tmp_path / "data",
            program_url="http://web.test/program",
        )
        self.app = create_app(
            settings,
            clock_factory=lambda speed: InstantClock(),
            match_prefix="m",
            now=FakeNow(),
            capture=self.capture,
            encoder=self.encoder,
            new_sender=lambda: FakeSender(self.senders),
        )


@pytest.fixture
def rig(tmp_path):
    return Rig(tmp_path)


@pytest.fixture
def client(rig):
    with TestClient(rig.app) as test_client:
        yield test_client


def field(response):
    return response.json()["detail"][0]["loc"][-1]


def wait_for(check, timeout=3.0):
    end = time.monotonic() + timeout
    while not check():
        assert time.monotonic() < end, "the condition was not reached"
        time.sleep(0.01)


def test_settings_read_the_program_address_the_browser_and_ffmpeg_from_the_environment():
    defaults = Settings.from_env({})
    assert (defaults.program_url, defaults.browser, defaults.ffmpeg) == (
        "http://127.0.0.1:5173/program",
        None,
        "ffmpeg",
    )
    custom = Settings.from_env(
        {
            "KICKSTREAM_PROGRAM_URL": "http://h:1/program",
            "KICKSTREAM_BROWSER": "C:/edge.exe",
            "KICKSTREAM_FFMPEG": "C:/ff.exe",
        }
    )
    assert (custom.program_url, custom.browser, custom.ffmpeg) == (
        "http://h:1/program",
        "C:/edge.exe",
        "C:/ff.exe",
    )


def test_a_destination_is_added_and_its_key_never_comes_back(client):
    assert client.get(BASE).json()["destinations"] == []
    added = client.post(f"{BASE}/destinations", json=YOUTUBE)
    assert added.status_code == 200
    [dest] = added.json()["destinations"]
    assert (dest["name"], dest["url"], dest["key_hint"]) == (
        "YouTube",
        "rtmp://a.rtmp.youtube.com/live2",
        "wxyz",
    )
    assert KEY not in added.text and KEY not in client.get(BASE).text


def test_refusals_name_the_field(client):
    assert field(client.post(f"{BASE}/destinations", json={**YOUTUBE, "key": "two words"})) == "key"
    custom = {"name": "Mine", "platform": "custom", "url": "http://nope", "key": KEY}
    refused = client.post(f"{BASE}/destinations", json=custom)
    assert (refused.status_code, field(refused)) == (422, "url")
    assert client.post(f"{BASE}/destinations", json={**YOUTUBE, "platform": "tiktok"}).status_code == 422
    assert client.post(f"{BASE}/destinations", json={**YOUTUBE, "extra": 1}).status_code == 422
    assert client.put(f"{BASE}/quality", json={"quality": "4k"}).status_code == 422
    missing = client.put(f"{BASE}/destinations/nope", json={"name": "x", "url": "", "enabled": True})
    assert (missing.status_code, field(missing)) == (404, "destination")
    assert client.delete(f"{BASE}/destinations/nope").status_code == 404
    start = client.post(f"{BASE}/start")
    assert (start.status_code, field(start)) == (409, "destinations")


def test_a_destination_is_changed_and_removed(client):
    dest = client.post(f"{BASE}/destinations", json=YOUTUBE).json()["destinations"][0]
    changed = client.put(
        f"{BASE}/destinations/{dest['id']}", json={"name": "Second", "url": dest["url"], "enabled": False}
    )
    assert (changed.json()["destinations"][0]["name"], changed.json()["destinations"][0]["enabled"]) == (
        "Second",
        False,
    )
    assert changed.json()["destinations"][0]["key_hint"] == "wxyz"
    assert client.put(f"{BASE}/quality", json={"quality": "1080p30"}).json()["quality"] == "1080p30"
    assert client.delete(f"{BASE}/destinations/{dest['id']}").json()["destinations"] == []


def test_go_live_and_stop(client, rig):
    client.post(f"{BASE}/destinations", json=YOUTUBE)
    started = client.post(f"{BASE}/start")
    assert (started.status_code, started.json()["state"]) == (200, "starting")
    wait_for(lambda: rig.capture.started)
    rig.encoder.emit(b"first")
    wait_for(lambda: client.get(BASE).json()["state"] == "live")
    busy = client.post(f"{BASE}/destinations", json={"name": "More", "platform": "file"})
    assert (busy.status_code, field(busy)) == (409, "output")
    assert client.post(f"{BASE}/start").status_code == 409
    stopped = client.post(f"{BASE}/stop")
    assert (stopped.status_code, stopped.json()["state"]) == (200, "idle")
    assert rig.capture.stopped == 1 and rig.encoder.stopped == 1
    assert client.post(f"{BASE}/stop").json()["state"] == "idle"


def test_something_missing_is_a_503_that_says_what(client, rig):
    client.post(f"{BASE}/destinations", json=YOUTUBE)
    rig.encoder.missing = "ffmpeg was not found. Install it."
    refused = client.post(f"{BASE}/start")
    assert refused.status_code == 503
    assert refused.json()["detail"][0]["msg"] == "ffmpeg was not found. Install it."


def test_the_document_is_followed_over_a_socket_and_as_events(client):
    with client.websocket_connect(f"{BASE}/socket") as socket:
        assert json.loads(socket.receive_text())["revision"] == 0
        client.post(f"{BASE}/destinations", json=YOUTUBE)
        after = json.loads(socket.receive_text())
        assert after["destinations"][0]["name"] == "YouTube" and KEY not in json.dumps(after)
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect(f"{BASE}/socket", headers={"origin": "http://evil.example"}) as socket:
            socket.receive_text()
    assert refused.value.code == 1008


def test_only_the_page_with_the_run_s_token_may_send_video(client, rig):
    client.post(f"{BASE}/destinations", json=YOUTUBE)
    client.post(f"{BASE}/start")
    wait_for(lambda: rig.capture.started)
    for query in ("", "?token=wrong", "?token=%C3%A9"):
        with pytest.raises(WebSocketDisconnect) as refused:
            with client.websocket_connect(f"/api/output/capture/socket{query}") as socket:
                socket.receive_bytes()
        assert refused.value.code == 1008
    with client.websocket_connect(f"/api/output/capture/socket?token={rig.capture.token}") as socket:
        socket.send_bytes(b"one")
        socket.send_bytes(b"two")
        wait_for(lambda: rig.encoder.written == [b"one", b"two"])
    client.post(f"{BASE}/stop")


def test_shutting_the_pipeline_down_stops_a_stream(rig):
    with TestClient(rig.app) as client:
        client.post(f"{BASE}/destinations", json=YOUTUBE)
        client.post(f"{BASE}/start")
        wait_for(lambda: rig.capture.started)
    assert rig.capture.stopped == 1 and rig.encoder.stopped == 1
