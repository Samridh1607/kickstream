import copy
import json
import urllib.error
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from kickstream.adapters.api_football import (
    DAILY_LIMIT,
    LIST_FRESH_S,
    ApiFootball,
    DailyBudget,
    errors_message,
    fixture_listing,
    snapshot_from,
)
from kickstream.adapters.json_record_store import JsonRecordStore
from kickstream.contracts import Player
from kickstream.ports.match_source import PollPlan, SourceFailure, SourceUnavailable

FIX = Path(__file__).parent / "fixtures" / "api_football"
BASE = "https://af.test"
NOON = datetime(2026, 10, 14, 12, tzinfo=UTC).timestamp()
MIDNIGHT = datetime(2026, 10, 15, tzinfo=UTC).timestamp()
KEY = "secret-key-123"


def load(name: str) -> dict:
    return json.loads((FIX / name).read_text("utf-8"))


class Recorded:
    """Answers every request with one fixture file, a body, or an exception, and remembers what was sent."""

    def __init__(self, answer: str | bytes | Exception, headers: dict[str, str] | None = None) -> None:
        self.answer = answer
        self.reply_headers = headers or {}
        self.urls: list[str] = []
        self.headers: list[dict[str, str]] = []

    def __call__(self, url: str, headers) -> tuple[bytes, dict[str, str]]:
        self.urls.append(url)
        self.headers.append(dict(headers))
        if isinstance(self.answer, Exception):
            raise self.answer
        body = self.answer if isinstance(self.answer, bytes) else (FIX / self.answer).read_bytes()
        return body, dict(self.reply_headers)


def budget(tmp_path: Path, now=lambda: NOON, limit: int = DAILY_LIMIT) -> DailyBudget:
    return DailyBudget(JsonRecordStore(tmp_path / "budget.json"), limit=limit, now=now)


def source(tmp_path: Path, get, key: str | None = KEY, spent: DailyBudget | None = None, now=lambda: NOON):
    return ApiFootball(key, spent or budget(tmp_path, now), base_url=BASE, get=get, now=now)


def http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(f"{BASE}/fixtures?id=1035002", code, "refused", None, None)


def test_a_live_fixture_becomes_a_snapshot_with_line_ups_and_colours():
    snap = snapshot_from(load("fixture-1.json"))
    assert (snap.state, snap.minute, snap.score_home, snap.score_away) == ("live", 12, 0, 0)
    assert snap.home.formation == "4-3-3" and sum(p.starting for p in snap.home.players) == 11
    assert snap.home.players[0].grid == "1:1" and snap.home.color.startswith("#")
    assert (snap.home.id, snap.home.name, snap.home.short_name) == ("af-40", "Liverpool", "LIV")
    assert (snap.home.color, snap.away.color) == ("#C8102E", "#003399")
    assert snap.home.players[0] == Player(
        id="af-4001", name="T. Hale", number=1, position="GK", starting=True, grid="1:1"
    )
    assert snap.home.players[-1] == Player(id="af-4014", name="C. Byrne", number=62, position="GK")
    assert [p.position for p in snap.home.players[:11]] == ["GK"] + ["DF"] * 4 + ["MF"] * 3 + ["FW"] * 3
    assert snap.away.formation == "4-2-3-1" and len(snap.away.players) == 14
    assert snap.competition == "Premier League (England)" and snap.kickoff_at == 1792002600
    assert snap.events == ()


def test_goals_cards_and_substitutions_are_key_events_with_stable_keys():
    first, later = snapshot_from(load("fixture-2.json")), snapshot_from(load("fixture-4.json"))
    assert {e.key for e in first.events} <= {e.key for e in later.events}
    assert [e.type for e in later.events].count("red_card") == 1  # the second yellow
    assert [(e.minute, e.type, e.team, e.player_id, e.player_in_id) for e in later.events] == [
        (23, "goal", "home", "af-4010", None),
        (30, "yellow_card", "away", "af-4506", None),
        (58, "goal", "away", "af-4511", None),
        (64, "substitution", "home", "af-4011", "af-4012"),
        (78, "red_card", "away", "af-4506", None),
        (88, "goal", "home", "af-4012", None),
        (92, "yellow_card", "home", "af-4003", None),
    ]
    assert first.events[0].key == "23-None-Goal-Normal Goal-40-4010"
    assert later.events[-1].key == "90-2-Card-Yellow Card-40-4003"


def test_a_missed_penalty_and_var_decisions_are_not_events():
    body = load("fixture-2.json")
    missed = copy.deepcopy(body["response"][0]["events"][0]) | {"detail": "Missed Penalty"}
    var = copy.deepcopy(body["response"][0]["events"][0]) | {"type": "Var", "detail": "Goal cancelled"}
    body["response"][0]["events"] += [missed, var]
    assert len(snapshot_from(body).events) == 2


