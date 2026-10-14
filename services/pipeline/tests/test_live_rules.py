from kickstream.contracts import MatchEvent, MatchStatus, StatsSnapshot, TeamStats
from kickstream.domain.teams import AWAY, HOME
from kickstream.live.rules import LiveProgress, advance
from kickstream.ports.match_source import LiveEvent, LiveSnapshot


def live(state, minute, score, events=(), stats=None, provided=()):
    return LiveSnapshot(
        state=state,
        minute=minute,
        score_home=score[0],
        score_away=score[1],
        home=HOME,
        away=AWAY,
        competition="Bundesliga",
        kickoff_at=1_800_000_000.0,
        events=tuple(events),
        stats=stats,
        provided=tuple(provided),
    )


def goal(key, minute, team, player_id=None):
    return LiveEvent(key=key, minute=minute, type="goal", team=team, player_id=player_id)


def card(key, minute, team, kind="yellow_card"):
    return LiveEvent(key=key, minute=minute, type=kind, team=team)


def _progress():
    return LiveProgress("m-1", "api_football", "Data: API-Football")


def _kinds(out):
    return [type(o).__name__ for o in out]


def _events(out):
    return [(o.type, o.minute) for o in out if isinstance(o, MatchEvent)]


def _stats(goals=0, shots=0):
    return TeamStats(
        goals=goals,
        possession=50.0,
        shots=shots,
        shots_on_target=0,
        passes=0,
        pass_accuracy=0.0,
        fouls=0,
        yellow_cards=0,
        red_cards=0,
        xg=0.0,
    )


def test_the_first_snapshot_announces_a_key_events_match_with_its_credit():
    out = advance(_progress(), live("pre_match", 0, (0, 0)))
    status = next(o for o in out if isinstance(o, MatchStatus))
    assert (status.match_id, status.source, status.detail, status.credit) == (
        "m-1",
        "api_football",
        "key_events",
        "Data: API-Football",
    )
    assert (status.competition, status.speed, status.state, status.minute) == (
        "Bundesliga",
        1.0,
        "pre_match",
        0,
    )
    assert (status.score_home, status.score_away, status.home, status.away) == (0, 0, HOME, AWAY)
    assert _events(out) == []


def test_kick_off_half_time_second_half_and_full_time_become_events():
    progress = _progress()
    advance(progress, live("pre_match", 0, (0, 0)))
    assert _events(advance(progress, live("live", 2, (0, 0)))) == [("kickoff", 0)]
    assert _events(advance(progress, live("half_time", 47, (0, 0)))) == [("half_time", 45)]
    assert _events(advance(progress, live("live", 46, (0, 0)))) == [("kickoff", 45)]
    assert _events(advance(progress, live("finished", 94, (0, 0)))) == [("full_time", 94)]
    assert progress.status.state == "finished"


def test_published_events_are_unlocated_and_numbered_in_order():
    progress = _progress()
    out = advance(progress, live("live", 30, (1, 1), events=[goal("b", 25, "away"), goal("a", 12, "home")]))
    events = [o for o in out if isinstance(o, MatchEvent)]
    assert [(e.type, e.minute, e.team) for e in events] == [
        ("kickoff", 0, None),
        ("goal", 12, "home"),
        ("goal", 25, "away"),
    ]
    assert [e.id for e in events] == ["m-1-e1", "m-1-e2", "m-1-e3"]
    assert [e.seq for e in events] == [1, 2, 3]
    assert all((e.second, e.x, e.y, e.located, e.xg) == (0, 50, 50, False, None) for e in events)


def test_a_new_goal_is_published_once_and_before_the_new_score():
    progress = _progress()
    advance(progress, live("live", 10, (0, 0)))
    out = advance(progress, live("live", 23, (1, 0), events=[goal("k1", 23, "home", "af-7")]))
    assert _kinds(out) == ["MatchEvent", "MatchStatus", "StatsSnapshot"]
    assert out[0].type == "goal" and out[0].located is False and out[0].player_id == "af-7"
    assert out[1].score_home == 1
    again = advance(progress, live("live", 24, (1, 0), events=[goal("k1", 23, "home", "af-7")]))
    assert _kinds(again) == ["MatchStatus"] and again[0].minute == 24


