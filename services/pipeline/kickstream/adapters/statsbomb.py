"""StatsBomb Open Data: past matches with every event located, turned into Kickstream events and team sheets.

Files are downloaded on first use and kept in a cache directory, so a match played once replays offline.
"""

import asyncio
import json
import re
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from kickstream.adapters.http_json import Get, get_json, http_get
from kickstream.contracts import Competition, MatchEvent, MatchListing, Player, TeamSheet
from kickstream.domain.teams import short_name, team_colors
from kickstream.domain.types import Side
from kickstream.ports.match_source import ReplayMatch, SourceFailure

OPEN_DATA = "https://raw.githubusercontent.com/hudl/open-data/master/data/"
# competitions and season lists are refreshed weekly; events and line-ups never change
LISTS_FRESH_S = 7 * 86400
UNREACHABLE = (
    "StatsBomb's open data could not be reached. Check the internet connection and try again. "
    "Matches downloaded before still play offline."
)
UNREADABLE = "StatsBomb sent a file Kickstream could not read. Try again later."
_REF = re.compile(r"([0-9]+)/([0-9]+)/([0-9]+)")

SB_LENGTH, SB_WIDTH = 120.0, 80.0
SAVE_TYPES = {"Shot Saved", "Penalty Saved", "Shot Saved to Post", "Shot Saved Off Target", "Save"}
SHOT_OUTCOME = {
    "Goal": "goal",
    "Saved": "saved",
    "Saved to Post": "saved",
    "Off T": "off_target",
    "Wayward": "off_target",
    "Post": "off_target",
    "Saved Off Target": "off_target",
    "Blocked": "blocked",
}
CARD = {"Yellow Card": "yellow_card", "Second Yellow": "red_card", "Red Card": "red_card"}
# grid is "line:slot": line 1 the goalkeeper, rising towards attack; slot 1 is the team's right
POSITION = {
    1: ("GK", "1:1"),
    2: ("DF", "2:1"),
    3: ("DF", "2:2"),
    4: ("DF", "2:3"),
    5: ("DF", "2:4"),
    6: ("DF", "2:5"),
    7: ("DF", "3:1"),
    8: ("DF", "3:5"),
    9: ("MF", "3:2"),
    10: ("MF", "3:3"),
    11: ("MF", "3:4"),
    12: ("MF", "4:1"),
    13: ("MF", "4:2"),
    14: ("MF", "4:3"),
    15: ("MF", "4:4"),
    16: ("MF", "4:5"),
    17: ("FW", "5:1"),
    18: ("MF", "5:2"),
    19: ("MF", "5:3"),
    20: ("MF", "5:4"),
    21: ("FW", "5:5"),
    22: ("FW", "6:2"),
    23: ("FW", "6:3"),
    24: ("FW", "6:4"),
    25: ("FW", "5:3"),
}
_LAST_PERIOD = 4

Event = dict[str, Any]


def to_pitch(location: list[float], side: Side) -> tuple[float, float]:
    """StatsBomb's 120 x 80 pitch, seen from the acting team attacking left to right, as Kickstream's 0-100
    with the home side attacking x = 100. Away events are turned through 180 degrees (x and y flipped)."""
    x = min(max(location[0] / SB_LENGTH * 100.0, 0.0), 100.0)
    y = min(max(location[1] / SB_WIDTH * 100.0, 0.0), 100.0)
    if side == "away":
        x, y = 100.0 - x, 100.0 - y
    return round(x, 1), round(y, 1)


def formation(value: int | str | None) -> str | None:
    """StatsBomb's formation number as lines from the back: 442 -> "4-4-2", 4231 -> "4-2-3-1"."""
    digits = [char for char in str(value) if char.isdigit()] if value is not None else []
    return "-".join(digits) or None


def team_sheets(listing: Event, lineups: list[Event], events: list[Event]) -> tuple[TeamSheet, TeamSheet]:
    """Home and away from the season's match list. Players are `sb-{player_id}`: the Starting XI first, in its
    order, with grid and starting=True, then the bench by shirt number. A bench player's position is their first
    `positions` entry, or MF when they never played. Formation comes from the Starting XI event."""
    home, away = listing["home_team"], listing["away_team"]
    home_color, away_color = team_colors(None, None)
    return (
        _sheet(home["home_team_id"], home["home_team_name"], home_color, lineups, events),
        _sheet(away["away_team_id"], away["away_team_name"], away_color, lineups, events),
    )


