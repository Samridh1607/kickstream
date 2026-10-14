"""Turns successive snapshots of a live match into the events, statuses and stats the pipeline expects.

Live sources report only key events and have no positions, so every event is unlocated at the centre spot.
An event that disappears from a later snapshot (a VAR correction) is not retracted; the score follows the source.
"""

from collections import Counter
from dataclasses import dataclass, field

from kickstream.contracts import MatchEvent, MatchStatus, StatsSnapshot, TeamStats
from kickstream.domain.types import Side
from kickstream.ports.match_source import LiveSnapshot

DERIVED = ["goals", "yellow_cards", "red_cards"]
_PLAYED = ("live", "half_time", "finished")


@dataclass
class LiveProgress:
    """What has been published for one live match so far."""

    match_id: str
    source: str
    credit: str
    seq: int = 0
    seen: set[str] = field(default_factory=set)
    state: str | None = None
    status: MatchStatus | None = None
    stats: tuple[TeamStats, TeamStats, list[str]] | None = None
    snapshots: int = 0
    cards: Counter[tuple[Side, str]] = field(default_factory=Counter)


def advance(progress: LiveProgress, snap: LiveSnapshot) -> list[MatchEvent | MatchStatus | StatsSnapshot]:
    """What to publish for this snapshot, in order: new events, then the status if anything changed, then stats.
    The first snapshot's status comes before its events."""
    previous = progress.state
    events: list[MatchEvent] = []
    if snap.state != previous:
        if snap.state in _PLAYED and previous in (None, "pre_match"):
            events.append(_event(progress, "kickoff", 0))
        elif snap.state in ("live", "finished") and previous == "half_time":
            events.append(_event(progress, "kickoff", 45))
    for live in sorted((e for e in snap.events if e.key not in progress.seen), key=lambda e: e.minute):
        progress.seen.add(live.key)
        if live.type in ("yellow_card", "red_card"):
            progress.cards[(live.team, live.type)] += 1
        events.append(_event(progress, live.type, live.minute, live.team, live.player_id, live.player_in_id))
    period_end = None
    if snap.state != previous and snap.state == "half_time":
        events.append(_event(progress, "half_time", 45))
        period_end = "half_time"
    elif snap.state != previous and snap.state == "finished":
        events.append(_event(progress, "full_time", snap.minute))
        period_end = "full_time"
    progress.state = snap.state

    first = progress.status is None
    out: list[MatchEvent | MatchStatus | StatsSnapshot] = [] if first else list(events)
    status = MatchStatus(
        match_id=progress.match_id,
        state=snap.state,
        minute=snap.minute,
        score_home=snap.score_home,
        score_away=snap.score_away,
        speed=1.0,
        home=snap.home,
        away=snap.away,
        source=progress.source,
        detail="key_events",
        credit=progress.credit,
        competition=snap.competition,
    )
    if status != progress.status:
        progress.status = status
        out.append(status)
    if first:
        # Later stages learn from the first status that this match has no positions to draw.
        out.extend(events)

    stats = _stats(progress, snap)
    if stats != progress.stats or period_end:
        progress.stats = stats
        progress.snapshots += 1
        home, away, provided = stats
        out.append(
            StatsSnapshot(
                id=f"{progress.match_id}-ls{progress.snapshots}",
                match_id=progress.match_id,
                minute=45 if period_end == "half_time" else snap.minute,
                home=home,
                away=away,
                momentum=0,
                period_end=period_end,
                provided=provided,
            )
        )
    return out


def _event(
    progress: LiveProgress,
    kind: str,
    minute: int,
    team: Side | None = None,
    player_id: str | None = None,
    player_in_id: str | None = None,
) -> MatchEvent:
    progress.seq += 1
    return MatchEvent(
        id=f"{progress.match_id}-e{progress.seq}",
        match_id=progress.match_id,
        seq=progress.seq,
        minute=minute,
        second=0,
        type=kind,
        team=team,
        player_id=player_id,
        player_in_id=player_in_id,
        x=50,
        y=50,
        located=False,
        xg=None,
    )


def _stats(progress: LiveProgress, snap: LiveSnapshot) -> tuple[TeamStats, TeamStats, list[str]]:
    if snap.stats is not None:
        return snap.stats[0], snap.stats[1], list(snap.provided)
    home, away = _counted(progress, "home", snap.score_home), _counted(progress, "away", snap.score_away)
    return home, away, list(DERIVED)


def _counted(progress: LiveProgress, side: Side, goals: int) -> TeamStats:
    return TeamStats(
        goals=goals,
        possession=0,
        shots=0,
        shots_on_target=0,
        passes=0,
        pass_accuracy=0,
        fouls=0,
        yellow_cards=progress.cards[(side, "yellow_card")],
        red_cards=progress.cards[(side, "red_card")],
        xg=0,
    )
