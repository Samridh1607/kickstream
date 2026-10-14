import copy
import json
import urllib.error
from datetime import UTC, datetime
from pathlib import Path

import pytest

from kickstream.adapters.openligadb import (
    HALF_TIME_FROM,
    OPENLIGADB,
    SECOND_HALF_FROM,
    OpenLigaDb,
    estimated_minute,
    fixture_from,
    snapshot_from,
)
from kickstream.domain.teams import PALETTE
from kickstream.ports.match_source import SourceFailure

FIX = Path(__file__).parent / "fixtures" / "openligadb"
BASE = "https://ol.test"
KICKOFF = datetime(2026, 10, 10, 13, 30, tzinfo=UTC).timestamp()
AFTER = KICKOFF + 4 * 3600
DAY = datetime.fromtimestamp(KICKOFF).date()


def load(name: str):
    return json.loads((FIX / name).read_text("utf-8"))


def at(minutes: float) -> float:
    return KICKOFF + minutes * 60


class Served:
    def __init__(self, bodies: dict[str, object]) -> None:
        self.bodies, self.calls = bodies, []

    def __call__(self, url: str, headers) -> tuple[bytes, dict[str, str]]:
        self.calls.append((url, dict(headers)))
        body = self.bodies[url.removeprefix(BASE)]
        return (body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")), {}


def failing_get(url: str, headers) -> tuple[bytes, dict[str, str]]:
    raise urllib.error.URLError("no network")


def premier_league_match() -> dict:
    match = copy.deepcopy(load("match-83194.json"))
    match.update(
        matchID=90001,
        matchDateTimeUTC="2026-10-10T12:30:00Z",
        leagueName="Premier League 2026/2027",
        leagueShortcut="pl",
        matchIsFinished=False,
        goals=[],
        matchResults=[],
    )
    return match


def test_a_finished_match_has_both_teams_the_final_score_and_every_scorer():
    snap = snapshot_from(load("match-83194.json"), now=AFTER)
    assert (snap.home.name, snap.away.name, snap.score_home, snap.score_away, snap.state) == (
        "TSG Hoffenheim",
        "Hamburger SV",
        2,
        3,
        "finished",
    )
    assert snap.away.short_name == "HSV" and "Yussuf Poulsen" in {p.name for p in snap.away.players}
    assert (snap.home.id, snap.away.id, snap.home.short_name) == ("ol-175", "ol-100", "TSG")
    assert snap.competition == "1. Fußball-Bundesliga 2026/2027" and snap.kickoff_at == KICKOFF
    assert snap.stats is None and snap.provided == ()


def test_a_finished_match_ends_at_full_time_or_its_last_goal_not_at_the_clock():
    assert snapshot_from(load("match-83194.json"), now=AFTER).minute == 94
    early = copy.deepcopy(load("match-83194.json"))
    early["goals"] = early["goals"][:1]
    assert snapshot_from(early, now=AFTER).minute == 90


def test_scorers_are_midfielders_without_a_number_and_teams_get_palette_colours():
    snap = snapshot_from(load("match-83194.json"), now=AFTER)
    poulsen = next(p for p in snap.away.players if p.name == "Yussuf Poulsen")
    assert (poulsen.id, poulsen.number, poulsen.position, poulsen.starting) == ("ol-14513", 0, "MF", False)
    assert [p.name for p in snap.home.players] == ["B. Conté"]
    assert [p.name for p in snap.away.players] == ["Yussuf Poulsen", "T. Moffi", "M. Muheim"]
    assert snap.home.color != snap.away.color and {snap.home.color, snap.away.color} <= set(PALETTE)


def test_each_goal_is_given_to_the_side_whose_score_went_up():
    events = snapshot_from(load("match-83194.json"), now=AFTER).events
    assert [e.team for e in events] == ["away", "home", "home", "away", "away"]
    assert [e.minute for e in events] == [12, 51, 53, 83, 94]
    assert [e.key for e in events] == [
        "goal-149362",
        "goal-149367",
        "goal-149371",
        "goal-149378",
        "goal-149380",
    ]
    assert {e.type for e in events} == {"goal"}


def test_an_own_goal_names_no_scorer():
    snap = snapshot_from(load("match-83194.json"), now=AFTER)
    own_goal = snap.events[1]
    assert own_goal.team == "home" and own_goal.player_id is None
    assert "ol-18785" not in {p.id for p in snap.home.players + snap.away.players}


def test_goals_are_ordered_by_the_score_and_entries_that_raise_neither_score_are_left_out():
    match = copy.deepcopy(load("match-83194.json"))
    repeat = {**match["goals"][0], "goalID": 149999}
    match["goals"] = [match["goals"][2], repeat, *reversed(match["goals"][:2]), *match["goals"][3:]]
    events = snapshot_from(match, now=AFTER).events
    assert [e.key for e in events] == [
        "goal-149362",
        "goal-149367",
        "goal-149371",
        "goal-149378",
        "goal-149380",
    ]


def test_events_keep_their_keys_from_poll_to_poll():
    first = snapshot_from(load("match-live-1.json"), now=at(20))
    later = snapshot_from(load("match-live-2.json"), now=at(70))
    assert {e.key for e in first.events} < {e.key for e in later.events}
    assert (later.state, later.minute, later.score_home, later.score_away) == ("live", 53, 2, 1)


@pytest.mark.parametrize(
    "minutes, state, minute",
    [(-10, "pre_match", 0), (20, "live", 20), (50, "half_time", 45), (80, "live", 63)],
)
def test_the_state_and_minute_are_estimated_from_the_kick_off(minutes, state, minute):
    snap = snapshot_from(load("match-live-1.json"), now=at(minutes))
    assert (snap.state, snap.minute) == (state, minute)


@pytest.mark.parametrize(
    "minutes, expected",
    [
        (-5, 0),
        (0, 0),
        (30, 30),
        (46, 45),
        (HALF_TIME_FROM, 45),
        (SECOND_HALF_FROM - 1, 45),
        (70, 53),
        (110, 93),
    ],
)
def test_the_minute_holds_at_45_through_the_break(minutes, expected):
    assert estimated_minute(KICKOFF, at(minutes)) == expected


def test_half_time_needs_the_half_time_result():
    match = copy.deepcopy(load("match-live-1.json"))
    match["matchResults"] = []
    assert snapshot_from(match, now=at(50)).state == "live"


def test_a_second_half_goal_ends_the_break_early():
    snap = snapshot_from(load("match-live-2.json"), now=at(55))
    assert (snap.state, snap.minute) == ("live", 53)


def test_a_finished_match_takes_the_final_result_over_the_goal_list():
    match = copy.deepcopy(load("match-83194.json"))
    match["goals"] = match["goals"][:2]
    snap = snapshot_from(match, now=AFTER)
    assert (snap.score_home, snap.score_away) == (2, 3)


def test_a_match_without_goals_is_goalless():
    match = premier_league_match()
    snap = snapshot_from(match, now=datetime(2026, 10, 10, 13, 0, tzinfo=UTC).timestamp())
    assert (snap.state, snap.minute, snap.score_home, snap.score_away, snap.events) == ("live", 30, 0, 0, ())
    assert snap.home.players == [] and snap.away.players == []


def test_a_fixture_shows_the_score_only_once_the_match_has_started():
    finished = fixture_from(load("match-83194.json"), now=AFTER)
    assert (finished.ref, finished.source, finished.state) == ("83194", "openligadb", "finished")
    assert (finished.home, finished.away, finished.score_home, finished.score_away) == (
        "TSG Hoffenheim",
        "Hamburger SV",
        2,
        3,
    )
    assert finished.minute is None and finished.competition == "1. Fußball-Bundesliga 2026/2027"
    waiting = fixture_from(load("match-83194.json") | {"matchIsFinished": False}, now=at(-30))
    assert (waiting.state, waiting.minute, waiting.score_home, waiting.score_away) == (
        "pre_match",
        None,
        None,
        None,
    )
    playing = fixture_from(load("match-live-2.json"), now=at(70))
    assert (playing.state, playing.minute, playing.score_home, playing.score_away) == ("live", 53, 2, 1)


async def test_fixtures_are_the_days_matches_across_the_chosen_leagues():
    served = Served(
        {"/getmatchdata/bl1": load("getmatchdata-bl1.json"), "/getmatchdata/pl": [premier_league_match()]}
    )
    source = OpenLigaDb(("bl1", "pl"), base_url=BASE, get=served, now=lambda: AFTER)
    fixtures = await source.fixtures(DAY)
    assert [f.ref for f in fixtures] == ["90001", "83194", "83195"]
    assert [f.competition for f in fixtures] == [
        "Premier League 2026/2027",
        "1. Fußball-Bundesliga 2026/2027",
        "1. Fußball-Bundesliga 2026/2027",
    ]
    assert served.calls == [(f"{BASE}/getmatchdata/bl1", {}), (f"{BASE}/getmatchdata/pl", {})]


async def test_a_snapshot_reads_the_match_by_its_id():
    served = Served({"/getmatchdata/83194": load("match-83194.json")})
    snap = await OpenLigaDb(base_url=BASE, get=served, now=lambda: AFTER).snapshot("83194")
    assert (snap.state, snap.score_home, snap.score_away) == ("finished", 2, 3)
    assert served.calls == [(f"{BASE}/getmatchdata/83194", {})]


@pytest.mark.parametrize("ref", ["", "83194/1", "../x", "bl1", "８３１９４", " 83194"])
async def test_refs_that_are_not_a_match_id_are_refused_without_asking(ref):
    served = Served({})
    with pytest.raises(SourceFailure, match="OpenLigaDB has no match"):
        await OpenLigaDb(base_url=BASE, get=served).snapshot(ref)
    assert served.calls == []


@pytest.mark.parametrize("body", [None, [], {}])
async def test_an_unknown_match_is_refused(body):
    served = Served({"/getmatchdata/1": body})
    with pytest.raises(SourceFailure, match=r"OpenLigaDB has no match 1\. Choose one from the list\."):
        await OpenLigaDb(base_url=BASE, get=served).snapshot("1")


async def test_a_failure_says_openligadb_could_not_be_reached():
    source = OpenLigaDb(base_url=BASE, get=failing_get)
    with pytest.raises(SourceFailure, match="OpenLigaDB could not be reached"):
        await source.snapshot("83194")
    with pytest.raises(SourceFailure, match="OpenLigaDB could not be reached"):
        await source.fixtures(DAY)


@pytest.mark.parametrize("body", [b"<html>busy</html>", {"matchID": 83194}, [{"matchID": 1}]])
async def test_an_answer_it_cannot_read_says_so(body):
    served = Served({"/getmatchdata/83194": body, "/getmatchdata/bl1": body})
    source = OpenLigaDb(("bl1",), base_url=BASE, get=served, now=lambda: AFTER)
    with pytest.raises(SourceFailure, match="could not read"):
        if isinstance(body, list):
            await source.fixtures(DAY)
        else:
            await source.snapshot("83194")


def test_openligadb_is_free_unlimited_and_credited():
    source = OpenLigaDb()
    assert (source.id, source.name, source.credit) == ("openligadb", "OpenLigaDB", "Data: OpenLigaDB")
    assert source.available and source.setup is None and source.budget() is None
    assert (source.poll.live_s, source.poll.half_time_s) == (60, 180)
    assert OPENLIGADB == "https://api.openligadb.de"


async def test_the_default_leagues_are_the_premier_league_laliga_and_the_champions_league():
    served = Served({f"/getmatchdata/{league}": [] for league in ("pl", "la1", "ucl")})
    assert await OpenLigaDb(base_url=BASE, get=served).fixtures(DAY) == []
    assert [url for url, _ in served.calls] == [
        f"{BASE}/getmatchdata/{league}" for league in ("pl", "la1", "ucl")
    ]
