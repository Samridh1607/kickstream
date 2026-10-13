import json

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from kickstream.adapters.clocks import InstantClock
from kickstream.adapters.fake_rooms import FakeRooms
from kickstream.app import Settings, create_app, environment

PUBLIC = "guests.example"


def build(tmp_path, *, rooms):
    settings = Settings(
        None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data", public_hosts=(PUBLIC,)
    )
    return create_app(
        settings,
        clock_factory=lambda speed: InstantClock(),
        match_prefix="m",
        now=lambda: 5_000.0,
        rooms=rooms,
    )


@pytest.fixture
def rooms():
    return FakeRooms(now=lambda: 5_000.0)


@pytest.fixture
def client(tmp_path, rooms):
    with TestClient(build(tmp_path, rooms=rooms)) as test_client:
        yield test_client


def new_broadcast(client) -> str:
    return client.post("/api/broadcasts", json={"title": "Derby day"}).json()["current_id"]


def people(broadcast_id: str) -> str:
    return f"/api/broadcasts/{broadcast_id}/people"


def invite(client, broadcast_id, role="speaker", name=None) -> dict:
    body = {"role": role} if name is None else {"role": role, "name": name}
    return client.post(f"{people(broadcast_id)}/invites", json=body).json()["invites"][-1]


def secret_of(item: dict) -> str:
    return item["link"].rsplit("/", 1)[-1]


def field(response) -> str:
    return response.json()["detail"][0]["loc"][-1]


def next_matching(socket, check, limit=20) -> dict:
    for _ in range(limit):
        doc = json.loads(socket.receive_text())
        if check(doc):
            return doc
    raise AssertionError("no document matched")


def test_without_a_calling_service_inviting_explains_the_setup(tmp_path):
    with TestClient(build(tmp_path, rooms=None)) as client:
        b = new_broadcast(client)
        assert client.get(people(b)).json()["service"] is None
        refused = client.post(f"{people(b)}/invites", json={"role": "speaker"})
        assert (refused.status_code, field(refused)) == (503, "rooms")


def test_a_guest_is_invited_joins_and_goes_on_stage(client):
    b = new_broadcast(client)
    item = invite(client, b, name="Sam")
    doc = client.get(people(b)).json()
    assert (doc["service"], doc["public_origin"], doc["room_id"]) == ("fake", f"https://{PUBLIC}", "room-1")
    assert item["link"].startswith("/guest/") and item["name"] == "Sam"
    secret = secret_of(item)
    guest = client.get(f"/api/guest/{secret}").json()
    assert (guest["valid"], guest["broadcast_title"], guest["role"], guest["joined"]) == (
        True,
        "Derby day",
        "speaker",
        False,
    )
    seat = client.post(f"/api/guest/{secret}/join", json={"name": "Sam"}).json()
    assert (seat["room_id"], seat["service"]) == ("room-1", "fake")
    staged = client.put(f"{people(b)}/stage", json={"people": [item["id"]]}).json()
    assert [(p["id"], p["name"], p["acs_id"]) for p in staged["stage"]] == [
        (item["id"], "Sam", seat["acs_id"])
    ]
    assert client.get(f"/api/guest/{secret}").json()["on_stage"] is True
    assert client.post(f"/api/guest/{secret}/seat/refresh").json()["acs_id"] == seat["acs_id"]


def test_refusals_name_what_was_wrong(client):
    b = new_broadcast(client)
    member = invite(client, b, role="member")
    client.post(f"/api/guest/{secret_of(member)}/join", json={"name": "Mia"})
    on_stage = client.put(f"{people(b)}/stage", json={"people": [member["id"]]})
    assert (on_stage.status_code, field(on_stage)) == (409, "people")
    unknown = client.get("/api/guest/nope")
    assert (unknown.status_code, unknown.json()["detail"][0]["msg"]) == (
        404,
        "This invite is no longer valid.",
    )
    assert client.post(f"{people(b)}/invites", json={"role": "boss"}).status_code == 422
    assert client.post(f"/api/guest/{secret_of(member)}/join", json={"name": "x" * 41}).status_code == 422
    assert client.get(people("nope")).status_code == 404


