"""Make the small StatsBomb test fixtures from downloaded open-data files.

Run: python -m kickstream.tools.trim_statsbomb RAW_DIR OUT_DIR, where RAW_DIR holds competitions.json,
matches-43-3.json, events-8658.json and lineups-8658.json from https://github.com/hudl/open-data.
"""

import json
import sys
from pathlib import Path
from typing import Any

COMPETITION, SEASON, MATCH = 43, 3, 8658
KEPT_TYPES = {
    "Starting XI",
    "Half Start",
    "Half End",
    "Shot",
    "Substitution",
    "Own Goal For",
    "Own Goal Against",
    "Bad Behaviour",
}
KEPT_PASSES = {"Kick Off", "Corner"}
PASSES_BEFORE_GOAL = 4
PASSES_WITH_OUTCOME = 2
OTHERS_KEPT = 2

Event = dict[str, Any]


def trim_competitions(competitions: list[Event]) -> list[Event]:
    return _keep_with_others(
        competitions, lambda c: (c["competition_id"], c["season_id"]) == (COMPETITION, SEASON)
    )


def trim_matches(matches: list[Event]) -> list[Event]:
    return _keep_with_others(matches, lambda m: m["match_id"] == MATCH)


def _keep_with_others(items: list[Event], wanted) -> list[Event]:
    others = [index for index, item in enumerate(items) if not wanted(item)][:OTHERS_KEPT]
    return [item for index, item in enumerate(items) if wanted(item) or index in others]


def trim_events(events: list[Event]) -> list[Event]:
    kept: set[int] = set()
    with_outcome = 0
    for index, event in enumerate(events):
        if _wanted(event):
            kept.add(index)
        if _is_pass(event) and "outcome" in event["pass"] and with_outcome < PASSES_WITH_OUTCOME:
            kept.add(index)
            with_outcome += 1
        if _is_goal(event):
            before = [i for i in range(index) if _is_pass(events[i])][-PASSES_BEFORE_GOAL:]
            kept.update(before)
    return [_slim(events[index]) for index in sorted(kept)]


def _wanted(event: Event) -> bool:
    kind = event["type"]["name"]
    if kind == "Goal Keeper":
        return "Save" in event["goalkeeper"]["type"]["name"]
    if kind == "Foul Committed":
        return "card" in event.get("foul_committed", {})
    if kind == "Pass":
        return event["pass"].get("type", {}).get("name") in KEPT_PASSES
    return kind in KEPT_TYPES


def _is_pass(event: Event) -> bool:
    return event["type"]["name"] == "Pass"


def _is_goal(event: Event) -> bool:
    kind = event["type"]["name"]
    return kind == "Own Goal For" or (kind == "Shot" and event["shot"]["outcome"]["name"] == "Goal")


def _slim(event: Event) -> Event:
    slim = {key: value for key, value in event.items() if key != "related_events"}
    if "shot" in slim:
        slim["shot"] = {key: value for key, value in slim["shot"].items() if key != "freeze_frame"}
    return slim


def trim_lineups(lineups: list[Event]) -> list[Event]:
    return [
        {**team, "lineup": [{k: v for k, v in player.items() if k != "country"} for player in team["lineup"]]}
        for team in lineups
    ]


def _read(path: Path) -> Any:
    return json.loads(path.read_text("utf-8"))


def _write(path: Path, items: list[Event]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ",\n".join(json.dumps(item, ensure_ascii=False) for item in items)
    path.write_text(f"[\n{lines}\n]\n", encoding="utf-8", newline="\n")


def main(raw: Path, out: Path) -> None:
    _write(out / "competitions.json", trim_competitions(_read(raw / "competitions.json")))
    matches = _read(raw / f"matches-{COMPETITION}-{SEASON}.json")
    _write(out / "matches" / str(COMPETITION) / f"{SEASON}.json", trim_matches(matches))
    _write(out / "events" / f"{MATCH}.json", trim_events(_read(raw / f"events-{MATCH}.json")))
    _write(out / "lineups" / f"{MATCH}.json", trim_lineups(_read(raw / f"lineups-{MATCH}.json")))


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
