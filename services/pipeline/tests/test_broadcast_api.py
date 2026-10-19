import json
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from kickstream.adapters.clocks import InstantClock
from kickstream.app import Settings, create_app
from tests.broadcast_fakes import FakeCutter, FakeProducer
from tests.output_fakes import FakeCapture, FakeEncoder, FakeNow, FakeSender

BASE = "/api/broadcasts"
OUTPUT = "/api/studio/output"


class Rig:
    def __init__(self, tmp_path) -> None:
        self.capture, self.encoder, self.senders = FakeCapture(), FakeEncoder(), []
        self.now = FakeNow(1_000_000.0)
        self.cutter = FakeCutter()
        self.data = tmp_path / "data"
        settings = Settings(None, None, None, cache_dir=tmp_path / "cache", data_dir=self.data)
        self.app = create_app(
            settings,
            clock_factory=lambda speed: InstantClock(),
            match_prefix="m",
            now=self.now,
            capture=self.capture,
            encoder=self.encoder,
            new_sender=lambda: FakeSender(self.senders),
            reel_producer=FakeProducer(),
            cutter=self.cutter,
        )


@pytest.fixture
def rig(tmp_path):
    return Rig(tmp_path)


@pytest.fixture
def client(rig):
    with TestClient(rig.app) as test_client:
        yield test_client


def wait_for(check, timeout=3.0):
    end = time.monotonic() + timeout
    while not check():
        assert time.monotonic() < end, "the condition was not reached"
        time.sleep(0.01)


def field(response):
    return response.json()["detail"][0]["loc"][-1]


def only(client):
    return client.get(BASE).json()["broadcasts"][0]


def test_a_broadcast_is_created_edited_and_deleted(client):
    assert client.get(BASE).json() == {
        "revision": 0,
        "server_time": 1_000_000.0,
        "broadcasts": [],
        "current_id": None,
        "ai": True,
    }
    made = client.post(BASE, json={"title": "Derby day", "description": "The big one"}).json()
    broadcast = made["broadcasts"][0]
    assert (broadcast["title"], broadcast["state"], broadcast["record"]) == ("Derby day", "ready", True)
    assert made["current_id"] == broadcast["id"]
    edited = client.put(f"{BASE}/{broadcast['id']}", json={"title": "Cup final", "description": ""})
    assert edited.json()["broadcasts"][0]["title"] == "Cup final"
    assert client.delete(f"{BASE}/{broadcast['id']}").json()["broadcasts"] == []


def test_opening_a_broadcast_in_the_studio_makes_it_current(client):
    first = client.post(BASE, json={"title": "Derby day"}).json()["broadcasts"][0]
    second = client.post(BASE, json={"title": "Cup final"}).json()["broadcasts"][0]
    assert client.get(BASE).json()["current_id"] == second["id"]
    assert client.post(f"{BASE}/{first['id']}/select").json()["current_id"] == first["id"]
    assert client.post(f"{BASE}/nope/select").status_code == 404


def test_refusals_name_the_field(client):
    refused = client.post(BASE, json={"title": "  "})
    assert (refused.status_code, field(refused)) == (422, "title")
    assert client.post(BASE, json={"title": "x", "extra": 1}).status_code == 422
    assert client.post(f"{BASE}/nope/live").status_code == 404
    assert client.post(f"{BASE}/nope/reels").status_code == 404
    made = client.post(BASE, json={"title": "No recording yet"}).json()["broadcasts"][0]
    refused = client.post(f"{BASE}/{made['id']}/reels")
    assert (refused.status_code, field(refused)) == (409, "reels")