def _sheet(team_id: int, name: str, color: str, lineups: list[Event], events: list[Event]) -> TeamSheet:
    squad = next((team["lineup"] for team in lineups if team["team_id"] == team_id), [])
    known = {player["player_id"]: player for player in squad}
    tactics = next(
        (e["tactics"] for e in events if e["type"]["name"] == "Starting XI" and e["team"]["id"] == team_id),
        {"formation": None, "lineup": []},
    )
    players = []
    for starter in tactics["lineup"]:
        player_id = starter["player"]["id"]
        position, grid = POSITION.get(starter["position"]["id"], ("MF", None))
        players.append(
            Player(
                id=f"sb-{player_id}",
                name=_name(known[player_id]) if player_id in known else starter["player"]["name"],
                number=starter["jersey_number"],
                position=position,
                starting=True,
                grid=grid,
            )
        )
    started = {starter["player"]["id"] for starter in tactics["lineup"]}
    bench = sorted((p for p in squad if p["player_id"] not in started), key=lambda p: p["jersey_number"])
    players += [
        Player(
            id=f"sb-{p['player_id']}", name=_name(p), number=p["jersey_number"], position=_first_position(p)
        )
        for p in bench
    ]
    return TeamSheet(
        id=f"sb-{team_id}",
        name=name,
        short_name=short_name(name),
        color=color,
        players=players,
        formation=formation(tactics["formation"]),
    )


def _name(player: Event) -> str:
    return player.get("player_nickname") or player["player_name"]


def _first_position(player: Event) -> str:
    positions = player.get("positions") or []
    return POSITION.get(positions[0]["position_id"], ("MF", None))[0] if positions else "MF"


def convert_events(match_id: str, events: list[Event], home_team_id: int) -> list[MatchEvent]:
    """Kickstream events in file order (StatsBomb's own match-time order), numbered from 1."""
    played = [e for e in events if e["period"] <= _LAST_PERIOD]
    last_period = max((e["period"] for e in played), default=None)
    kick_offs: dict[int, Event] = {}
    for event in played:
        if event["type"]["name"] == "Pass" and _pass_type(event) == "Kick Off":
            kick_offs.setdefault(event["period"], event)
    rows: list[dict[str, Any]] = []
    boundaries: set[tuple[str, int]] = set()
    for event in played:
        kind = event["type"]["name"]
        if kind in ("Half Start", "Half End"):
            if (kind, event["period"]) in boundaries:
                continue
            boundaries.add((kind, event["period"]))
        rows += _rows(event, home_team_id, kick_offs, last_period)
    return [
        MatchEvent(id=f"{match_id}-e{seq}", match_id=match_id, seq=seq, **row)
        for seq, row in enumerate(rows, start=1)
    ]


def _rows(
    event: Event, home_team_id: int, kick_offs: dict[int, Event], last_period: int | None
) -> list[dict]:
    kind, period = event["type"]["name"], event["period"]
    side = _side(event, home_team_id)
    player = _player(event)
    at = to_pitch(event["location"], side) if event.get("location") else None

    def row(type_: str, team: Side | None = side, player_id: str | None = player, place=at, **extra) -> dict:
        x, y = place if place else (50.0, 50.0)
        return {
            "minute": event["minute"],
            "second": event["second"],
            "type": type_,
            "team": team,
            "player_id": player_id,
            "x": x,
            "y": y,
            "located": place is not None,
            **extra,
        }

    goal_mouth = (100.0, 50.0) if side == "home" else (0.0, 50.0)
    if kind == "Half Start":
        kick_off = kick_offs.get(period)
        team = _side(kick_off, home_team_id) if kick_off else None
        return [row("kickoff", team, _player(kick_off) if kick_off else None, (50.0, 50.0))]
    if kind == "Half End":
        if period == last_period:
            return [row("full_time", None, None, None)]
        return [row("half_time", None, None, None)] if period == 1 else []
    if kind == "Pass":
        if _pass_type(event) == "Corner":
            return [row("corner")]
        return [row("pass", completed="outcome" not in event["pass"])]
    if kind == "Shot":
        shot = event["shot"]
        outcome = SHOT_OUTCOME.get(shot["outcome"]["name"], "off_target")
        rows = [row("shot", outcome=outcome, xg=shot.get("statsbomb_xg"))]
        return rows + [row("goal", place=goal_mouth)] if outcome == "goal" else rows
    if kind == "Own Goal For":
        return [row("goal", player_id=None, place=goal_mouth)]
    if kind == "Goal Keeper":
        return [row("save")] if event["goalkeeper"]["type"]["name"] in SAVE_TYPES else []
    if kind == "Foul Committed":
        return [row("foul"), *_card(row, event.get("foul_committed", {}))]
    if kind == "Bad Behaviour":
        return _card(row, event.get("bad_behaviour", {}))
    if kind == "Substitution":
        replacement = event["substitution"]["replacement"]["id"]
        return [row("substitution", place=None, player_in_id=f"sb-{replacement}")]
    return []


