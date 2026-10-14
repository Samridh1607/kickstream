"""OpenLigaDB: community-entered scores and scorers, free and without a key (data under the ODbL).

It gives no live clock, line-ups or statistics, so the minute and the half-time break are estimated from the
kick-off, and each team's players are its goal scorers.
"""

import asyncio
import re
import time
import urllib.parse
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime
from typing import Any

from kickstream.adapters.http_json import Get, get_json, http_get
from kickstream.contracts import Fixture, Player, TeamSheet
from kickstream.domain.teams import short_name, team_colors
from kickstream.domain.types import Side
from kickstream.ports.match_source import LiveEvent, LiveSnapshot, LiveState, PollPlan, SourceFailure

OPENLIGADB = "https://api.openligadb.de"
HALF_TIME_FROM, SECOND_HALF_FROM = 47, 62  # minutes after kick-off; OpenLigaDB gives no live clock
UNREACHABLE = "OpenLigaDB could not be reached. Check the internet connection; Kickstream will keep trying."
UNREADABLE = "OpenLigaDB sent an answer Kickstream could not read. Try again later."
_MATCH_ID = re.compile(r"[0-9]+")

Match = dict[str, Any]


def estimated_minute(kickoff_at: float, now: float) -> int:
    """0 before kick-off; the elapsed minutes in the first half; 45 in the break; then 45 + minutes since the restart."""
    elapsed = (now - kickoff_at) / 60
    if elapsed < 0:
        return 0
    if elapsed < SECOND_HALF_FROM:
        return min(int(elapsed), 45)
    return 45 + int(elapsed - SECOND_HALF_FROM)


def kickoff_at(match: Match) -> float:
    kickoff = datetime.fromisoformat(match["matchDateTimeUTC"])
    return (kickoff if kickoff.tzinfo else kickoff.replace(tzinfo=UTC)).timestamp()


def tidy_name(name: str) -> str:
    """Spaces trimmed, and "Poulsen, Yussuf" turned round to "Yussuf Poulsen"."""
    family, comma, given = name.partition(",")
    return " ".join(f"{given} {family}".split()) if comma else " ".join(name.split())


def snapshot_from(match: Match, now: float) -> LiveSnapshot:
    started = kickoff_at(match)
    clock = estimated_minute(started, now)
    squads: dict[Side, dict[str, Player]] = {"home": {}, "away": {}}
    events = []
    goals = _goals(match)
    for side, goal in goals:
        scorer = _scorer(goal)
        if scorer is not None:
            squads[side].setdefault(scorer.id, scorer)
        events.append(
            LiveEvent(
                key=f"goal-{goal['goalID']}",
                minute=goal.get("matchMinute") or clock,
                type="goal",
                team=side,
                player_id=scorer.id if scorer else None,
            )
        )
    last_goal = max((event.minute for event in events), default=0)
    state = _state(match, now, started, last_goal)
    score = _score(match, state, goals)
    if state == "pre_match":
        minute = 0
    elif state == "finished":
        minute = max(90, last_goal)
    else:
        minute = max(clock, last_goal)
    home_color, away_color = team_colors(None, None)
    return LiveSnapshot(
        state=state,
        minute=minute,
        score_home=score[0],
        score_away=score[1],
        home=_sheet(match["team1"], home_color, squads["home"]),
        away=_sheet(match["team2"], away_color, squads["away"]),
        competition=match["leagueName"],
        kickoff_at=started,
        events=tuple(events),
    )


def fixture_from(match: Match, now: float) -> Fixture:
    snap = snapshot_from(match, now)
    started = snap.state != "pre_match"
    return Fixture(
        ref=str(match["matchID"]),
        source="openligadb",
        competition=snap.competition,
        home=snap.home.name,
        away=snap.away.name,
        kickoff_at=snap.kickoff_at,
        state=snap.state,
        minute=snap.minute if snap.state in ("live", "half_time") else None,
        score_home=snap.score_home if started else None,
        score_away=snap.score_away if started else None,
    )


def _goals(match: Match) -> list[tuple[Side, Match]]:
    """Goals in score order, each given to the side whose score went up since the goal before. Entries that
    raise neither score (repeats, corrections) are left out; `scoringTeamId` is not trusted."""
    entries = [
        goal
        for goal in match.get("goals") or []
        if goal.get("scoreTeam1") is not None and goal.get("scoreTeam2") is not None
    ]
    home = away = 0
    scored: list[tuple[Side, Match]] = []
    for goal in sorted(entries, key=lambda g: (g["scoreTeam1"] + g["scoreTeam2"], g["goalID"])):
        if goal["scoreTeam1"] > home:
            scored.append(("home", goal))
        elif goal["scoreTeam2"] > away:
            scored.append(("away", goal))
        else:
            continue
        home, away = goal["scoreTeam1"], goal["scoreTeam2"]
    return scored


