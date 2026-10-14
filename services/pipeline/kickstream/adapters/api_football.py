"""API-Football (api-sports.io): live scores, key events, line-ups and team statistics on the free plan.

The free plan allows 100 requests a day. Every request is counted in a daily budget kept in the data directory,
and the count follows the `x-ratelimit-requests-remaining` header of every answer.
"""

import asyncio
import http.client
import json
import re
import threading
import time
import urllib.error
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime
from typing import Any, Protocol

from kickstream.adapters.http_json import Get, http_get
from kickstream.contracts import Fixture, Player, TeamSheet, TeamStats
from kickstream.domain.teams import short_name, team_colors
from kickstream.domain.types import Side
from kickstream.ports.match_source import LiveEvent, LiveSnapshot, PollPlan, SourceFailure, SourceUnavailable

API_FOOTBALL = "https://v3.football.api-sports.io"
DAILY_LIMIT = 100
LIST_FRESH_S = 600  # a day's fixture list is reused for ten minutes, to spare the budget
RATE_LIMIT_WAIT_S = 60.0
DAY_S = 86400

STATE = {
    "TBD": "pre_match",
    "NS": "pre_match",
    "1H": "live",
    "2H": "live",
    "ET": "live",
    "BT": "live",
    "P": "live",
    "LIVE": "live",
    "SUSP": "live",
    "INT": "live",
    "HT": "half_time",
    "FT": "finished",
    "AET": "finished",
    "PEN": "finished",
    "PST": "postponed",
    "CANC": "postponed",
    "ABD": "postponed",
    "AWD": "finished",
    "WO": "finished",
}
STAT = {
    "Ball Possession": "possession",
    "Total Shots": "shots",
    "Shots on Goal": "shots_on_target",
    "Total passes": "passes",
    "Passes %": "pass_accuracy",
    "Fouls": "fouls",
    "Yellow Cards": "yellow_cards",
    "Red Cards": "red_cards",
    "expected_goals": "xg",
}
HINT = {
    "token": "Check KICKSTREAM_API_FOOTBALL_KEY in the .env file.",
    "plan": "The free plan does not cover this match. Choose another, or use StatsBomb or OpenLigaDB.",
    "requests": "Today's free requests are used up; live updates resume after midnight UTC.",
    "rateLimit": "Too many requests in one minute; Kickstream will try again shortly.",
}
POSITION = {"G": "GK", "D": "DF", "M": "MF", "F": "FW"}
CARD = {"Yellow Card": "yellow_card", "Red Card": "red_card", "Second Yellow card": "red_card"}
GOAL = {"Normal Goal", "Penalty", "Own Goal"}
_FRACTIONAL = {"possession", "pass_accuracy", "xg"}
_REF = re.compile(r"[0-9]+")

SETUP = (
    "Add KICKSTREAM_API_FOOTBALL_KEY=<your key> to the .env file at the top of the project and restart the "
    "pipeline. Get a free key at https://dashboard.api-football.com/register."
)
UNREACHABLE = "API-Football could not be reached. Kickstream will keep trying."
UNREADABLE = "API-Football sent an answer Kickstream could not read. Kickstream will keep trying."

Body = dict[str, Any]


class RecordStore(Protocol):
    def load(self) -> dict | None: ...

    def save(self, record: dict) -> None: ...


def until_midnight_utc(now: float) -> float:
    return DAY_S - now % DAY_S


def _day(now: float) -> str:
    return datetime.fromtimestamp(now, UTC).date().isoformat()


