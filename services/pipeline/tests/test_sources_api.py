import json
import time
import urllib.error
import urllib.request
from datetime import UTC, date, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from kickstream.adapters.api_football import ApiFootball, DailyBudget
from kickstream.adapters.clocks import InstantClock
from kickstream.adapters.json_record_store import JsonRecordStore
from kickstream.adapters.openligadb import OpenLigaDb
from kickstream.adapters.statsbomb import OPEN_DATA, StatsBombOpenData
from kickstream.app import Settings, create_app
from tests.test_statsbomb import BASE as STATSBOMB_BASE
from tests.test_statsbomb import FIX as STATSBOMB_FIX
from tests.test_statsbomb import FixtureGet

FIX = Path(__file__).parent / "fixtures"
FOOTBALL_BASE = "https://af.test"
LIGA_BASE = "https://ol.test"
KEY = "fake-key-7731"
LIGA_KICKOFF = datetime(2026, 10, 10, 13, 30, tzinfo=UTC).timestamp()
LIGA_DAY = datetime.fromtimestamp(LIGA_KICKOFF).date()


class FootballService:
    """Answers as API-Football does: the day's fixtures, and each poll of a fixture one step further on."""

    def __init__(self, refuse: str | None = None) -> None:
        self.refuse = refuse
        self.urls: list[str] = []
        self.polls = 0

    def __call__(self, url: str, headers) -> tuple[bytes, dict[str, str]]:
        self.urls.append(url)
        if self.refuse:
            name = self.refuse
        elif "date=" in url:
            name = "fixtures-date.json"
        else:
            self.polls += 1
            name = f"fixture-{min(self.polls, 4)}.json"
        remaining = str(100 - len(self.urls))
        return (FIX / "api_football" / name).read_bytes(), {"x-ratelimit-requests-remaining": remaining}


class LigaService:
    def __init__(self) -> None:
        self.urls: list[str] = []

    def __call__(self, url: str, headers) -> tuple[bytes, dict[str, str]]:
        self.urls.append(url)
        path = url.removeprefix(LIGA_BASE)
        name = "getmatchdata-bl1.json" if path == "/getmatchdata/bl1" else "match-83194.json"
        return (FIX / "openligadb" / name).read_bytes(), {}


def unreachable(url: str, headers) -> tuple[bytes, dict[str, str]]:
    raise urllib.error.URLError("no network")


