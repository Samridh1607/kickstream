import json
from pathlib import Path

from kickstream.adapters.statsbomb import convert, convert_events, formation, to_pitch
from kickstream.tools.trim_statsbomb import trim_events

FIX = Path(__file__).parent / "fixtures" / "statsbomb"


def load(name: str):
    return json.loads((FIX / name).read_text("utf-8"))


def final():
    listing = next(m for m in load("matches/43/3.json") if m["match_id"] == 8658)
    return convert("m-1", listing, load("lineups/8658.json"), load("events/8658.json"))


def sb(kind: str, period: int = 1, minute: int = 0, team: int = 1, **detail) -> dict:
    return {
        "type": {"name": kind},
        "period": period,
        "minute": minute,
        "second": 0,
        "team": {"id": team, "name": f"Team {team}"},
        **detail,
    }


def synthetic_extra_time() -> list[dict]:
    events = []
    for period, start in ((1, 0), (2, 45), (3, 90), (4, 105), (5, 120)):
        events += [sb("Half Start", period, start, 1), sb("Half Start", period, start, 2)]
        if period == 5:
            events.append(sb("Shot", 5, 120, 1, location=[108, 40], shot={"outcome": {"name": "Goal"}}))
        events += [sb("Half End", period, start + 15, 1), sb("Half End", period, start + 15, 2)]
    return events


def test_positions_are_scaled_and_away_events_turned_round():
    assert to_pitch([120, 80], "home") == (100.0, 100.0)
    assert to_pitch([120, 0], "away") == (0.0, 100.0)
    assert to_pitch([60, 40], "away") == (50.0, 50.0)


def test_formations_read_as_lines_from_the_back():
    assert formation(442) == "4-4-2"
    assert formation("4231") == "4-2-3-1"
    assert formation(None) is None


def test_france_are_at_home_with_their_starting_eleven_first():
    match = final()
    assert (match.home.name, match.away.name) == ("France", "Croatia")
    assert match.home.formation == "4-4-2" and match.home.id == "sb-771"
    assert match.away.formation == "4-3-3" and match.competition == "FIFA World Cup 2018"
    starters = [p for p in match.home.players if p.starting]
    assert len(starters) == 11 and match.home.players[:11] == starters
    lloris = next(p for p in match.home.players if p.name == "Hugo Lloris")
    assert (lloris.id, lloris.position, lloris.grid) == ("sb-3099", "GK", "1:1")
    assert len({p.id for p in match.home.players + match.away.players}) == 45


def test_the_bench_follows_by_shirt_number_with_the_position_first_played():
    bench = final().home.players[11:]
    assert [p.number for p in bench] == sorted(p.number for p in bench)
    assert not any(p.starting or p.grid for p in bench)
    fekir = next(p for p in bench if p.id == "sb-2948")
    kimpembe = next(p for p in bench if p.id == "sb-2999")
    assert (fekir.position, kimpembe.position) == ("FW", "MF")


def test_players_go_by_the_name_they_are_known_by():
    names = {p.name for p in final().home.players}
    assert {"Kylian Mbappé", "N'Golo Kanté"} <= names


def test_the_final_replays_to_four_two_with_the_own_goal_unnamed():
    goals = [e for e in final().events if e.type == "goal"]
    assert [e.team for e in goals].count("home") == 4 and [e.team for e in goals].count("away") == 2
    assert goals[0].minute == 17 and goals[0].team == "home" and goals[0].player_id is None
    assert all((e.x, e.y) == ((100.0, 50.0) if e.team == "home" else (0.0, 50.0)) for e in goals)


def test_a_scored_shot_carries_statsbomb_xg_and_is_followed_by_the_goal():
    events = final().events
    index = next(i for i, e in enumerate(events) if e.type == "shot" and e.outcome == "goal")
    assert events[index].xg is not None and events[index + 1].type == "goal"
    assert events[index + 1].player_id == events[index].player_id


def test_saves_corners_incomplete_passes_and_cards():
    events = final().events
    saves = [e for e in events if e.type == "save"]
    assert [e.team for e in saves] == ["away", "home", "away", "away"]
    assert (saves[0].x, saves[0].y) == (99.2, 50.0)
    assert sum(e.type == "corner" for e in events) == 8
    passes = [e for e in events if e.type == "pass"]
    assert any(e.completed for e in passes) and any(e.completed is False for e in passes)
    cards = [(e.type, e.team, e.minute) for e in events if e.type in ("yellow_card", "red_card")]
    assert cards == [("yellow_card", "home", 26), ("yellow_card", "away", 91)]
    fouls = [e for e in events if e.type == "foul"]
    assert [(e.team, e.minute) for e in fouls] == [("home", 26), ("away", 91)]