class DailyBudget:
    """Requests used today (UTC), saved in the data directory so a restart does not reset it."""

    def __init__(
        self, store: RecordStore, limit: int = DAILY_LIMIT, now: Callable[[], float] = time.time
    ) -> None:
        self._store = store
        self.limit = limit
        self._now = now
        self._lock = threading.Lock()

    def used(self) -> int:
        with self._lock:
            return self._used_today()

    def take(self) -> None:
        """Counts one request, or raises SourceFailure (retry at midnight UTC) when today's are spent."""
        with self._lock:
            used = self._used_today()
            if used >= self.limit:
                raise SourceFailure(
                    f"Today's {self.limit} free API-Football requests are used up; "
                    "live updates resume after midnight UTC.",
                    retry_after=until_midnight_utc(self._now()),
                )
            self._save(used + 1)

    def sync(self, remaining: int | None) -> None:
        """Follows API-Football's own count, which also includes other programs using the same key."""
        if remaining is None:
            return
        with self._lock:
            self._save(min(self.limit, max(0, self.limit - remaining)))

    def _used_today(self) -> int:
        record = self._store.load() or {}
        used = record.get("used")
        return used if record.get("day") == _day(self._now()) and isinstance(used, int) else 0

    def _save(self, used: int) -> None:
        self._store.save({"day": _day(self._now()), "used": used})


@contextmanager
def _reading() -> Iterator[None]:
    try:
        yield
    except (LookupError, TypeError, ValueError, AttributeError) as exc:
        raise SourceFailure(UNREADABLE) from exc


def errors_message(body: Body) -> tuple[str, str | None] | None:
    """API-Football's own refusal in its words, followed by what to do, and the key of the error that decides
    what to do. `errors` is an empty list when there are none, else a dict or a list of dicts."""
    errors = body.get("errors")
    entries = errors if isinstance(errors, list) else [errors] if errors else []
    items = [
        pair for entry in entries for pair in (entry.items() if isinstance(entry, dict) else [(None, entry)])
    ]
    if not items:
        return None
    key = next((name for name, _ in items if name in HINT), items[0][0])
    text = " ".join(str(said).strip() for _, said in items)
    hint = HINT.get(key) if key else None
    return f"API-Football refused the request: {text}" + (f" {hint}" if hint else ""), key


def _competition(league: Body) -> str:
    country = league.get("country")
    return f"{league['name']} ({country})" if country and country != "World" else league["name"]


def _minute(clock: Body) -> int:
    return (clock.get("elapsed") or 0) + (clock.get("extra") or 0)


def fixture_listing(body: Body) -> list[Fixture]:
    """A `GET /fixtures?date=` answer, by kick-off time."""
    with _reading():
        listing = [_listed(row) for row in body["response"]]
    return sorted(listing, key=lambda f: (f.kickoff_at, f.competition, f.home))


def _listed(row: Body) -> Fixture:
    status = row["fixture"]["status"]
    state = STATE[status["short"]]
    return Fixture(
        ref=str(row["fixture"]["id"]),
        source="api_football",
        competition=_competition(row["league"]),
        home=row["teams"]["home"]["name"],
        away=row["teams"]["away"]["name"],
        kickoff_at=float(row["fixture"]["timestamp"]),
        state=state,
        minute=None if state in ("pre_match", "postponed") else _minute(status),
        score_home=row["goals"]["home"],
        score_away=row["goals"]["away"],
    )


def snapshot_from(body: Body) -> LiveSnapshot:
    """The first fixture of a `GET /fixtures?id=` answer. A postponed or cancelled match raises SourceFailure."""
    with _reading():
        row = body["response"][0]
        short = row["fixture"]["status"]["short"]
        state = STATE[short]
        if state == "postponed":
            raise SourceFailure(f"API-Football says this match is postponed or cancelled ({short}).")
        return _snapshot(row, state)