def test_an_own_goal_counts_for_the_team_it_is_listed_under_and_names_no_scorer():
    body = load("fixture-2.json")
    body["response"][0]["events"][0]["detail"] = "Own Goal"
    goal = snapshot_from(body).events[0]
    assert (goal.type, goal.team, goal.player_id) == ("goal", "home", None)


def test_a_player_missing_from_the_line_ups_is_added_from_the_events():
    body = load("fixture-4.json")
    body["response"][0]["lineups"] = []
    snap = snapshot_from(body)
    assert snap.home.players[0] == Player(id="af-4010", name="C. Gallo", number=0, position="MF")
    assert [p.id for p in snap.home.players] == ["af-4010", "af-4011", "af-4012", "af-4003"]
    assert [p.id for p in snap.away.players] == ["af-4506", "af-4511"]
    assert snap.home.formation is None and snap.home.color != snap.away.color


@pytest.mark.parametrize(
    "name, expected",
    [("fixture-3.json", ("half_time", 45, 1, 0)), ("fixture-4.json", ("finished", 90, 2, 1))],
)
def test_half_time_and_full_time(name, expected):
    snap = snapshot_from(load(name))
    assert (snap.state, snap.minute, snap.score_home, snap.score_away) == expected


def test_stoppage_time_is_added_to_the_minute():
    body = load("fixture-2.json")
    body["response"][0]["fixture"]["status"] |= {"elapsed": 45, "extra": 3}
    assert snapshot_from(body).minute == 48


@pytest.mark.parametrize("short", ["PST", "CANC", "ABD"])
def test_a_postponed_or_cancelled_match_is_refused(short):
    body = load("fixture-1.json")
    body["response"][0]["fixture"]["status"]["short"] = short
    with pytest.raises(SourceFailure, match=rf"postponed or cancelled \({short}\)"):
        snapshot_from(body)


def test_an_answer_that_does_not_fit_the_documented_shape_is_refused():
    body = load("fixture-1.json")
    body["response"][0]["fixture"]["status"]["short"] = "??"
    with pytest.raises(SourceFailure, match="could not read"):
        snapshot_from(body)
    with pytest.raises(SourceFailure, match="could not read"):
        fixture_listing({"response": [{"fixture": {}}]})


def test_statistics_say_what_was_measured():
    snap = snapshot_from(load("fixture-1.json"))
    home, _ = snap.stats
    assert home.possession == 55.0 and "possession" in snap.provided and "xg" not in snap.provided
    assert home.model_dump(
        include={"goals", "shots", "shots_on_target", "passes", "pass_accuracy", "fouls"}
    ) == {
        "goals": 0,
        "shots": 3,
        "shots_on_target": 1,
        "passes": 88,
        "pass_accuracy": 86.0,
        "fouls": 2,
    }
    measured = ("goals", "possession", "shots", "shots_on_target", "passes", "pass_accuracy", "fouls")
    assert snap.provided == measured


def test_a_stat_one_side_has_counts_for_both_and_goals_follow_the_score():
    snap = snapshot_from(load("fixture-4.json"))
    home, away = snap.stats
    assert (home.goals, away.goals, home.xg, away.xg) == (2, 1, 2.04, 1.12)
    assert (home.red_cards, away.red_cards) == (0, 1)
    assert {"xg", "red_cards", "yellow_cards"} <= set(snap.provided)


def test_without_statistics_the_stats_are_left_to_the_events():
    body = load("fixture-1.json")
    body["response"][0]["statistics"] = []
    snap = snapshot_from(body)
    assert snap.stats is None and snap.provided == ()


def test_the_days_fixtures_are_listed_with_their_state():
    listing = fixture_listing(load("fixtures-date.json"))
    assert [(f.ref, f.source, f.competition, f.home, f.away) for f in listing] == [
        ("1035003", "api_football", "La Liga (Spain)", "Real Madrid", "Sevilla"),
        ("1035002", "api_football", "Premier League (England)", "Liverpool", "Everton"),
        ("1035001", "api_football", "Premier League (England)", "Arsenal", "Chelsea"),
    ]
    assert [(f.state, f.minute, f.score_home, f.score_away) for f in listing] == [
        ("finished", 90, 2, 1),
        ("live", 12, 0, 0),
        ("pre_match", None, None, None),
    ]
    assert [f.kickoff_at for f in listing] == [1791986400, 1792002600, 1792004400]