def _scorer(goal: Match) -> Player | None:
    """The goal getter, or None for an own goal: the player belongs to the other side."""
    name = tidy_name(goal.get("goalGetterName") or "")
    if goal.get("isOwnGoal") or not goal.get("goalGetterID") or not name:
        return None
    return Player(id=f"ol-{goal['goalGetterID']}", name=name, number=0, position="MF")


def _state(match: Match, now: float, started: float, last_goal: int) -> LiveState:
    if match.get("matchIsFinished"):
        return "finished"
    if now < started:
        return "pre_match"
    elapsed = (now - started) / 60
    if (
        _result(match, "HalfTime") is not None
        and HALF_TIME_FROM <= elapsed < SECOND_HALF_FROM
        and last_goal <= 45
    ):
        return "half_time"
    return "live"


def _score(match: Match, state: LiveState, goals: list[tuple[Side, Match]]) -> tuple[int, int]:
    latest = (goals[-1][1]["scoreTeam1"], goals[-1][1]["scoreTeam2"]) if goals else (0, 0)
    if state != "finished":
        return latest
    final = max(
        (r for r in match.get("matchResults") or [] if r.get("resultTypeKind") != "HalfTime"),
        key=lambda r: r.get("resultOrderID") or 0,
        default=None,
    )
    return (final["pointsTeam1"], final["pointsTeam2"]) if final else latest


def _result(match: Match, kind: str) -> Match | None:
    return next((r for r in match.get("matchResults") or [] if r.get("resultTypeKind") == kind), None)


def _sheet(team: Match, color: str, players: dict[str, Player]) -> TeamSheet:
    given = (team.get("shortName") or "").strip()
    return TeamSheet(
        id=f"ol-{team['teamId']}",
        name=team["teamName"],
        short_name=given if 0 < len(given) <= 4 else short_name(team["teamName"]),
        color=color,
        players=list(players.values()),
    )


@contextmanager
def _reading() -> Iterator[None]:
    try:
        yield
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        raise SourceFailure(UNREADABLE) from exc


class OpenLigaDb:
    id = "openligadb"
    name = "OpenLigaDB"
    credit = "Data: OpenLigaDB"
    available = True
    setup = None
    poll = PollPlan(pre_match_s=300, soon_s=120, live_s=60, half_time_s=180)

    def __init__(
        self,
        leagues: tuple[str, ...] = ("pl", "la1", "ucl"),
        base_url: str = OPENLIGADB,
        get: Get = http_get,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._leagues = leagues
        self._base = base_url.rstrip("/")
        self._get = get
        self._now = now

    async def fixtures(self, day: date) -> list[Fixture]:
        """Each league's current matchday, kept when the kick-off's local date is `day`."""
        return await asyncio.to_thread(self._fixtures, day)

    async def snapshot(self, ref: str) -> LiveSnapshot:
        return await asyncio.to_thread(self._snapshot, ref)

    def budget(self) -> None:
        return None

    def _fixtures(self, day: date) -> list[Fixture]:
        found: list[Fixture] = []
        for league in self._leagues:
            matches = self._read(f"/getmatchdata/{urllib.parse.quote(league, safe='')}")
            now = self._now()
            with _reading():
                found += [
                    fixture_from(match, now)
                    for match in matches
                    if datetime.fromtimestamp(kickoff_at(match)).date() == day
                ]
        return sorted(found, key=lambda fixture: fixture.kickoff_at)

    def _snapshot(self, ref: str) -> LiveSnapshot:
        if _MATCH_ID.fullmatch(ref) is None:
            raise SourceFailure(f"OpenLigaDB has no match {ref}. Choose one from the list.")
        match = self._read(f"/getmatchdata/{ref}")
        if not isinstance(match, dict) or not match:
            raise SourceFailure(f"OpenLigaDB has no match {ref}. Choose one from the list.")
        with _reading():
            return snapshot_from(match, self._now())

    def _read(self, path: str) -> Any:
        body, _ = get_json(self._get, self._base + path, {}, unreachable=UNREACHABLE, unreadable=UNREADABLE)
        return body
