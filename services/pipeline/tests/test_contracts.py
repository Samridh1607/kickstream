from pathlib import Path

import pytest
from pydantic import ValidationError

from kickstream.contracts import (
    MatchEvent,
    MatchListing,
    MatchStatus,
    PlayerMetrics,
    PlayerReport,
    PlayEvent,
    StatsSnapshot,
)
from kickstream.tools.gen_contracts import TARGET, render
from tests.factories import stats

OLD_STATUS = {
    "match_id": "m-1",
    "state": "finished",
    "minute": 90,
    "score_home": 1,
    "score_away": 0,
    "speed": 30,
    "home": {"id": "nbr", "name": "Northbridge FC", "short_name": "NBR", "color": "#0F6CBD", "players": []},
    "away": {"id": "hbc", "name": "Harbour City", "short_name": "HBC", "color": "#C50F1F", "players": []},
}


def _normalized(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def test_generated_contracts_are_current(tmp_path):
    fresh = tmp_path / "contracts.py"
    render(fresh)
    assert _normalized(fresh) == _normalized(TARGET), "run: uv run python -m kickstream.tools.gen_contracts"


def test_match_event_accepts_minimal_event_and_defaults_nullables():
    event = MatchEvent(id="m-1-e1", match_id="m-1", seq=1, minute=0, second=0, type="half_time", x=50, y=50)
    assert event.team is None
    assert event.player_id is None
    assert event.outcome is None


def test_models_reject_unknown_fields_and_values():
    base = dict(id="e", match_id="m", seq=1, minute=0, second=0, type="pass", x=1, y=1)
    with pytest.raises(ValidationError):
        MatchEvent(**base, bogus=1)
    with pytest.raises(ValidationError):
        MatchEvent(**{**base, "type": "handball"})


def test_overlay_data_resolves_to_the_matching_shape():
    from kickstream.contracts import Overlay, PressureMapData, StatCardData

    stat = Overlay(
        id="o1",
        match_id="m",
        minute=5,
        kind="stat_card",
        duration_ms=8000,
        sources=[],
        data={"stat_rows": [{"label": "Shots", "home": 3, "away": 1}]},
    )
    heat = Overlay(
        id="o2",
        match_id="m",
        minute=5,
        kind="pressure_map",
        duration_ms=8000,
        sources=[],
        data={"cols": 6, "rows": 4, "home": [0.0] * 24, "away": [0.0] * 24},
    )
    assert isinstance(stat.data, StatCardData)
    assert isinstance(heat.data, PressureMapData)


def test_recap_requires_exactly_three_bullets():
    from kickstream.contracts import Recap

    fields = dict(
        id="r",
        match_id="m",
        minute=45,
        period="half_time",
        mode="fan",
        language="en",
        title="t",
        text="x",
        source="scripted",
        agent="scripted",
        score_home=0,
        score_away=0,
    )
    with pytest.raises(ValidationError):
        Recap(**fields, bullets=["a", "b"])
    assert len(Recap(**fields, bullets=["a", "b", "c"]).bullets) == 3


def test_a_status_saved_before_real_data_still_loads_as_a_simulated_full_match():
    status = MatchStatus.model_validate(OLD_STATUS)
    assert (status.source, status.detail) == ("simulated", "full")
    assert (status.credit, status.competition, status.home.formation) == (None, None, None)


def test_a_saved_squad_player_loads_as_not_starting_and_without_a_grid_place():
    player = {"id": "nbr-1", "name": "A. Keeper", "number": 1, "position": "GK"}
    status = MatchStatus.model_validate({**OLD_STATUS, "home": {**OLD_STATUS["home"], "players": [player]}})
    assert (status.home.players[0].starting, status.home.players[0].grid) == (False, None)


def test_a_match_can_be_waiting_for_kick_off():
    assert MatchStatus.model_validate({**OLD_STATUS, "state": "pre_match"}).state == "pre_match"


def test_events_default_to_located_without_their_own_xg():
    event = MatchEvent(id="m-1-e1", match_id="m-1", seq=1, minute=0, second=0, type="pass", x=50, y=50)
    assert event.located is True and event.xg is None


def test_plays_carry_the_events_xg_and_location_flag():
    play = PlayEvent(
        id="m-1-p1",
        match_id="m-1",
        minute=3,
        second=0,
        event_id="m-1-e1",
        type="shot",
        x=88,
        y=50,
        zone="attacking_third",
        lane="centre",
        phase="final_third",
        sequence=1,
        sequence_length=1,
        danger=0.4,
    )
    assert (play.xg, play.located) == (None, True)
    assert play.model_copy(update={"xg": 0.31, "located": False}).xg == 0.31


def test_a_match_listing_cannot_carry_a_score():
    with pytest.raises(ValidationError):
        MatchListing(ref="43/3/8658", date="2018-07-15", home="France", away="Croatia", home_score=4)


def _metrics(n: int) -> dict:
    return PlayerMetrics(
        player_id=f"sb-{n}",
        team="home" if n % 2 else "away",
        name=f"Player {n}",
        number=n,
        position="MF",
        on_pitch=n < 22,
        touches=0,
        passes=0,
        pass_accuracy=0.0,
        shots=0,
        shots_on_target=0,
        goals=0,
        xg=0.0,
        fouls=0,
        yellow_cards=0,
        red_cards=0,
        rating=6.0,
        heat=[],
    ).model_dump()


def test_a_player_report_holds_two_real_squads():
    report = {"id": "m-1-pr1", "match_id": "m-1", "minute": 1, "cols": 6, "rows": 4}
    two_squads = PlayerReport.model_validate({**report, "players": [_metrics(n) for n in range(52)]})
    assert len(two_squads.players) == 52
    with pytest.raises(ValidationError):
        PlayerReport.model_validate({**report, "players": [_metrics(n) for n in range(61)]})


def test_stats_say_which_fields_the_source_measured():
    snapshot = stats().model_dump()
    assert StatsSnapshot.model_validate(snapshot).provided is None
    measured = StatsSnapshot.model_validate({**snapshot, "provided": ["goals", "possession"]})
    assert measured.provided == ["goals", "possession"]
    with pytest.raises(ValidationError):
        StatsSnapshot.model_validate({**snapshot, "provided": ["corners"]})
