"""Builders for contract objects used across test modules."""

from kickstream.contracts import KeyMoment, MatchEvent, StatFact, StatsSnapshot, TeamStats

MATCH = "m-1"


def event(seq, type_, team=None, minute=0, second=0, x=50.0, y=50.0, **extra) -> MatchEvent:
    return MatchEvent(id=f"{MATCH}-e{seq}", match_id=MATCH, seq=seq, minute=minute, second=second,
                      type=type_, team=team, x=x, y=y, **extra)


def moment(n=1, kind="goal", team="home", minute=10, **extra) -> KeyMoment:
    fields = dict(id=f"{MATCH}-k{n}", match_id=MATCH, minute=minute, kind=kind, team=team,
                  score_home=1, score_away=0, facts=[StatFact(label="xg", value=0.42)])
    return KeyMoment(**{**fields, **extra})


def team_stats(**overrides) -> TeamStats:
    fields = dict(goals=0, possession=50.0, shots=0, shots_on_target=0, passes=0, pass_accuracy=0.0,
                  fouls=0, yellow_cards=0, red_cards=0, xg=0.0)
    return TeamStats(**{**fields, **overrides})


def stats(minute=10, period_end=None, home=None, away=None) -> StatsSnapshot:
    return StatsSnapshot(id=f"{MATCH}-s{minute}", match_id=MATCH, minute=minute, momentum=0.0,
                         home=home or team_stats(), away=away or team_stats(), period_end=period_end)


from kickstream.domain.teams import AWAY, HOME, find_player  # noqa: E402
from kickstream.ports.writer import MomentContext, RecapContext  # noqa: E402


def moment_ctx(**moment_fields) -> MomentContext:
    key_moment = moment(**{"player_id": "nbr-9", "event_id": f"{MATCH}-e40", **moment_fields})
    player = find_player((HOME, AWAY), key_moment.player_id)
    return MomentContext(moment=key_moment, home=HOME, away=AWAY, player_name=player.name if player else None,
                         stats=stats(minute=key_moment.minute))


def recap_ctx(period="half_time", minute=45) -> RecapContext:
    snapshot = stats(minute=minute, period_end=period,
                     home=team_stats(goals=2, shots=9, possession=58.0, xg=1.7),
                     away=team_stats(goals=1, shots=4, possession=42.0, xg=0.6))
    return RecapContext(match_id=MATCH, period=period, minute=minute, home=HOME, away=AWAY, stats=snapshot,
                        moments=(moment(1), moment(2, kind="big_chance", team="away", minute=30)))