def _snapshot(row: Body, state: str) -> LiveSnapshot:
    teams = row["teams"]
    home_id, away_id = teams["home"]["id"], teams["away"]["id"]
    sides: dict[Any, Side] = {home_id: "home", away_id: "away"}
    lineups = {lineup["team"]["id"]: lineup for lineup in row.get("lineups") or []}
    named: dict[Side, dict[str, str]] = {"home": {}, "away": {}}
    events = []
    for raw in row.get("events") or []:
        side = sides.get(raw["team"]["id"])
        event = _event(raw, side) if side else None
        if event is None:
            continue
        events.append(event)
        if event.player_id:
            named[side].setdefault(event.player_id, raw["player"]["name"] or "Unknown")
        if event.player_in_id:
            named[side].setdefault(event.player_in_id, raw["assist"]["name"] or "Unknown")
    home_color, away_color = team_colors(_color(lineups.get(home_id)), _color(lineups.get(away_id)))
    goals = (row["goals"]["home"] or 0, row["goals"]["away"] or 0)
    stats, provided = _stats(row.get("statistics") or [], home_id, away_id, goals)
    return LiveSnapshot(
        state=state,
        minute=_minute(row["fixture"]["status"]),
        score_home=goals[0],
        score_away=goals[1],
        home=_sheet(teams["home"], home_color, lineups.get(home_id), named["home"]),
        away=_sheet(teams["away"], away_color, lineups.get(away_id), named["away"]),
        competition=_competition(row["league"]),
        kickoff_at=float(row["fixture"]["timestamp"]),
        events=tuple(events),
        stats=stats,
        provided=provided,
    )


def _event(raw: Body, side: Side) -> LiveEvent | None:
    kind, detail = raw["type"], raw["detail"]
    if kind == "Goal" and detail in GOAL:
        type_ = "goal"
    elif kind == "Card" and detail in CARD:
        type_ = CARD[detail]
    elif kind == "subst":
        type_ = "substitution"
    else:
        return None
    clock, player = raw["time"], raw.get("player") or {}
    return LiveEvent(
        key=f"{clock['elapsed']}-{clock.get('extra')}-{kind}-{detail}-{raw['team']['id']}-{player.get('id')}",
        minute=_minute(clock),
        type=type_,
        team=side,
        player_id=None if detail == "Own Goal" else _player_id(player),
        player_in_id=_player_id(raw.get("assist")) if type_ == "substitution" else None,
    )


def _player_id(person: Body | None) -> str | None:
    return f"af-{person['id']}" if person and person.get("id") is not None else None


def _color(lineup: Body | None) -> str | None:
    colors = ((lineup or {}).get("team") or {}).get("colors") or {}
    primary = (colors.get("player") or {}).get("primary")
    return f"#{primary.upper()}" if primary else None


def _sheet(team: Body, color: str, lineup: Body | None, named: dict[str, str]) -> TeamSheet:
    players: list[Player] = []
    lineup = lineup or {}
    for entries, starting in ((lineup.get("startXI"), True), (lineup.get("substitutes"), False)):
        for entry in entries or []:
            person = entry["player"]
            player_id = _player_id(person)
            if player_id is None or any(p.id == player_id for p in players):
                continue
            players.append(
                Player(
                    id=player_id,
                    name=person["name"] or "Unknown",
                    number=person.get("number") or 0,
                    position=POSITION.get(person.get("pos"), "MF"),
                    starting=starting,
                    grid=person.get("grid") if starting else None,
                )
            )
    known = {p.id for p in players}
    players += [
        Player(id=player_id, name=name, number=0, position="MF")
        for player_id, name in named.items()
        if player_id not in known
    ]
    return TeamSheet(
        id=f"af-{team['id']}",
        name=team["name"],
        short_name=short_name(team["name"]),
        color=color,
        players=players,
        formation=lineup.get("formation"),
    )


def _stats(
    statistics: list[Body], home_id: Any, away_id: Any, goals: tuple[int, int]
) -> tuple[tuple[TeamStats, TeamStats] | None, tuple[str, ...]]:
    measured = {
        entry["team"]["id"]: {STAT[s["type"]]: s["value"] for s in entry["statistics"] if s["type"] in STAT}
        for entry in statistics
    }
    if not measured:
        return None, ()
    present = {name for values in measured.values() for name, value in values.items() if value is not None}
    provided = ("goals", *(name for name in TeamStats.model_fields if name in present))
    home = _team_stats(measured.get(home_id, {}), goals[0])
    away = _team_stats(measured.get(away_id, {}), goals[1])
    return (home, away), provided