def test_errors_are_read_from_a_dict_or_a_list_of_dicts():
    assert errors_message({"errors": [], "response": []}) is None
    assert errors_message({"errors": {}}) is None
    text, key = errors_message(load("errors-plan.json"))
    assert key == "plan"
    assert text == (
        "API-Football refused the request: Free plans do not have access to this season, try from 2022 to 2024. "
        "The free plan does not cover this match. Choose another, or use StatsBomb or OpenLigaDB."
    )
    text, key = errors_message({"errors": [{"rateLimit": "Too many requests."}]})
    assert key == "rateLimit" and text.endswith("Kickstream will try again shortly.")
    text, key = errors_message({"errors": {"date": "The Date field must be a valid date."}})
    assert (text, key) == ("API-Football refused the request: The Date field must be a valid date.", "date")


@pytest.mark.parametrize(
    "name, hint",
    [
        ("errors-plan.json", "free plan"),
        ("errors-token.json", "KICKSTREAM_API_FOOTBALL_KEY"),
        ("errors-requests.json", "midnight UTC"),
    ],
)
async def test_api_footballs_own_errors_are_shown_with_what_to_do(tmp_path, name, hint):
    with pytest.raises(SourceFailure, match="API-Football refused the request") as caught:
        await source(tmp_path, Recorded(name)).snapshot("1035002")
    assert hint in caught.value.message
    expected_wait = MIDNIGHT - NOON if name == "errors-requests.json" else None
    assert caught.value.retry_after == expected_wait


async def test_a_spent_day_reported_by_api_football_spends_the_budget(tmp_path):
    spent = budget(tmp_path)
    with pytest.raises(SourceFailure):
        await source(tmp_path, Recorded("errors-requests.json"), spent=spent).snapshot("1035002")
    assert spent.used() == DAILY_LIMIT


@pytest.mark.parametrize(
    "failure, says, wait",
    [
        (http_error(401), "Check KICKSTREAM_API_FOOTBALL_KEY in the .env file.", None),
        (http_error(403), "Check KICKSTREAM_API_FOOTBALL_KEY in the .env file.", None),
        (http_error(429), "Kickstream will try again shortly.", 60),
        (http_error(500), "API-Football could not be reached. Kickstream will keep trying.", None),
        (http_error(503), "API-Football could not be reached. Kickstream will keep trying.", None),
        (urllib.error.URLError("no network"), "API-Football could not be reached.", None),
        (TimeoutError("timed out"), "API-Football could not be reached.", None),
    ],
)
async def test_http_failures_say_what_to_do(tmp_path, failure, says, wait):
    with pytest.raises(SourceFailure) as caught:
        await source(tmp_path, Recorded(failure)).snapshot("1035002")
    assert says in caught.value.message and caught.value.retry_after == wait


async def test_an_answer_that_is_not_json_is_refused(tmp_path):
    with pytest.raises(SourceFailure, match="could not read"):
        await source(tmp_path, Recorded(b"<html>busy</html>")).fixtures(date(2026, 10, 14))


async def test_a_fixture_api_football_does_not_know_is_refused(tmp_path):
    with pytest.raises(SourceFailure, match=r"API-Football has no fixture 77\. Choose one from the list\."):
        await source(tmp_path, Recorded(b'{"errors": [], "response": []}')).snapshot("77")


@pytest.mark.parametrize("ref", ["", "abc", "10/35", "1035002 ", "-1", "１２"])
async def test_refs_that_are_not_digits_are_refused_without_a_request(tmp_path, ref):
    seen = Recorded("fixture-1.json")
    with pytest.raises(SourceFailure, match="API-Football has no fixture"):
        await source(tmp_path, seen).snapshot(ref)
    assert seen.urls == []


async def test_a_snapshot_asks_for_the_fixture_by_id(tmp_path):
    seen = Recorded("fixture-2.json")
    snap = await source(tmp_path, seen).snapshot("1035002")
    assert seen.urls == [f"{BASE}/fixtures?id=1035002"] and snap.score_home == 1


async def test_every_request_is_counted_and_the_counter_follows_the_api(tmp_path):
    spent = budget(tmp_path)
    seen = Recorded("fixture-1.json", headers={"x-ratelimit-requests-remaining": "90"})
    api = source(tmp_path, seen, spent=spent)
    await api.snapshot("1035")
    assert spent.used() == 10 and api.budget() == (10, DAILY_LIMIT)
    await source(tmp_path, Recorded("fixture-1.json"), spent=spent).snapshot("1035")
    assert spent.used() == 11


