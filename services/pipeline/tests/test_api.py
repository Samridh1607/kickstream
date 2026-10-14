import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from kickstream.adapters.clocks import InstantClock
from kickstream.adapters.statsbomb import StatsBombOpenData
from kickstream.app import Settings, create_app
from kickstream.gateway.api import parse_last_event_id
from tests.test_statsbomb import BASE as STATSBOMB_BASE
from tests.test_statsbomb import FIX as STATSBOMB_FIX
from tests.test_statsbomb import FixtureGet


@pytest.fixture
def client(tmp_path):
    settings = Settings(None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data")
    app = create_app(settings, clock_factory=lambda speed: InstantClock(), match_prefix="m")
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def client_with_sources(tmp_path):
    settings = Settings(None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data")
    statsbomb = StatsBombOpenData(
        tmp_path / "statsbomb", base_url=STATSBOMB_BASE, get=FixtureGet(STATSBOMB_FIX)
    )
    app = create_app(
        settings,
        clock_factory=lambda speed: InstantClock(),
        match_prefix="m",
        replays={"statsbomb": statsbomb},
        live={},
    )
    with TestClient(app) as test_client:
        yield test_client


class HeldClock:
    """Holds the match at its first event, so it is still running when stopped."""

    async def sleep(self, match_seconds: float) -> None:
        await asyncio.sleep(3600)


@pytest.fixture
def held_client(tmp_path):
    settings = Settings(None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data")
    app = create_app(settings, clock_factory=lambda speed: HeldClock(), match_prefix="m")
    with TestClient(app) as test_client:
        yield test_client


def test_teams_lists_both_fictional_clubs(client):
    body = client.get("/api/teams").json()
    assert (body["home"]["name"], body["away"]["name"]) == ("Northbridge FC", "Harbour City")
    assert len(body["home"]["players"]) == 14


def test_current_match_is_404_until_one_starts_then_names_the_latest(client):
    assert client.get("/api/matches/current").status_code == 404
    first = client.post("/api/matches")
    assert first.status_code == 201 and first.json() == {"match_id": "m-1"}
    assert client.get("/api/matches/current").json() == {"match_id": "m-1"}
    assert client.post("/api/matches", json={"seed": 3, "speed": 600}).json() == {"match_id": "m-2"}
    assert client.get("/api/matches/current").json() == {"match_id": "m-2"}


@pytest.mark.parametrize(
    "body",
    [
        {"speed": 0},
        {"speed": -5},
        {"speed": 600.5},
        {"speed": 1e9},
        {"speed": "fast"},
        {"seed": -1},
        {"seed": "abc"},
        {"seed": 2**31},
        {"seed": 1.5},
        {"pace": 30},
    ],
    ids=str,
)
def test_out_of_range_start_requests_are_rejected_and_start_nothing(client, body):
    response = client.post("/api/matches", json=body)
    assert response.status_code == 422
    assert client.get("/api/matches/current").status_code == 404


@pytest.mark.parametrize(
    "body",
    [
        {"source": "statsbomb"},
        {"source": "statsbomb", "ref": "8658"},
        {"source": "statsbomb", "ref": "43/3"},
        {"source": "statsbomb", "ref": "43/3/8658", "seed": 1},
        {"source": "statsbomb", "ref": "43/3/８６５８"},
        {"source": "simulated", "ref": "1"},
        {"source": "api_football", "ref": "1/2"},
        {"source": "api_football"},
        {"source": "api_football", "ref": "1", "seed": 1},
        {"source": "openligadb", "ref": "../1"},
        {"source": "sportapi", "ref": "1"},
        {"source": "statsbomb", "ref": 8658},
    ],
    ids=str,
)
def test_a_start_that_does_not_fit_its_source_is_rejected_and_starts_nothing(client, body):
    assert client.post("/api/matches", json=body).status_code == 422
    assert client.get("/api/matches/current").status_code == 404


def test_a_simulated_start_can_name_its_source(client):
    response = client.post("/api/matches", json={"source": "simulated", "seed": 3, "speed": 600})
    assert response.status_code == 201 and response.json() == {"match_id": "m-1"}


def test_a_source_kickstream_does_not_have_is_refused_with_a_409(client_with_sources):
    response = client_with_sources.post("/api/matches", json={"source": "openligadb", "ref": "83194"})
    assert response.status_code == 409
    [detail] = response.json()["detail"]
    assert detail["loc"] == ["body", "source"] and "openligadb" in detail["msg"]
    assert client_with_sources.get("/api/matches/current").status_code == 404


def test_teams_are_the_current_matchs(client_with_sources):
    assert client_with_sources.get("/api/teams").json()["home"]["name"] == "Northbridge FC"
    response = client_with_sources.post(
        "/api/matches", json={"source": "statsbomb", "ref": "43/3/8658", "speed": 600}
    )
    assert response.status_code == 201
    teams = client_with_sources.get("/api/teams").json()
    assert (teams["home"]["name"], teams["away"]["name"]) == ("France", "Croatia")


def test_a_replay_that_cannot_be_found_is_a_502_with_the_sources_message(client_with_sources):
    response = client_with_sources.post("/api/matches", json={"source": "statsbomb", "ref": "43/3/1"})
    assert response.status_code == 502
    [detail] = response.json()["detail"]
    assert detail["loc"] == ["body", "source"] and detail["msg"].startswith("StatsBomb has no match 43/3/1.")
    assert client_with_sources.get("/api/matches/current").status_code == 404


def _statuses(client, match_id):
    log = client.app.state.pipeline.store.read(match_id)
    return [item.payload for item in log if item.type == "match_status"]


def test_stop_ends_the_running_match(held_client):
    match_id = held_client.post("/api/matches").json()["match_id"]
    deadline = time.monotonic() + 10
    while not _statuses(held_client, match_id):
        assert time.monotonic() < deadline, "the match did not start"
        time.sleep(0.02)
    response = held_client.post("/api/matches/stop")
    assert response.status_code == 204 and response.content == b""
    deadline = time.monotonic() + 10
    while _statuses(held_client, match_id)[-1].state != "abandoned":
        assert time.monotonic() < deadline, "the match was not announced abandoned"
        time.sleep(0.02)
    assert held_client.get("/api/sources").json()["running"] is None
    assert held_client.get("/api/matches/current").json() == {"match_id": match_id}


def test_stop_with_nothing_running_does_nothing(client):
    assert client.post("/api/matches/stop").status_code == 204
    assert client.get("/api/matches/current").status_code == 404


def test_stream_for_an_unknown_match_is_404(client):
    assert client.get("/api/matches/m-99/stream").status_code == 404


@pytest.mark.parametrize("query", ["mode=coach", "lang=fr", "mode=", "lang=EN"])
def test_stream_rejects_unknown_modes_and_languages(client, query):
    client.post("/api/matches")
    assert client.get(f"/api/matches/m-1/stream?{query}").status_code == 422


@pytest.mark.parametrize(
    "value, expected",
    [
        (None, 0),
        ("", 0),
        ("17", 17),
        ("abc", 0),
        ("-4", 0),
        ("3.5", 0),
        ("  9 ", 0),
        ("9" * 40, 0),
    ],
)
def test_a_garbage_last_event_id_means_replay_from_the_start(value, expected):
    assert parse_last_event_id(value) == expected


def _latest_overlays(client, match_id, lang="en"):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        body = client.get(f"/api/matches/{match_id}/overlays/latest?lang={lang}").json()
        if body.get("recap_card", {}).get("data", {}).get("title", "").startswith(("Full-time", "Final")):
            return body
        time.sleep(0.1)
    raise AssertionError("the match did not reach its full-time recap card")


def test_latest_overlays_expose_one_overlay_per_kind_in_the_requested_language(client):
    match_id = client.post("/api/matches").json()["match_id"]
    english = _latest_overlays(client, match_id)
    assert set(english) == {"lower_third", "stat_card", "pressure_map", "recap_card"}
    assert english["recap_card"]["data"]["title"].startswith("Full-time:")
    assert english["stat_card"]["data"]["stat_rows"][1]["label"] == "Shots"
    spanish = _latest_overlays(client, match_id, "es")
    assert spanish["recap_card"]["data"]["title"].startswith("Final:")
    assert spanish["pressure_map"] == english["pressure_map"]


def test_latest_overlays_errors(client):
    assert client.get("/api/matches/m-99/overlays/latest").status_code == 404
    client.post("/api/matches")
    assert client.get("/api/matches/m-1/overlays/latest?lang=de").status_code == 422


def test_each_server_process_numbers_its_matches_under_its_own_prefix(tmp_path):
    """A match ID from before a restart must never name a different match afterwards."""
    ids = []
    for _ in range(2):
        app = create_app(
            Settings(None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data"),
            clock_factory=lambda speed: InstantClock(),
        )
        with TestClient(app) as test_client:
            ids.append(test_client.post("/api/matches").json()["match_id"])
    assert ids[0] != ids[1]
    assert all(match_id.startswith("m") and match_id.endswith("-1") for match_id in ids)