def _team_stats(values: Body, goals: int) -> TeamStats:
    return TeamStats(goals=goals, **{name: _number(values.get(name), name) for name in STAT.values()})


def _number(value: Any, name: str) -> float | int:
    if value is None:
        return 0
    number = float(str(value).strip().removesuffix("%"))
    return number if name in _FRACTIONAL else int(number)


def _remaining(headers: dict[str, str]) -> int | None:
    try:
        return int(headers["x-ratelimit-requests-remaining"])
    except (KeyError, ValueError):
        return None


def _http_failure(code: int) -> SourceFailure:
    if code in (401, 403):
        return SourceFailure(f"API-Football refused the key (HTTP {code}). {HINT['token']}")
    if code == 429:
        return SourceFailure(
            f"API-Football refused the request (HTTP 429). {HINT['rateLimit']}", RATE_LIMIT_WAIT_S
        )
    return SourceFailure(UNREACHABLE)


class ApiFootball:
    id = "api_football"
    name = "API-Football"
    credit = "Data: API-Football"
    poll = PollPlan(pre_match_s=600, soon_s=120, live_s=90, half_time_s=300)

    def __init__(
        self,
        key: str | None,
        budget: DailyBudget,
        base_url: str = API_FOOTBALL,
        get: Get = http_get,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._key = key or None
        self._budget = budget
        self._base = base_url.rstrip("/")
        self._get = get
        self._now = now
        self._lists: dict[date, tuple[float, list[Fixture]]] = {}
        self.available = self._key is not None
        self.setup = None if self.available else SETUP

    def __repr__(self) -> str:
        return f"ApiFootball(base_url={self._base!r}, available={self.available})"

    async def fixtures(self, day: date) -> list[Fixture]:
        return await asyncio.to_thread(self._fixtures, day)

    async def snapshot(self, ref: str) -> LiveSnapshot:
        return await asyncio.to_thread(self._snapshot, ref)

    def budget(self) -> tuple[int, int]:
        return self._budget.used(), self._budget.limit

    def _fixtures(self, day: date) -> list[Fixture]:
        kept = self._lists.get(day)
        if kept and self._now() - kept[0] < LIST_FRESH_S:
            return list(kept[1])
        fetched_at = self._now()
        listing = fixture_listing(self._request(f"/fixtures?date={day.isoformat()}"))
        self._lists[day] = (fetched_at, listing)
        return list(listing)

    def _snapshot(self, ref: str) -> LiveSnapshot:
        if _REF.fullmatch(ref) is None:
            raise SourceFailure(f"API-Football has no fixture {ref}. Choose one from the list.")
        body = self._request(f"/fixtures?id={ref}")
        if not body.get("response"):
            raise SourceFailure(f"API-Football has no fixture {ref}. Choose one from the list.")
        return snapshot_from(body)

    def _request(self, path: str) -> Body:
        if self._key is None:
            raise SourceUnavailable(SETUP)
        self._budget.take()
        try:
            raw, headers = self._get(self._base + path, {"x-apisports-key": self._key})
        except urllib.error.HTTPError as exc:
            raise _http_failure(exc.code) from exc
        except (OSError, http.client.HTTPException) as exc:  # URLError and timeouts are OSErrors
            raise SourceFailure(UNREACHABLE) from exc
        self._budget.sync(_remaining(headers))
        try:
            body = json.loads(raw.decode("utf-8"))
        except ValueError as exc:
            raise SourceFailure(UNREADABLE) from exc
        if not isinstance(body, dict):
            raise SourceFailure(UNREADABLE)
        refused = errors_message(body)
        if refused is None:
            return body
        text, key = refused
        wait = None
        if key == "requests":
            self._budget.sync(0)
            wait = until_midnight_utc(self._now())
        elif key == "rateLimit":
            wait = RATE_LIMIT_WAIT_S
        raise SourceFailure(text.replace(self._key, "(your key)"), retry_after=wait)
