import time

import pytest
from fastapi.testclient import TestClient

from kickstream.adapters.clocks import InstantClock
from kickstream.app import Settings, create_app

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


class FakeNow:
    def __init__(self):
        self.at = 5_000.0

    def __call__(self):
        return self.at


def make_app(tmp_path, now):
    settings = Settings(None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data")
    return create_app(settings, clock_factory=lambda speed: InstantClock(), match_prefix="m", now=now)


@pytest.fixture
def now():
    return FakeNow()


@pytest.fixture
def client(tmp_path, now):
    with TestClient(make_app(tmp_path, now)) as test_client:
        yield test_client


def field(response):
    return response.json()["detail"][0]["loc"][-1]


def scene(doc, template):
    return next(s for s in doc["scenes"] if s["template"] == template)


def test_the_studio_starts_with_five_scenes_and_the_server_time(client, now):
    doc = client.get("/api/studio").json()
    assert [s["name"] for s in doc["scenes"]] == [
        "Starting soon",
        "Live match",
        "Analyst desk",
        "Break",
        "Full-time",
    ]
    assert doc["active_scene_id"] == doc["scenes"][0]["id"] and doc["server_time"] == now.at
    assert (doc["banner"], doc["countdown"], doc["replay"]) == (None, None, None)


def test_scenes_can_be_created_edited_activated_and_deleted(client):
    doc = client.post(
        "/api/studio/scenes", json={"source": "builtin", "ref": "Live match", "name": "Second half"}
    ).json()
    made = doc["scenes"][-1]
    assert (made["name"], len(doc["scenes"])) == ("Second half", 6)

    moved = [{**made["elements"][0], "x": 400, "y": 5000}, *made["elements"][1:]]
    doc = client.put(
        f"/api/studio/scenes/{made['id']}", json={"name": "Second half v2", "elements": moved}
    ).json()
    edited = doc["scenes"][-1]
    assert edited["name"] == "Second half v2"
    assert (edited["elements"][0]["x"], edited["elements"][0]["y"]) == (
        400,
        1080 - edited["elements"][0]["height"],
    )

    doc = client.post(f"/api/studio/scenes/{made['id']}/activate").json()
    assert doc["active_scene_id"] == made["id"]
    assert client.delete(f"/api/studio/scenes/{made['id']}").status_code == 409
    client.post(f"/api/studio/scenes/{doc['scenes'][0]['id']}/activate")
    doc = client.delete(f"/api/studio/scenes/{made['id']}").json()
    assert len(doc["scenes"]) == 5


def test_refusals_name_the_field_and_use_the_right_status(client):
    first = client.get("/api/studio").json()["scenes"][0]
    cases = [
        (client.post("/api/studio/scenes", json={"source": "builtin", "ref": "Halftime show"}), 404, "ref"),
        (client.post("/api/studio/scenes", json={"source": "pasted", "ref": "x"}), 422, "source"),
        (client.put("/api/studio/scenes/nope", json={"name": "x", "elements": []}), 404, "scene"),
        (client.put(f"/api/studio/scenes/{first['id']}", json={"name": "   ", "elements": []}), 422, "name"),
        (
            client.put(
                f"/api/studio/scenes/{first['id']}",
                json={"name": "x", "elements": [{**first["elements"][0], "type": "webcam"}]},
            ),
            422,
            "type",
        ),
        (client.post("/api/studio/scenes/nope/activate"), 404, "scene"),
        (client.delete(f"/api/studio/scenes/{first['id']}"), 409, "scene"),
        (client.post("/api/studio/templates", json={"scene_id": "nope"}), 404, "scene"),
        (client.delete("/api/studio/templates/nope"), 404, "template"),
        (client.post("/api/studio/banner", json={"text": "   "}), 422, "text"),
        (client.post("/api/studio/banner", json={"text": "ok", "duration_s": 99}), 422, "duration_s"),
        (client.post("/api/studio/banner", json={"text": "ok", "kind": "shout"}), 422, "kind"),
        (client.post("/api/studio/countdown", json={"kind": "start"}), 422, "starts_at"),
        (client.post("/api/studio/countdown", json={"kind": "start", "starts_at": 1.0}), 422, "starts_at"),
        (client.post("/api/studio/countdown", json={"kind": "break"}), 422, "minutes"),
        (client.post("/api/studio/countdown", json={"kind": "break", "minutes": 0}), 422, "minutes"),
        (client.post("/api/studio/replay", json={"match_id": "m-9", "moment_id": "m-9-k1"}), 404, "moment"),
        (
            client.put(
                "/api/studio/ticker",
                json={"enabled": True, "speed": 5, "messages": [], "show_score": True, "show_stats": True},
            ),
            422,
            "speed",
        ),
        (
            client.put(
                "/api/studio/settings",
                json={
                    "mode": "coach",
                    "language": "en",
                    "auto_banner": True,
                    "auto_start": True,
                    "auto_half_time_break": False,
                },
            ),
            422,
            "mode",
        ),
    ]
    for response, status, name in cases:
        assert (response.status_code, field(response)) == (status, name), response.text
    assert client.get("/api/studio").json()["revision"] == 0, "no refused request changed anything"


def test_templates_settings_and_ticker_are_saved(client):
    doc = client.get("/api/studio").json()
    doc = client.post(
        "/api/studio/templates", json={"scene_id": doc["scenes"][1]["id"], "name": "My live"}
    ).json()
    template = doc["templates"][0]
    assert template["name"] == "My live"
    doc = client.post("/api/studio/scenes", json={"source": "template", "ref": template["id"]}).json()
    assert doc["scenes"][-1]["name"] == "My live"
    assert client.delete(f"/api/studio/templates/{template['id']}").json()["templates"] == []

    settings = {
        "mode": "analyst",
        "language": "hi",
        "auto_banner": False,
        "auto_start": False,
        "auto_half_time_break": True,
    }
    assert client.put("/api/studio/settings", json=settings).json()["settings"] == settings
    ticker = {
        "enabled": True,
        "speed": 200,
        "messages": ["  Welcome  ", " "],
        "show_score": False,
        "show_stats": True,
    }
    assert client.put("/api/studio/ticker", json=ticker).json()["ticker"]["messages"] == ["Welcome"]


def test_banners_show_queue_and_clear(client, now):
    doc = client.post("/api/studio/banner", json={"text": "Welcome"}).json()
    assert (doc["banner"]["text"], doc["banner"]["kind"], doc["banner"]["ends_at"]) == (
        "Welcome",
        "custom",
        now.at + 8,
    )
    doc = client.post(
        "/api/studio/banner", json={"text": "Next", "kind": "info", "duration_s": 5, "source_id": "n1"}
    ).json()
    assert [b["text"] for b in doc["banner_queue"]] == ["Next"]
    doc = client.delete("/api/studio/banner").json()
    assert (doc["banner"]["text"], doc["banner_queue"]) == ("Next", [])
    assert client.delete("/api/studio/banner").json()["banner"] is None


def test_a_break_cuts_away_and_ending_it_returns(client, now):
    doc = client.get("/api/studio").json()
    live = scene(doc, "Live match")["id"]
    client.post(f"/api/studio/scenes/{live}/activate")
    doc = client.post(
        "/api/studio/countdown", json={"kind": "break", "minutes": 5, "label": "Back soon"}
    ).json()
    assert doc["active_scene_id"] == scene(doc, "Break")["id"]
    assert doc["countdown"] == {"kind": "break", "ends_at": now.at + 300, "label": "Back soon"}
    doc = client.delete("/api/studio/countdown").json()
    assert (doc["active_scene_id"], doc["countdown"]) == (live, None)


def test_when_the_start_countdown_runs_out_a_match_starts_and_the_program_goes_live(client, now):
    doc = client.post("/api/studio/countdown", json={"kind": "start", "starts_at": now.at + 600}).json()
    assert doc["active_scene_id"] == scene(doc, "Starting soon")["id"]
    assert client.get("/api/matches/current").status_code == 404
    now.at += 601
    client.put(
        "/api/studio/ticker", json={**doc["ticker"], "speed": 150}
    )  # any change wakes the deadline loop
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and client.get("/api/matches/current").status_code != 200:
        time.sleep(0.05)
    assert client.get("/api/matches/current").json() == {"match_id": "m-1"}
    doc = client.get("/api/studio").json()
    assert doc["countdown"] is None and doc["active_scene_id"] == scene(doc, "Live match")["id"]


def _play_a_match(client):
    match_id = client.post("/api/matches", json={"speed": 600}).json()["match_id"]
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        title = (
            client.get(f"/api/matches/{match_id}/overlays/latest")
            .json()
            .get("recap_card", {})
            .get("data", {})
            .get("title", "")
        )
        if title.startswith("Full-time"):
            return match_id
        time.sleep(0.1)
    raise AssertionError("the match did not finish")


def test_goals_reach_the_banner_by_themselves_during_a_match(client):
    _play_a_match(client)
    doc = client.get("/api/studio").json()
    shown = [doc["banner"], *doc["banner_queue"]]
    goals = [b for b in shown if b and b["kind"] == "goal"]
    assert goals and goals[0]["text"].startswith("GOAL!") and goals[0]["source_id"].endswith("-fan-en")


def test_a_key_moment_can_be_replayed_and_its_events_fetched(client, now):
    match_id = _play_a_match(client)
    log = client.app.state.pipeline.store.read(match_id)
    goal = next(i.payload for i in log if i.type == "key_moment" and i.payload.kind == "goal")

    doc = client.post("/api/studio/replay", json={"match_id": match_id, "moment_id": goal.id}).json()
    assert doc["replay"] == {
        "match_id": match_id,
        "moment_id": goal.id,
        "minute": goal.minute,
        "started_at": now.at,
        "duration_s": 8.0,
    }

    body = client.get(f"/api/matches/{match_id}/moments/{goal.id}/replay").json()
    assert body["moment"]["id"] == goal.id
    times = [e["minute"] * 60 + e["second"] for e in body["events"]]
    assert times and times == sorted(times) and times[-1] - times[0] <= 20
    assert body["events"][-1]["type"] == "goal" and all(e["team"] for e in body["events"])

    assert client.delete("/api/studio/replay").json()["replay"] is None
    assert client.get(f"/api/matches/{match_id}/moments/nope/replay").status_code == 404
    assert client.get(f"/api/matches/m-99/moments/{goal.id}/replay").status_code == 404


def test_images_are_accepted_by_content_and_served_safely(client):
    created = client.post(
        "/api/studio/images", content=PNG, headers={"content-type": "application/octet-stream"}
    )
    assert created.status_code == 201
    image_id = created.json()["id"]
    fetched = client.get(f"/api/studio/images/{image_id}")
    assert (fetched.status_code, fetched.content, fetched.headers["content-type"]) == (200, PNG, "image/png")
    assert fetched.headers["x-content-type-options"] == "nosniff"

    for content in (
        b"<svg xmlns='http://www.w3.org/2000/svg'/>",
        b"plain text named logo.png",
        b"",
        PNG + b"\x00" * (2 * 1024 * 1024),
    ):
        refused = client.post("/api/studio/images", content=content, headers={"content-type": "image/png"})
        assert (refused.status_code, field(refused)) == (422, "image")
    for bad_id in ("nope.png", "..%2Fstudio.json", "0" * 32 + ".png"):
        assert client.get(f"/api/studio/images/{bad_id}").status_code == 404


def test_scenes_and_settings_survive_a_restart(tmp_path, now):
    with TestClient(make_app(tmp_path, now)) as first:
        doc = first.get("/api/studio").json()
        target = doc["scenes"][1]
        first.put(
            f"/api/studio/scenes/{target['id']}",
            json={"name": "Matchday", "elements": target["elements"][:2]},
        )
        first.put("/api/studio/settings", json={**doc["settings"], "language": "es"})
    with TestClient(make_app(tmp_path, now)) as second:
        doc = second.get("/api/studio").json()
        assert doc["scenes"][1]["name"] == "Matchday" and len(doc["scenes"][1]["elements"]) == 2
        assert doc["settings"]["language"] == "es" and doc["revision"] == 2


def test_a_corrupt_studio_file_does_not_stop_the_server(tmp_path, now):
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "studio.json").write_text("{broken", encoding="utf-8")
    with TestClient(make_app(tmp_path, now)) as test_client:
        assert len(test_client.get("/api/studio").json()["scenes"]) == 5
    assert (tmp_path / "data" / "studio.json.corrupt").exists()