def test_a_vanished_event_is_not_retracted_and_the_score_follows_the_source():
    progress = _progress()
    advance(progress, live("live", 10, (0, 0)))
    advance(progress, live("live", 23, (1, 0), events=[goal("k1", 23, "home")]))
    out = advance(progress, live("live", 25, (0, 0)))
    assert _events(out) == []
    assert progress.status.score_home == 0


def test_substitutions_name_both_players():
    progress = _progress()
    sub = LiveEvent(key="s1", minute=60, type="substitution", team="away", player_id="o", player_in_id="i")
    out = advance(progress, live("live", 61, (0, 0), events=[sub]))
    event = [o for o in out if isinstance(o, MatchEvent)][-1]
    assert (event.type, event.team, event.player_id, event.player_in_id) == ("substitution", "away", "o", "i")


def test_nothing_is_published_when_nothing_changed():
    progress = _progress()
    advance(progress, live("live", 10, (0, 0), events=[card("c1", 8, "home")]))
    assert advance(progress, live("live", 10, (0, 0), events=[card("c1", 8, "home")])) == []


def test_stats_come_from_the_source_or_from_the_score_and_cards():
    progress = LiveProgress("m-1", "openligadb", "Data: OpenLigaDB")
    out = advance(
        progress,
        live("live", 40, (2, 0), events=[card("c1", 8, "home"), card("c2", 30, "away", "red_card")]),
    )
    stats = out[-1]
    assert isinstance(stats, StatsSnapshot)
    assert (stats.id, stats.minute, stats.momentum, stats.period_end) == ("m-1-ls1", 40, 0, None)
    assert stats.provided == ["goals", "yellow_cards", "red_cards"]
    assert (stats.home.goals, stats.home.yellow_cards, stats.home.red_cards) == (2, 1, 0)
    assert (stats.away.goals, stats.away.yellow_cards, stats.away.red_cards) == (0, 0, 1)
    assert stats.home.shots == 0 and stats.home.possession == 0

    progress = _progress()
    measured = (_stats(shots=4), _stats(shots=1))
    out = advance(progress, live("live", 20, (0, 0), stats=measured, provided=["shots", "possession"]))
    stats = out[-1]
    assert (stats.home, stats.away, stats.provided) == (*measured, ["shots", "possession"])
    unchanged = advance(progress, live("live", 21, (0, 0), stats=measured, provided=["shots", "possession"]))
    assert _kinds(unchanged) == ["MatchStatus"]
    changed = (_stats(shots=5), _stats(shots=1))
    out = advance(progress, live("live", 22, (0, 0), stats=changed, provided=["shots", "possession"]))
    assert out[-1].id == "m-1-ls2" and out[-1].home.shots == 5
    out = advance(progress, live("live", 23, (0, 0), stats=changed, provided=["shots"]))
    assert out[-1].id == "m-1-ls3" and out[-1].provided == ["shots"]


def test_half_time_and_full_time_close_the_period_in_the_stats():
    progress = _progress()
    advance(progress, live("live", 44, (0, 0)))
    half = advance(progress, live("half_time", 47, (0, 0)))
    assert isinstance(half[-1], StatsSnapshot) and half[-1].period_end == "half_time"
    advance(progress, live("live", 46, (0, 0)))
    full = advance(progress, live("finished", 93, (0, 0)))
    assert isinstance(full[-1], StatsSnapshot)
    assert (full[-1].period_end, full[-1].minute) == ("full_time", 93)


def test_a_snapshot_already_in_the_second_half_starts_with_one_kickoff():
    out = advance(_progress(), live("live", 60, (1, 0), events=[goal("k1", 50, "home")]))
    assert _events(out) == [("kickoff", 0), ("goal", 50)]
    assert _kinds(out) == ["MatchStatus", "MatchEvent", "MatchEvent", "StatsSnapshot"]


def test_events_found_at_a_period_end_come_before_it():
    progress = _progress()
    advance(progress, live("live", 80, (0, 0)))
    out = advance(progress, live("finished", 92, (0, 1), events=[goal("k1", 89, "away")]))
    assert _events(out) == [("goal", 89), ("full_time", 92)]