def test_a_revoked_link_stops_working(client, rooms):
    b = new_broadcast(client)
    item = invite(client, b)
    client.post(f"/api/guest/{secret_of(item)}/join", json={"name": "Sam"})
    doc = client.delete(f"{people(b)}/invites/{item['id']}").json()
    assert doc["invites"][0]["revoked"] is True and rooms.rooms["room-1"] == {}
    assert client.get(f"/api/guest/{secret_of(item)}").json()["valid"] is False
    assert client.post(f"/api/guest/{secret_of(item)}/join", json={"name": "Sam"}).status_code == 404


def test_deleting_a_broadcast_lets_its_guests_go_and_closes_its_room(client, rooms):
    b = new_broadcast(client)
    item = invite(client, b)
    client.delete(f"/api/broadcasts/{b}")
    with client.websocket_connect(f"/api/guest/{secret_of(item)}/socket") as socket:
        next_matching(socket, lambda doc: doc["valid"] is False)
    assert rooms.rooms == {}


def test_the_host_and_the_program_get_seats_with_their_roles(client, rooms):
    b = new_broadcast(client)
    host = client.post(f"{people(b)}/host/seat", json={"name": "Alex"}).json()
    program = client.post(f"{people(b)}/program/seat").json()
    assert rooms.rooms[host["room_id"]] == {host["acs_id"]: "presenter", program["acs_id"]: "consumer"}
    assert client.get(people(b)).json()["host_name"] == "Alex"


def test_pages_follow_people_live_and_a_guest_page_shows_them_present(client):
    b = new_broadcast(client)
    secret = secret_of(invite(client, b))
    with client.websocket_connect(f"{people(b)}/socket") as studio:
        next_matching(studio, lambda doc: doc["invites"][0]["present"] is False)
        with client.websocket_connect(f"/api/guest/{secret}/socket") as guest:
            assert json.loads(guest.receive_text())["valid"] is True
            next_matching(studio, lambda doc: doc["invites"][0]["present"] is True)
        next_matching(studio, lambda doc: doc["invites"][0]["present"] is False)


def test_a_socket_for_an_unknown_broadcast_or_link_is_turned_away(client):
    for path in (f"{people('nope')}/socket", "/api/guest/nope/socket"):
        with pytest.raises(WebSocketDisconnect) as closed:
            with client.websocket_connect(path) as socket:
                socket.receive_text()
        assert closed.value.code == 4404


def test_on_a_public_host_only_the_guest_routes_answer(client):
    b = new_broadcast(client)
    secret = secret_of(invite(client, b))
    for headers in ({"host": PUBLIC}, {"x-forwarded-for": "203.0.113.9"}, {"x-forwarded-host": PUBLIC}):
        assert client.get("/api/broadcasts", headers=headers).status_code == 404
        assert client.get("/api/studio", headers=headers).status_code == 404
        assert client.get(f"/api/guest/{secret}", headers=headers).status_code == 200
    assert client.get("/api/broadcasts").status_code == 200
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/studio/socket", headers={"host": PUBLIC}) as socket:
            socket.receive_text()