def test_an_upload_is_cut_off_at_the_limit_instead_of_being_read_whole():
    import asyncio

    from kickstream.studio.api import read_limited

    consumed = []

    async def body():
        for n in range(40):
            consumed.append(n)
            yield bytes(1024 * 1024)

    assert asyncio.run(read_limited(body(), 2 * 1024 * 1024)) is None
    assert len(consumed) <= 3, "stopped reading once past the limit"

    async def small():
        yield b"ab"
        yield b"cd"

    assert asyncio.run(read_limited(small(), 4)) == b"abcd"


def test_an_oversized_upload_without_a_declared_length_is_refused(client):
    def chunks():
        for _ in range(5):
            yield PNG + bytes(1024 * 1024)

    refused = client.post("/api/studio/images", content=chunks())
    assert (refused.status_code, field(refused)) == (422, "image")


def test_oversized_ids_are_refused(client):
    first = client.get("/api/studio").json()["scenes"][0]
    huge = [{**first["elements"][0], "id": "x" * 100_000}]
    assert (
        client.put(f"/api/studio/scenes/{first['id']}", json={"name": "x", "elements": huge}).status_code
        == 422
    )
    assert (
        client.post("/api/studio/scenes", json={"source": "builtin", "ref": "x" * 100_000}).status_code == 422
    )
    assert (
        client.post("/api/studio/banner", json={"text": "ok", "source_id": "x" * 100_000}).status_code == 422
    )
    assert client.get("/api/studio").json()["revision"] == 0


@pytest.mark.parametrize(
    "method, path",
    [
        ("post", "/api/studio/scenes/scene-2/activate"),
        ("delete", "/api/studio/banner"),
        ("post", "/api/studio/images"),
        ("post", "/api/matches"),
        ("put", "/api/studio/ticker"),
    ],
)
def test_a_request_from_another_web_site_cannot_change_anything(client, method, path):
    """A page open in the streamer's browser must not be able to drive the studio."""
    response = getattr(client, method)(path, headers={"origin": "https://evil.example"})
    assert response.status_code == 403
    assert client.get("/api/studio").json()["revision"] == 0
    assert client.get("/api/matches/current").status_code == 404


def test_same_origin_requests_and_tools_without_an_origin_still_work(client):
    same = client.post("/api/studio/scenes/scene-2/activate", headers={"origin": "http://testserver"})
    assert same.status_code == 200
    assert client.post("/api/studio/scenes/scene-1/activate").status_code == 200
    blocked_read = client.get("/api/studio", headers={"origin": "https://evil.example"})
    assert blocked_read.status_code == 200, "reads are not blocked"