async def test_a_spent_budget_refuses_before_asking_and_says_when_it_resets(tmp_path):
    spent = budget(tmp_path)
    spent.sync(0)
    seen = Recorded("fixture-1.json")
    with pytest.raises(SourceFailure, match="midnight UTC") as caught:
        await source(tmp_path, seen, spent=spent).snapshot("1035002")
    assert seen.urls == [] and caught.value.retry_after == MIDNIGHT - NOON
    with pytest.raises(SourceFailure, match="midnight UTC"):
        await source(tmp_path, seen, spent=spent).fixtures(date(2026, 10, 14))
    assert seen.urls == []


def test_the_budget_resets_at_midnight_utc(tmp_path):
    clock = [NOON]
    spent = budget(tmp_path, now=lambda: clock[0], limit=2)
    spent.take()
    spent.take()
    with pytest.raises(SourceFailure) as caught:
        spent.take()
    assert caught.value.retry_after == MIDNIGHT - NOON and spent.used() == 2
    clock[0] = MIDNIGHT + 1
    assert spent.used() == 0
    spent.take()
    assert spent.used() == 1


def test_the_budget_survives_a_restart_and_ignores_headers_it_cannot_read(tmp_path):
    budget(tmp_path).take()
    restarted = budget(tmp_path)
    assert restarted.used() == 1
    restarted.sync(None)
    assert restarted.used() == 1
    restarted.sync(250)
    assert restarted.used() == 0
    restarted.sync(97)
    assert budget(tmp_path).used() == 3


async def test_an_unreadable_rate_limit_header_leaves_the_count_alone(tmp_path):
    spent = budget(tmp_path)
    seen = Recorded("fixture-1.json", headers={"x-ratelimit-requests-remaining": "lots"})
    await source(tmp_path, seen, spent=spent).snapshot("1035002")
    assert spent.used() == 1


async def test_the_days_fixture_list_is_reused_for_ten_minutes(tmp_path):
    clock = [NOON]
    spent = budget(tmp_path, now=lambda: clock[0])
    seen = Recorded("fixtures-date.json")
    api = source(tmp_path, seen, spent=spent, now=lambda: clock[0])
    first = await api.fixtures(date(2026, 10, 14))
    clock[0] += LIST_FRESH_S - 1
    assert await api.fixtures(date(2026, 10, 14)) == first
    assert seen.urls == [f"{BASE}/fixtures?date=2026-10-14"] and spent.used() == 1
    await api.fixtures(date(2026, 10, 15))
    clock[0] += 1
    await api.fixtures(date(2026, 10, 14))
    assert seen.urls[1:] == [f"{BASE}/fixtures?date=2026-10-15", f"{BASE}/fixtures?date=2026-10-14"]
    assert spent.used() == 3


async def test_the_key_is_sent_only_as_its_header_and_never_shown(tmp_path):
    seen = Recorded("errors-token.json")
    with pytest.raises(SourceFailure) as caught:
        await ApiFootball(KEY, budget(tmp_path), get=seen).fixtures(date(2026, 10, 14))
    assert seen.headers == [{"x-apisports-key": KEY}]
    assert KEY not in seen.urls[0]
    assert KEY not in str(caught.value) and KEY not in repr(ApiFootball(KEY, budget(tmp_path)))


async def test_the_key_is_kept_out_of_messages_even_when_api_football_repeats_it(tmp_path):
    echoed = json.dumps({"errors": {"token": f"The key {KEY} is not valid."}, "response": []}).encode()
    with pytest.raises(SourceFailure) as caught:
        await source(tmp_path, Recorded(echoed)).snapshot("1035002")
    assert KEY not in caught.value.message and "is not valid" in caught.value.message


async def test_without_a_key_it_says_how_to_get_one(tmp_path):
    spent = budget(tmp_path)
    seen = Recorded("fixtures-date.json")
    for key in (None, ""):
        api = source(tmp_path, seen, key=key, spent=spent)
        assert not api.available
        assert "KICKSTREAM_API_FOOTBALL_KEY=<your key>" in api.setup
        assert "https://dashboard.api-football.com/register" in api.setup
        with pytest.raises(SourceUnavailable) as caught:
            await api.fixtures(date(2026, 10, 14))
        assert caught.value.message == api.setup
        with pytest.raises(SourceUnavailable):
            await api.snapshot("1035002")
    assert seen.urls == [] and spent.used() == 0
    assert source(tmp_path, seen).available and source(tmp_path, seen).setup is None


def test_it_describes_itself_as_a_live_source(tmp_path):
    api = source(tmp_path, Recorded("fixture-1.json"))
    assert (api.id, api.name, api.credit) == ("api_football", "API-Football", "Data: API-Football")
    assert api.poll == PollPlan(pre_match_s=600, soon_s=120, live_s=90, half_time_s=300)
    assert api.budget() == (0, DAILY_LIMIT)