def test_substitutions_name_who_comes_on_and_are_unlocated():
    match = final()
    subs = [e for e in match.events if e.type == "substitution"]
    assert len(subs) == 5
    assert (subs[0].team, subs[0].player_id, subs[0].player_in_id) == ("home", "sb-3961", "sb-5737")
    assert all((e.x, e.y, e.located) == (50.0, 50.0, False) for e in subs)
    squad = {p.id for p in match.home.players + match.away.players}
    assert {e.player_in_id for e in subs} <= squad


def test_each_half_kicks_off_with_the_first_kick_off_pass_of_that_period():
    match = final()
    griezmann = next(p.id for p in match.home.players if p.name == "Antoine Griezmann")
    kickoffs = [
        (e.team, e.player_id, e.x, e.y, e.located, e.minute) for e in match.events if e.type == "kickoff"
    ]
    assert kickoffs == [("away", "sb-5472", 50.0, 50.0, True, 0), ("home", griezmann, 50.0, 50.0, True, 45)]


def test_periods_give_kickoffs_one_half_time_and_full_time_and_drop_the_shootout():
    types = [e.type for e in convert_events("m-1", synthetic_extra_time(), home_team_id=1)]
    assert types.count("kickoff") == 4 and types.count("half_time") == 1 and types[-1] == "full_time"
    assert types.count("full_time") == 1 and "shot" not in types


def test_a_second_yellow_is_a_red_card_and_bad_behaviour_cards_count():
    events = [
        sb("Foul Committed", team=2, location=[30, 20], foul_committed={"card": {"name": "Second Yellow"}}),
        sb("Bad Behaviour", team=1, bad_behaviour={"card": {"name": "Yellow Card"}}),
        sb("Bad Behaviour", team=1, bad_behaviour={}),
        sb("Foul Committed", team=1, location=[30, 20]),
    ]
    converted = convert_events("m-1", events, home_team_id=1)
    assert [(e.type, e.team) for e in converted] == [
        ("foul", "away"),
        ("red_card", "away"),
        ("yellow_card", "home"),
        ("foul", "home"),
    ]
    assert converted[0].located and not converted[2].located


def test_ids_are_sequential_and_file_order_is_kept():
    events = final().events
    assert [e.seq for e in events] == list(range(1, len(events) + 1))
    assert all(e.id == f"m-1-e{e.seq}" and e.match_id == "m-1" for e in events)
    stoppage_then_restart = [
        sb("Pass", 1, 48, 1, location=[60, 40], **{"pass": {}}),
        sb("Pass", 2, 45, 2, location=[60, 40], **{"pass": {"outcome": {"name": "Incomplete"}}}),
    ]
    converted = convert_events("m-1", stoppage_then_restart, home_team_id=1)
    assert [(e.minute, e.team, e.completed) for e in converted] == [(48, "home", True), (45, "away", False)]


def test_carries_and_pressures_are_left_out():
    events = [
        sb(kind, location=[60, 40])
        for kind in ("Carry", "Pressure", "Ball Receipt*", "Duel", "Own Goal Against")
    ]
    events.append(sb("Goal Keeper", location=[2, 40], goalkeeper={"type": {"name": "Collected"}}))
    assert convert_events("m-1", events, home_team_id=1) == []


def test_events_without_a_location_are_placed_at_the_centre_and_unlocated():
    converted = convert_events("m-1", [sb("Pass", team=1, **{"pass": {}})], home_team_id=1)
    assert (converted[0].x, converted[0].y, converted[0].located) == (50.0, 50.0, False)


def test_the_trim_keeps_what_the_conversion_reads_and_drops_the_bulk():
    shot = sb(
        "Shot",
        location=[108, 40],
        related_events=["a"],
        shot={"outcome": {"name": "Goal"}, "freeze_frame": []},
    )
    passes = [sb("Pass", location=[60, 40], **{"pass": {}}) for _ in range(6)]
    trimmed = trim_events([sb("Carry"), *passes, shot, sb("Pressure")])
    assert [e["type"]["name"] for e in trimmed] == ["Pass"] * 4 + ["Shot"]
    assert "related_events" not in trimmed[-1] and "freeze_frame" not in trimmed[-1]["shot"]