def test_a_broadcast_goes_live_records_ends_and_makes_reels_that_can_be_watched(client, rig):
    broadcast = client.post(BASE, json={"title": "Derby day"}).json()["broadcasts"][0]
    live = client.post(f"{BASE}/{broadcast['id']}/live")
    assert live.status_code == 200
    # Recording was asked for, so a file destination was added and switched on.
    [recording_destination] = client.get(OUTPUT).json()["destinations"]
    assert (recording_destination["platform"], recording_destination["enabled"]) == ("file", True)

    wait_for(lambda: rig.capture.started)
    rig.encoder.emit(b"video")
    # The app runs on its own loop in another thread: asking it something wakes it to take the chunk.
    wait_for(lambda: client.get(OUTPUT).json()["state"] == "live" and rig.senders and rig.senders[0].target)
    rig.senders[0].go_live()
    wait_for(lambda: only(client)["state"] == "live")
    rig.now.at += 60
    ended = client.post(f"{BASE}/{broadcast['id']}/end").json()["broadcasts"][0]
    assert ended["state"] == "ended"
    assert ended["stats"]["live_s"] == 60
    assert ended["sessions"][0]["destinations"][0]["outcome"] == "live"
    [recording] = ended["recordings"]
    assert recording["made_at"] - recording["started_at"] == 60

    played = client.get(
        f"{BASE}/{broadcast['id']}/recordings/{recording['file']}", headers={"range": "bytes=0-99"}
    )
    assert (played.status_code, played.headers["content-type"], len(played.content)) == (
        206,
        "video/mp4",
        100,
    )

    assert client.post(f"{BASE}/{broadcast['id']}/reels").json()["broadcasts"][0]["generating"] is True
    wait_for(lambda: not only(client)["generating"])
    reels = only(client)["reels"]
    assert [(r["state"], r["agent"], r["start_s"]) for r in reels] == [
        ("ready", "AI agents", 7.0),
        ("ready", "AI agents", 37.0),
    ]
    reel = client.get(f"{BASE}/{broadcast['id']}/reels/{reels[0]['id']}.mp4")
    assert (reel.status_code, reel.headers["content-type"], len(reel.content)) == (200, "video/mp4", 4000)

    gone = client.delete(f"{BASE}/{broadcast['id']}/reels/{reels[0]['id']}").json()["broadcasts"][0]
    assert [r["id"] for r in gone["reels"]] == [reels[1]["id"]]
    assert client.get(f"{BASE}/{broadcast['id']}/reels/{reels[0]['id']}.mp4").status_code == 404


def test_only_files_the_broadcast_lists_are_served(client):
    broadcast = client.post(BASE, json={"title": "Derby day"}).json()["broadcasts"][0]
    for path in ("recordings/broadcasts.json", "recordings/..%2Fbroadcasts.json", "reels/nope.mp4"):
        assert client.get(f"{BASE}/{broadcast['id']}/{path}").status_code == 404


def test_a_stream_started_from_the_studio_is_kept_as_a_broadcast(client, rig):
    client.post(f"{OUTPUT}/destinations", json={"name": "Disk", "platform": "file"})
    client.post(f"{OUTPUT}/start")
    wait_for(lambda: rig.capture.started)
    rig.encoder.emit(b"video")
    wait_for(lambda: client.get(OUTPUT).json()["state"] == "live" and client.get(BASE).json()["broadcasts"])
    assert only(client)["state"] == "live" and only(client)["title"].startswith("Broadcast · ")
    client.post(f"{OUTPUT}/stop")
    wait_for(lambda: only(client)["state"] == "ready")


def test_the_document_is_followed_over_a_socket(client):
    with client.websocket_connect(f"{BASE}/socket") as socket:
        assert json.loads(socket.receive_text())["revision"] == 0
        client.post(BASE, json={"title": "Derby day"})
        assert json.loads(socket.receive_text())["broadcasts"][0]["title"] == "Derby day"
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect(f"{BASE}/socket", headers={"origin": "http://evil.example"}) as socket:
            socket.receive_text()
    assert refused.value.code == 1008


# --- reels edited in Clipchamp ------------------------------------------------------------------

# What an MP4 starts with: a box saying which kind of file it is.
MP4 = b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41"


def reels_made(client, rig) -> tuple[str, list[dict]]:
    """An ended broadcast with its reels made, as after a real show."""
    broadcast = client.post(BASE, json={"title": "Derby day"}).json()["broadcasts"][0]
    client.post(f"{BASE}/{broadcast['id']}/live")
    wait_for(lambda: rig.capture.started)
    rig.encoder.emit(b"video")
    wait_for(lambda: client.get(OUTPUT).json()["state"] == "live" and rig.senders and rig.senders[0].target)
    rig.senders[0].go_live()
    wait_for(lambda: only(client)["state"] == "live")
    rig.now.at += 60
    client.post(f"{BASE}/{broadcast['id']}/end")
    client.post(f"{BASE}/{broadcast['id']}/reels")
    wait_for(lambda: not only(client)["generating"])
    return broadcast["id"], only(client)["reels"]


