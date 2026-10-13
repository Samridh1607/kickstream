"""The WebSocket form of each live stream.

Browsers allow only six HTTP connections to one server, and each Server-Sent Events stream
holds one. Pages therefore follow live data over WebSockets, which are not counted in that
limit. These tests cover the socket routes; the SSE routes they mirror are tested elsewhere.
"""

import json
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from kickstream.adapters.clocks import InstantClock
from kickstream.app import Settings, create_app


@pytest.fixture
def client(tmp_path):
    settings = Settings(None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data")
    app = create_app(
        settings, clock_factory=lambda speed: InstantClock(), match_prefix="m", now=lambda: 5_000.0
    )
    with TestClient(app) as test_client:
        yield test_client


def _play_a_match(client):
    match_id = client.post("/api/matches", json={"speed": 600}).json()["match_id"]
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        cards = client.get(f"/api/matches/{match_id}/overlays/latest").json()
        if cards.get("recap_card", {}).get("data", {}).get("title", "").startswith("Full-time"):
            return match_id
        time.sleep(0.1)
    raise AssertionError("the match did not finish")


def test_the_studio_socket_sends_the_document_and_then_each_change(client):
    with client.websocket_connect("/api/studio/socket") as socket:
        first = json.loads(socket.receive_text())
        assert first["revision"] == 0 and len(first["scenes"]) == 5
        client.post("/api/studio/banner", json={"text": "Hello"})
        changed = json.loads(socket.receive_text())
        assert changed["revision"] == 1 and changed["banner"]["text"] == "Hello"


def test_the_match_socket_replays_the_match_for_the_viewers_variant(client):
    match_id = _play_a_match(client)
    with client.websocket_connect(f"/api/matches/{match_id}/socket?mode=analyst&lang=es") as socket:
        envelopes = [json.loads(socket.receive_text()) for _ in range(400)]
    assert envelopes[0]["type"] == "match_status" and envelopes[0]["id"] == 1
    assert [e["id"] for e in envelopes] == sorted(e["id"] for e in envelopes)
    narratives = [e for e in envelopes if e["type"] == "narrative"]
    assert narratives and {(e["payload"]["mode"], e["payload"]["language"]) for e in narratives} == {
        ("analyst", "es")
    }


def test_the_match_socket_resumes_after_the_id_the_page_last_saw(client):
    match_id = _play_a_match(client)
    with client.websocket_connect(f"/api/matches/{match_id}/socket?after=200") as socket:
        assert json.loads(socket.receive_text())["id"] > 200
    with client.websocket_connect(f"/api/matches/{match_id}/socket?after=not-a-number") as socket:
        assert json.loads(socket.receive_text())["id"] == 1


def test_an_unknown_match_closes_the_socket_with_a_code_the_page_can_tell_apart(client):
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect("/api/matches/m-99/socket") as socket:
            socket.receive_text()
    assert closed.value.code == 4404


@pytest.mark.parametrize("query", ["mode=coach", "lang=fr"])
def test_an_unknown_mode_or_language_closes_the_socket(client, query):
    client.post("/api/matches")
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/api/matches/m-1/socket?{query}") as socket:
            socket.receive_text()


@pytest.mark.parametrize(
    "path", ["/api/studio/socket", "/api/broadcasts/socket", "/api/studio/output/socket"]
)
def test_a_page_on_another_site_cannot_open_a_socket(client, path):
    """WebSockets are not covered by the browser's same-origin rule, so the server checks."""
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect(path, headers={"origin": "https://evil.example"}) as socket:
            socket.receive_text()
    assert closed.value.code == 1008


@pytest.mark.parametrize("origin", ["http://testserver", "http://testserver:5173", "https://testserver"])
def test_the_apps_own_pages_can_open_a_socket_whatever_port_serves_them(client, origin):
    with client.websocket_connect("/api/studio/socket", headers={"origin": origin}) as socket:
        assert json.loads(socket.receive_text())["revision"] == 0


def test_a_tool_that_sends_no_origin_can_open_a_socket(client):
    with client.websocket_connect("/api/broadcasts/socket") as socket:
        assert json.loads(socket.receive_text())["revision"] == 0


def test_the_fan_routes_are_gone(client):
    assert client.get("/api/audience").status_code == 404
    assert client.get("/api/studio/audience").status_code == 404
