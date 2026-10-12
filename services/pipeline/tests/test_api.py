import time

import pytest
from fastapi.testclient import TestClient

from kickstream.adapters.clocks import InstantClock
from kickstream.app import Settings, create_app
from kickstream.gateway.api import parse_last_event_id


@pytest.fixture
def client(tmp_path):
    settings = Settings(None, None, None, cache_dir=tmp_path)
    with TestClient(create_app(settings, clock_factory=lambda speed: InstantClock())) as test_client:
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