def _card(row, detail: Event) -> list[dict]:
    card = CARD.get(detail.get("card", {}).get("name", ""))
    return [row(card)] if card else []


def _side(event: Event, home_team_id: int) -> Side:
    return "home" if event["team"]["id"] == home_team_id else "away"


def _player(event: Event) -> str | None:
    return f"sb-{event['player']['id']}" if "player" in event else None


def _pass_type(event: Event) -> str | None:
    return event["pass"].get("type", {}).get("name")


def convert(match_id: str, listing: Event, lineups: list[Event], events: list[Event]) -> ReplayMatch:
    home, away = team_sheets(listing, lineups, events)
    competition = f"{listing['competition']['competition_name']} {listing['season']['season_name']}"
    return ReplayMatch(
        home=home,
        away=away,
        events=convert_events(match_id, events, listing["home_team"]["home_team_id"]),
        competition=competition,
    )


@contextmanager
def _reading() -> Iterator[None]:
    try:
        yield
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        raise SourceFailure(UNREADABLE) from exc


class StatsBombOpenData:
    id = "statsbomb"
    name = "StatsBomb Open Data"
    credit = "Data: StatsBomb"

    def __init__(
        self,
        cache_dir: Path,
        base_url: str = OPEN_DATA,
        get: Get = http_get,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._cache = cache_dir
        self._base = base_url
        self._get = get
        self._now = now
        self._writing = threading.Lock()

    async def competitions(self) -> list[Competition]:
        return await asyncio.to_thread(self._competitions)

    async def matches(self, competition_id: int, season_id: int) -> list[MatchListing]:
        return await asyncio.to_thread(self._matches, competition_id, season_id)

    async def load(self, ref: str, match_id: str) -> ReplayMatch:
        return await asyncio.to_thread(self._load, ref, match_id)

    def _competitions(self) -> list[Competition]:
        rows = self._read("competitions.json", LISTS_FRESH_S)
        with _reading():
            found = [
                Competition(
                    competition_id=row["competition_id"],
                    season_id=row["season_id"],
                    competition_name=row["competition_name"],
                    season_name=row["season_name"],
                    country_name=row["country_name"],
                )
                for row in rows
            ]
        by_name = sorted(found, key=lambda c: c.competition_name.casefold())
        return sorted(by_name, key=lambda c: c.season_name, reverse=True)

    def _matches(self, competition_id: int, season_id: int) -> list[MatchListing]:
        rows = self._read(f"matches/{competition_id}/{season_id}.json", LISTS_FRESH_S)
        with _reading():
            listings = [
                MatchListing(
                    ref=f"{competition_id}/{season_id}/{row['match_id']}",
                    date=row["match_date"],
                    kick_off=(row.get("kick_off") or "")[:5] or None,
                    home=row["home_team"]["home_team_name"],
                    away=row["away_team"]["away_team_name"],
                    stage=(row.get("competition_stage") or {}).get("name"),
                )
                for row in rows
            ]
        return sorted(listings, key=lambda m: (m.date, m.kick_off or ""))

    def _load(self, ref: str, match_id: str) -> ReplayMatch:
        parts = _REF.fullmatch(ref)
        if parts is None:
            raise SourceFailure(f"StatsBomb has no match {ref}. Choose one from the list.")
        competition_id, season_id, statsbomb_id = (int(part) for part in parts.groups())
        rows = self._read(f"matches/{competition_id}/{season_id}.json", LISTS_FRESH_S)
        with _reading():
            listing = next((row for row in rows if row["match_id"] == statsbomb_id), None)
        if listing is None:
            raise SourceFailure(f"StatsBomb has no match {ref}. Choose one from the list.")
        events = self._read(f"events/{statsbomb_id}.json", None)
        lineups = self._read(f"lineups/{statsbomb_id}.json", None)
        with _reading():
            return convert(match_id, listing, lineups, events)

    def _read(self, path: str, fresh_s: float | None) -> Any:
        cached = self._cache / path
        if cached.exists() and (fresh_s is None or self._now() - cached.stat().st_mtime < fresh_s):
            return self._cached(cached)
        try:
            data, _ = get_json(
                self._get, self._base + path, {}, unreachable=UNREACHABLE, unreadable=UNREADABLE
            )
        except SourceFailure:
            if cached.exists():
                return self._cached(cached)
            raise
        with self._writing:
            cached.parent.mkdir(parents=True, exist_ok=True)
            temporary = cached.with_suffix(".tmp")
            temporary.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            temporary.replace(cached)
        return data

    @staticmethod
    def _cached(path: Path) -> Any:
        with _reading():
            return json.loads(path.read_text(encoding="utf-8"))