def test_a_co_host_opens_the_studio_on_the_public_host_until_their_invite_is_revoked(client):
    b = new_broadcast(client)
    cohost, speaker = invite(client, b, role="cohost"), invite(client, b)
    answer = client.post(
        f"/api/guest/{secret_of(cohost)}/join", json={"name": "Kim"}, headers={"host": PUBLIC}
    )
    cookie = answer.headers["set-cookie"].lower()
    assert f"kickstream_cohost={secret_of(cohost)}".lower() in cookie
    assert "httponly" in cookie and "secure" in cookie and "samesite=strict" in cookie
    client.post(f"/api/guest/{secret_of(speaker)}/join", json={"name": "Sam"})
    as_cohost = {"host": PUBLIC, "cookie": f"kickstream_cohost={secret_of(cohost)}"}
    as_speaker = {"host": PUBLIC, "cookie": f"kickstream_cohost={secret_of(speaker)}"}
    assert client.get("/api/broadcasts", headers=as_cohost).status_code == 200
    assert client.get("/api/broadcasts", headers=as_speaker).status_code == 404
    client.delete(f"{people(b)}/invites/{cohost['id']}")
    assert client.get("/api/broadcasts", headers=as_cohost).status_code == 404


def test_a_co_host_is_let_in_beside_a_cookie_another_site_left_malformed(client):
    b = new_broadcast(client)
    cohost = invite(client, b, role="cohost")
    client.post(f"/api/guest/{secret_of(cohost)}/join", json={"name": "Kim"}, headers={"host": PUBLIC})
    headers = {"host": PUBLIC, "cookie": f'a={{"x":1}}; kickstream_cohost={secret_of(cohost)}'}
    assert client.get("/api/broadcasts", headers=headers).status_code == 200


def test_settings_read_guests_from_the_environment():
    settings = Settings.from_env(
        {
            "KICKSTREAM_PUBLIC_HOSTS": "Guests.Example, b.example",
            "KICKSTREAM_ACS_CONNECTION_STRING": "endpoint=https://x/;accesskey=abc==",
            "KICKSTREAM_ROOMS": "fake",
        }
    )
    assert settings.public_hosts == ("guests.example", "b.example") and settings.rooms == "fake"
    assert settings.acs_connection_string.endswith("abc==") and "accesskey" not in repr(settings)


def test_a_dotenv_file_fills_in_what_the_environment_leaves_out(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# guests\n"
        'KICKSTREAM_ACS_CONNECTION_STRING="endpoint=https://x/;accesskey=abc=="\n'
        "export KICKSTREAM_ROOMS=fake\n"
        "KICKSTREAM_PUBLIC_HOSTS=from-file\n",
        encoding="utf-8",
    )
    assert environment(env_file, {"KICKSTREAM_PUBLIC_HOSTS": "from-shell"}) == {
        "KICKSTREAM_ACS_CONNECTION_STRING": "endpoint=https://x/;accesskey=abc==",
        "KICKSTREAM_ROOMS": "fake",
        "KICKSTREAM_PUBLIC_HOSTS": "from-shell",
    }
    assert environment(tmp_path / "missing", {}) == {}


def test_a_dotenv_file_is_read_as_the_web_server_reads_it(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "KICKSTREAM_PUBLIC_HOSTS=a.example, b.example   # the tunnel\n"
        "KICKSTREAM_ROOMS=fake#for now\n"
        'KICKSTREAM_BROWSER="C:/Edge #2/msedge.exe" # quoted\n'
        "KICKSTREAM_FFMPEG=   # unset\n",
        encoding="utf-8",
    )
    assert environment(env_file, {}) == {
        "KICKSTREAM_PUBLIC_HOSTS": "a.example, b.example",
        "KICKSTREAM_ROOMS": "fake",
        "KICKSTREAM_BROWSER": "C:/Edge #2/msedge.exe",
        "KICKSTREAM_FFMPEG": "",
    }


def test_an_acs_connection_string_chooses_azure_and_starting_calls_nothing(tmp_path):
    settings = Settings(
        None,
        None,
        None,
        cache_dir=tmp_path / "cache",
        data_dir=tmp_path / "data",
        acs_connection_string="endpoint=https://example.communication.azure.com/;accesskey=c2VjcmV0",
    )
    with TestClient(
        create_app(settings, clock_factory=lambda speed: InstantClock(), match_prefix="m")
    ) as client:
        b = new_broadcast(client)
        assert client.get(people(b)).json()["service"] == "acs"