def test_a_reel_edited_in_clipchamp_is_added_beside_the_original_and_played(client, rig):
    broadcast_id, reels = reels_made(client, rig)
    reel = reels[0]
    # Bigger than any other request may be: a minute of 1080p from Clipchamp is tens of megabytes.
    edited = MP4 + b"v" * (5 * 1024 * 1024)
    added = client.put(
        f"{BASE}/{broadcast_id}/reels/{reel['id']}/edited",
        content=edited,
        headers={"content-type": "video/mp4", "x-file-name": "Derby%20day%20-%20edit.mp4"},
    )
    assert added.status_code == 200
    [changed] = [r for r in added.json()["broadcasts"][0]["reels"] if r["id"] == reel["id"]]
    assert changed["edited"] == {
        "name": "Derby day - edit.mp4",
        "size_bytes": len(edited),
        "added_at": rig.now.at,
    }

    played = client.get(f"{BASE}/{broadcast_id}/reels/{reel['id']}/edited.mp4")
    assert (played.status_code, played.headers["content-type"], played.content) == (200, "video/mp4", edited)
    part = client.get(f"{BASE}/{broadcast_id}/reels/{reel['id']}/edited.mp4", headers={"range": "bytes=0-31"})
    assert (part.status_code, part.content) == (206, edited[:32])
    # The original is kept, untouched.
    assert len(client.get(f"{BASE}/{broadcast_id}/reels/{reel['id']}.mp4").content) == 4000

    again = MP4 + b"w" * 100
    client.put(f"{BASE}/{broadcast_id}/reels/{reel['id']}/edited", content=again)
    assert client.get(f"{BASE}/{broadcast_id}/reels/{reel['id']}/edited.mp4").content == again
    [replaced] = [r for r in only(client)["reels"] if r["id"] == reel["id"]]
    assert replaced["edited"]["name"] == "Edited in Clipchamp.mp4", "a file sent without a name gets one"

    removed = client.delete(f"{BASE}/{broadcast_id}/reels/{reel['id']}/edited")
    [back] = [r for r in removed.json()["broadcasts"][0]["reels"] if r["id"] == reel["id"]]
    assert back["edited"] is None
    assert client.get(f"{BASE}/{broadcast_id}/reels/{reel['id']}/edited.mp4").status_code == 404
    assert client.get(f"{BASE}/{broadcast_id}/reels/{reel['id']}.mp4").status_code == 200


def test_only_an_mp4_of_a_finished_reel_is_taken_and_a_refused_one_leaves_nothing(client, rig, monkeypatch):
    broadcast_id, reels = reels_made(client, rig)
    path = f"{BASE}/{broadcast_id}/reels/{reels[0]['id']}/edited"
    refused = client.put(path, content=b"<html>not a video</html>")
    assert (refused.status_code, field(refused)) == (422, "edited")
    assert "MP4" in refused.json()["detail"][0]["msg"]
    assert client.get(f"{path}.mp4").status_code == 404
    assert client.put(f"{BASE}/{broadcast_id}/reels/nope/edited", content=MP4).status_code == 404
    assert client.put(f"{BASE}/nope/reels/{reels[0]['id']}/edited", content=MP4).status_code == 404

    from kickstream.broadcasts import service as broadcast_service

    monkeypatch.setattr(broadcast_service, "MAX_EDITED_BYTES", 1000)
    too_big = client.put(path, content=MP4 + b"v" * 2000)
    assert (too_big.status_code, field(too_big)) == (422, "edited")
    assert client.get(f"{path}.mp4").status_code == 404
    leftovers = [p.name for p in (rig.data / "reels" / broadcast_id).iterdir() if "edited" in p.name]
    assert leftovers == [], "a refused upload leaves no part of itself on disk"


def test_deleting_a_reel_deletes_its_edited_version(client, rig):
    broadcast_id, reels = reels_made(client, rig)
    reel_id = reels[0]["id"]
    client.put(f"{BASE}/{broadcast_id}/reels/{reel_id}/edited", content=MP4 + b"v")
    client.delete(f"{BASE}/{broadcast_id}/reels/{reel_id}")
    assert not any((rig.data / "reels" / broadcast_id).glob(f"{reel_id}*"))


def test_other_requests_keep_their_small_limit(client):
    assert client.post(BASE, content=b"x" * (4 * 1024 * 1024)).status_code == 413