def settings(tmp_path: Path, **extra) -> Settings:
    return Settings(None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data", **extra)


def make_client(tmp_path: Path, *, key: str | None = KEY, football=None, statsbomb_get=None, poll_s=None):
    football = football or FootballService()
    budget = DailyBudget(JsonRecordStore(tmp_path / "budget.json"))
    app = create_app(
        settings(tmp_path, live_poll_s=poll_s),
        clock_factory=lambda speed: InstantClock(),
        match_prefix="m",
        feeds={},
        replays={
            "statsbomb": StatsBombOpenData(
                tmp_path / "statsbomb",
                base_url=STATSBOMB_BASE,
                get=statsbomb_get or FixtureGet(STATSBOMB_FIX),
            )
        },
        live={
            "api_football": ApiFootball(key, budget, base_url=FOOTBALL_BASE, get=football),
            "openligadb": OpenLigaDb(
                ("bl1",), base_url=LIGA_BASE, get=LigaService(), now=lambda: LIGA_KICKOFF
            ),
        },
    )
    return TestClient(app)


@pytest.fixture
def client(tmp_path):
    with make_client(tmp_path) as test_client:
        yield test_client


@pytest.fixture
def client_without_key(tmp_path):
    with make_client(tmp_path, key=None) as test_client:
        yield test_client


def refusal(response) -> tuple[int, list, str]:
    [detail] = response.json()["detail"]
    return response.status_code, detail["loc"], detail["msg"]


def wait_for(check, what: str, timeout: float = 30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        found = check()
        if found:
            return found
        time.sleep(0.05)
    raise AssertionError(f"{what} did not happen")


def log_of(client, match_id):
    return client.app.state.pipeline.store.read(match_id)


def statuses(client, match_id):
    return [item.payload for item in log_of(client, match_id) if item.type == "match_status"]


def finished(client, match_id) -> bool:
    found = statuses(client, match_id)
    return bool(found) and found[-1].state == "finished"


# --- the list of sources -----------------------------------------------------------------------


def test_sources_list_all_four_and_say_what_a_missing_key_needs(client_without_key):
    body = client_without_key.get("/api/sources").json()
    assert [s["id"] for s in body["sources"]] == ["simulated", "statsbomb", "api_football", "openligadb"]
    simulated, statsbomb, football, liga = body["sources"]
    assert (simulated["kind"], simulated["detail"], simulated["available"], simulated["credit"]) == (
        "simulated",
        "full",
        True,
        None,
    )
    assert (statsbomb["kind"], statsbomb["detail"], statsbomb["credit"]) == (
        "replay",
        "full",
        "Data: StatsBomb",
    )
    assert football["available"] is False and "KICKSTREAM_API_FOOTBALL_KEY" in football["setup"]
    assert (football["kind"], football["detail"]) == ("live", "key_events")
    assert (liga["available"], liga["budget_used"], liga["budget_limit"]) == (True, None, None)
    assert body["running"] is None


def test_the_budget_counts_every_api_football_request_and_the_key_is_never_shown(client):
    assert client.get("/api/sources").json()["sources"][2] | {"budget_used": 0} == {
        "id": "api_football",
        "name": "API-Football",
        "kind": "live",
        "detail": "key_events",
        "available": True,
        "credit": "Data: API-Football",
        "setup": None,
        "budget_used": 0,
        "budget_limit": 100,
    }
    client.get("/api/sources/api_football/fixtures?date=2026-10-14")
    response = client.get("/api/sources")
    assert response.json()["sources"][2]["budget_used"] == 1
    assert KEY not in response.text


# --- browsing StatsBomb ------------------------------------------------------------------------


def test_browsing_statsbomb_gives_competitions_then_matches_without_scores(client):
    competitions = client.get("/api/sources/statsbomb/competitions").json()
    world_cup = next(c for c in competitions if c["competition_id"] == 43 and c["season_id"] == 3)
    assert (world_cup["competition_name"], world_cup["season_name"]) == ("FIFA World Cup", "2018")
    matches = client.get("/api/sources/statsbomb/competitions/43/3/matches").json()
    final = next(m for m in matches if m["ref"] == "43/3/8658")
    assert (final["home"], final["away"], final["date"]) == ("France", "Croatia", "2018-07-15")
    assert not any("score" in field for match in matches for field in match)


def test_browsing_needs_numbers_and_a_source_kickstream_has(client):
    assert client.get("/api/sources/statsbomb/competitions/world/3/matches").status_code == 422
    assert client.get("/api/sources/wyscout/competitions").status_code == 404


def test_statsbomb_out_of_reach_is_a_502_that_says_what_to_do(tmp_path):
    with make_client(tmp_path, statsbomb_get=unreachable) as client:
        status, loc, message = refusal(client.get("/api/sources/statsbomb/competitions"))
    assert (status, loc) == (502, ["body", "source"])
    assert message.startswith("StatsBomb's open data could not be reached.")


# --- live fixtures -----------------------------------------------------------------------------


def test_live_fixtures_for_a_day(tmp_path):
    football = FootballService()
    with make_client(tmp_path, football=football) as client:
        fixtures = client.get("/api/sources/api_football/fixtures?date=2026-10-14").json()
        assert [(f["home"], f["away"], f["state"]) for f in fixtures] == [
            ("Real Madrid", "Sevilla", "finished"),
            ("Liverpool", "Everton", "live"),
            ("Arsenal", "Chelsea", "pre_match"),
        ]
        assert football.urls == [f"{FOOTBALL_BASE}/fixtures?date=2026-10-14"]
        liga = client.get(f"/api/sources/openligadb/fixtures?date={LIGA_DAY.isoformat()}").json()
        assert [(f["ref"], f["source"]) for f in liga] == [("83194", "openligadb"), ("83195", "openligadb")]


def test_live_fixtures_default_to_today(tmp_path):
    football = FootballService()
    with make_client(tmp_path, football=football) as client:
        assert client.get("/api/sources/api_football/fixtures").status_code == 200
    assert football.urls == [f"{FOOTBALL_BASE}/fixtures?date={date.today().isoformat()}"]


@pytest.mark.parametrize(
    "path, status",
    [
        ("/api/sources/sportapi/fixtures", 404),
        ("/api/sources/statsbomb/fixtures", 404),
        ("/api/sources/simulated/fixtures", 404),
        ("/api/sources/api_football/fixtures?date=2026-13-01", 422),
        ("/api/sources/api_football/fixtures?date=tomorrow", 422),
    ],
)
def test_fixtures_need_a_live_source_and_a_real_date(client, path, status):
    assert client.get(path).status_code == status


def test_a_live_source_without_its_key_is_a_409_with_its_setup(client_without_key):
    status, loc, message = refusal(client_without_key.get("/api/sources/api_football/fixtures"))
    assert (status, loc) == (409, ["body", "source"]) and "KICKSTREAM_API_FOOTBALL_KEY" in message


def test_a_source_failure_is_a_502_with_the_sources_message(tmp_path):
    with make_client(tmp_path, football=FootballService(refuse="errors-token.json")) as client:
        listed = client.get("/api/sources/api_football/fixtures?date=2026-10-14")
        started = client.post("/api/matches", json={"source": "api_football", "ref": "1035002", "speed": 1})
        assert client.get("/api/matches/current").status_code == 404
    for response in (listed, started):
        status, loc, message = refusal(response)
        assert (status, loc) == (502, ["body", "source"])
        assert (
            message.startswith("API-Football refused the request:")
            and "KICKSTREAM_API_FOOTBALL_KEY" in message
        )
        assert KEY not in response.text


def test_starting_a_live_match_without_its_key_is_a_409_and_starts_nothing(client_without_key):
    response = client_without_key.post("/api/matches", json={"source": "api_football", "ref": "1035002"})
    status, loc, message = refusal(response)
    assert (status, loc) == (409, ["body", "source"]) and "KICKSTREAM_API_FOOTBALL_KEY" in message
    assert client_without_key.get("/api/matches/current").status_code == 404


# --- whole matches -----------------------------------------------------------------------------


def test_a_statsbomb_replay_runs_through_the_whole_pipeline(client):
    response = client.post("/api/matches", json={"source": "statsbomb", "ref": "43/3/8658", "speed": 600})
    assert response.status_code == 201
    match_id = response.json()["match_id"]
    running = client.get("/api/sources").json()["running"]
    assert (running["match_id"], running["source"], running["ref"], running["title"]) == (
        match_id,
        "statsbomb",
        "43/3/8658",
        "France vs Croatia",
    )

    def recap():
        body = client.get(f"/api/matches/{match_id}/overlays/latest").json()
        return body.get("recap_card", {}).get("data", {}).get("title", "").startswith("Full-time")

    wait_for(recap, "the full-time recap card")
    status = statuses(client, match_id)[-1]
    assert (status.home.name, status.score_home, status.score_away, status.credit) == (
        "France",
        4,
        2,
        "Data: StatsBomb",
    )
    assert (status.state, status.source, status.detail) == ("finished", "statsbomb", "full")
    log = log_of(client, match_id)
    assert any(item.type == "narrative" and "France" in item.payload.text for item in log)
    wait_for(lambda: any(item.type == "pitch_scene" for item in log_of(client, match_id)), "a pitch scene")
    answer = client.post("/api/copilot/ask", json={"question": "What is the score?"}).json()
    assert "France" in answer["answer"]


def play_live(tmp_path) -> list:
    with make_client(tmp_path, poll_s=0.01) as client:
        response = client.post("/api/matches", json={"source": "api_football", "ref": "1035002", "speed": 1})
        assert response.status_code == 201
        match_id = response.json()["match_id"]
        assert client.get("/api/teams").json()["home"]["name"] == "Liverpool"
        wait_for(lambda: finished(client, match_id), "full time")
        assert client.get("/api/sources").json()["running"] is None
        return log_of(client, match_id)


def test_an_api_football_live_match_runs_to_full_time_without_position_data(tmp_path):
    log = play_live(tmp_path)
    status = [item.payload for item in log if item.type == "match_status"][-1]
    assert (status.score_home, status.score_away) == (2, 1)
    assert (status.source, status.detail, status.credit) == (
        "api_football",
        "key_events",
        "Data: API-Football",
    )
    assert not any(item.type == "pitch_scene" for item in log)
    stats = [item.payload for item in log if item.type == "stats"]
    assert stats and stats[-1].provided and "goals" in stats[-1].provided


def test_a_live_match_draws_no_pressure_map(tmp_path):
    assert not any(item.type == "pressure" for item in play_live(tmp_path))


# --- settings ----------------------------------------------------------------------------------


def test_the_sources_settings_come_from_the_environment():
    defaults = Settings.from_env({})
    assert defaults.api_football_key is None
    assert (
        defaults.statsbomb_url == OPEN_DATA == "https://raw.githubusercontent.com/hudl/open-data/master/data/"
    )
    assert defaults.api_football_url == "https://v3.football.api-sports.io"
    assert defaults.openligadb_url == "https://api.openligadb.de"
    assert (defaults.openligadb_leagues, defaults.live_poll_s) == (("bl1", "la1", "ucl"), None)
    custom = Settings.from_env(
        {
            "KICKSTREAM_API_FOOTBALL_KEY": KEY,
            "KICKSTREAM_STATSBOMB_URL": "http://127.0.0.1:8020/statsbomb/",
            "KICKSTREAM_API_FOOTBALL_URL": "http://127.0.0.1:8020/api-football",
            "KICKSTREAM_OPENLIGADB_URL": "http://127.0.0.1:8020/openligadb",
            "KICKSTREAM_OPENLIGADB_LEAGUES": " bl1, bl2 ,",
            "KICKSTREAM_LIVE_POLL_S": "1",
        }
    )
    assert custom.api_football_key == KEY and KEY not in repr(custom)
    assert custom.statsbomb_url == "http://127.0.0.1:8020/statsbomb/"
    assert custom.api_football_url == "http://127.0.0.1:8020/api-football"
    assert custom.openligadb_url == "http://127.0.0.1:8020/openligadb"
    assert (custom.openligadb_leagues, custom.live_poll_s) == (("bl1", "bl2"), 1.0)
    empty = Settings.from_env(
        {
            name: ""
            for name in (
                "KICKSTREAM_API_FOOTBALL_KEY",
                "KICKSTREAM_STATSBOMB_URL",
                "KICKSTREAM_API_FOOTBALL_URL",
                "KICKSTREAM_OPENLIGADB_URL",
                "KICKSTREAM_OPENLIGADB_LEAGUES",
                "KICKSTREAM_LIVE_POLL_S",
            )
        }
    )
    assert empty == defaults


def test_the_configured_addresses_are_the_ones_asked(tmp_path, monkeypatch):
    asked: list[str] = []

    def offline(request, timeout=None):
        asked.append(request.full_url)
        raise urllib.error.URLError("offline")

    monkeypatch.setattr(urllib.request, "urlopen", offline)
    configured = settings(
        tmp_path,
        api_football_key=KEY,
        statsbomb_url="http://sb.local/data/",
        api_football_url="http://af.local",
        openligadb_url="http://ol.local",
        openligadb_leagues=("bl1",),
    )
    with TestClient(create_app(configured, clock_factory=lambda speed: InstantClock(), feeds={})) as client:
        assert client.get("/api/sources/statsbomb/competitions").status_code == 502
        assert client.get("/api/sources/api_football/fixtures?date=2026-10-14").status_code == 502
        assert client.get("/api/sources/openligadb/fixtures?date=2026-10-14").status_code == 502
        football = client.get("/api/sources").json()["sources"][2]
    assert asked == [
        "http://sb.local/data/competitions.json",
        "http://af.local/fixtures?date=2026-10-14",
        "http://ol.local/getmatchdata/bl1",
    ]
    assert football["available"] is True and football["budget_used"] == 1
    saved = json.loads((tmp_path / "data" / "api-football-budget.json").read_text("utf-8"))
    assert saved["used"] == 1 and KEY not in json.dumps(saved)


def test_the_default_suite_cannot_reach_the_internet():
    with pytest.raises(AssertionError, match="internet"):
        urllib.request.urlopen("https://example.com")  # noqa: S310


def test_with_real_sources_off_only_synthetic_matches_are_offered(tmp_path):
    settings = Settings(
        None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data", real_sources=False
    )
    app = create_app(settings, clock_factory=lambda speed: InstantClock(), match_prefix="m")
    with TestClient(app) as client:
        assert [s["id"] for s in client.get("/api/sources").json()["sources"]] == ["simulated"]
        refused = client.post("/api/matches", json={"source": "statsbomb", "ref": "43/3/1", "speed": 1})
        assert refused.status_code in (404, 409, 422)
    assert Settings.from_env({"KICKSTREAM_REAL_SOURCES": "off"}).real_sources is False
    assert Settings.from_env({}).real_sources is True
