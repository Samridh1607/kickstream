# Real Match Data Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The streamer picks a real football match, in the studio's new **Match** tool or on the match data page, and it runs through the whole existing pipeline (analytics, the seven agents, narratives, overlays, Ask Copilot, the 3D pitch). It then shows on the studio program and on the match page, with the data credit. The sources are free: StatsBomb Open Data replays (full detail, no key), API-Football live (free key, 100 requests a day) and OpenLigaDB live (German leagues, no key).

**Architecture:** A new port `ports/match_source.py` declares two kinds of source. A `ReplaySource` (StatsBomb) turns a past match into a list of `MatchEvent`s and two `TeamSheet`s, and these play through today's `Simulator` in match-time order. A `LiveSource` (API-Football, OpenLigaDB) returns a `LiveSnapshot` each time it is polled. A new `live` stage holds a pure `rules.advance` that turns successive snapshots into new events, statuses and stats, and a `LiveMatch` runner that polls with a schedule, backoff and a daily budget. `MatchController` starts any of the three kinds, owns the current match's teams, and keeps announcing abandoned matches. A new `sources` stage serves the browse routes. Contracts gain per-match teams, the data's source, detail and credit, StatsBomb's own xG, and a `located` flag. Every position-based analytic ignores unlocated events, and the web shows "Not available with live data" where it would otherwise draw invented positions.

**Tech Stack:** Python 3.13, FastAPI, pydantic 2, pytest (`uv`); React 19, Fluent UI v9, Vitest, Playwright (`pnpm`). No new dependencies. HTTP uses `urllib.request` in a worker thread, as `adapters/x_feed.py` and `adapters/web_search.py` do.

**Spec:** `docs/superpowers/specs/2026-10-14-kickstream-studio-overhaul-design.md` (Phase 2; Phase 1 for the studio layout and tool rail).

**Baseline on this branch:** `studio-overhaul` at `9ce6498`. Phase 1 has landed: `StudioPage.tsx` is the stage-first shell, `ToolRail.tsx` has `TOOLS = ["Banners", "Comments", "Guests", "Replays", "Timer", "Stream", "Settings"]`, and the tools live in `apps/web/src/studio/tools/`. The match data page (`/match`, `MatchPage.tsx` → `App.tsx`) is analyst-only, with a `Header` that has a Start / Restart match button. When this plan was written there was uncommitted work in the working tree: `StudioPage.tsx`, `widgets.tsx`, `panels.tsx`, `SceneStrip.tsx`, `edit/*`, `agents/cards.tsx`, `agents/Pitch3D.tsx`, `MatchPage.tsx` and a new `studio/pitchScene.ts`. Tasks 14–16 touch some of those files, so build on whatever has been committed by the time they start.

## Decisions and deviations from the spec

The user chose the sources, so the spec's source table is replaced as follows. Everything else follows the spec unless listed here.

| Spec | This plan | Why |
|---|---|---|
| SportAPI.ai live, `KICKSTREAM_SPORTAPI_KEY`, every 30 s within 2,000 a day | **OpenLigaDB** live (`api.openligadb.de`): free, no key, German leagues (scores, scorers, minutes), polled every 60 s | The user wants free sources only. `KICKSTREAM_SPORTAPI_KEY` is dropped. |
| API-Football polled every 60 s while live | Every **90 s** while live, 5 min at half-time, 10 min before kick-off (2 min in the last 15 min) | 60 s × about 115 live minutes is more than the free plan's 100 requests a day. 90 s needs about 80 requests for one match, including the fixture lists. |
| `MatchStatus.source: "simulated" \| "statsbomb" \| "live"` | `"simulated" \| "statsbomb" \| "api_football" \| "openligadb"` | The Match tool, the credit and the error messages need to know which live service it is. |
| "Simulated: `simulator` (today's generator)" listed as an adapter | The simulator stays a stage. `"simulated"` is built into `MatchController`; the port covers the network sources only | The architecture test treats `simulator` as a stage, and `generate()` needs no I/O. |
| Conversion table has no own goals | StatsBomb `Own Goal For` → `goal` for that team, with no scorer named (`player_id: null`). The `Own Goal Against` event is dropped | The 2018 World Cup final (the test fixture) has one. Naming the defender as the scorer would read wrongly in commentary. |
| "Extra time … ends the match at the end of extra time" | Only the end of period 1 is `half_time`. The end of the last period played (2 or 4) is `full_time`. The breaks before and inside extra time produce no event. Every `Half Start` of periods 2 to 4 is a `kickoff`. Period 5 (the shoot-out) is dropped | Keeps one half-time break and one half-time recap per match. |
| — | StatsBomb `ref` is `"{competition_id}/{season_id}/{match_id}"`. Live refs are the service's fixture id | Which side is at home comes from the season's match list, so the competition and season are needed. |
| — | Extra contract fields: `PlayEvent.xg` / `located`, `StatsSnapshot.provided`; new definitions `Sources`, `SourceInfo`, `RunningMatch`, `Competition`, `MatchListing`, `Fixture`; `PlayerReport.players` max 40 → 60 | Agents must see xG and location. Live sources measure only some stats. Real squads are up to 26 players a side. |
| — | New route `POST /api/matches/stop` | The Match tool has a Stop button. No route stopped a match before. |
| — | For `detail: "key_events"` matches the Tactical Analyst and the Visualization Agent sit out | Their outputs exist only to describe positions. |
| Credit only for StatsBomb | Every source's credit is shown in the program corner: "Data: StatsBomb", "Data: API-Football", "Data: OpenLigaDB" | It costs nothing, and it is fair attribution. |
| — | The Starting soon template's title becomes `{home} vs {away}`, filled in from the current match | It was hard-coded to the fictional clubs. |
| — | The API-Football test fixtures are written by hand from the API's documented response shape. StatsBomb and OpenLigaDB fixtures are trimmed real responses | No API-Football key is available while writing this plan. See Risks. |

## Global Constraints

- Secrets (`KICKSTREAM_API_FOOTBALL_KEY` and the others) live only in the git-ignored root `.env` or `.data/`. They are never logged, printed, put in an exception message, returned to a page, or shown in a `repr` (`field(default=None, repr=False)`). Never open or print `.env`. Never set `KICKSTREAM_*` in a shared shell. The Playwright config may pass a **fake** key (`e2e-fake-key`) to its own test pipeline.
- **No test needs the internet or a key.** Adapters take an injectable `get` function, and pytest gets an autouse guard that makes `urllib.request.urlopen` raise (Task 12). The default e2e run points every source at a local fake server (Task 17). Only `pnpm e2e:network` (Task 18) touches the real services.
- Never stage `.playwright-mcp/`, `apps/web/tsconfig.tsbuildinfo`, `.data/`, `.data-e2e/`, `test-results/` or `playwright-report/`. Stage exact paths.
- Saved data from before this phase keeps loading. Every new contract field has a default, and old `matches.json`, `studio.json` and envelopes still validate (Task 1 tests this).
- Match the surrounding code. Ports are `Protocol`s plus frozen dataclasses. Adapters are named only in `app.py`. Stages import only themselves plus `contracts`, `domain` and `ports`, and new stages are added to `STAGES` in `tests/test_architecture.py`. Refusals are `Refusal` subclasses, so the web's `send()` shows the server's own message. UI text is English and in sentence case; the match page's existing strings go through `i18n.ts` (en/es/hi). Comments only for constraints the code cannot show.
- Each task leaves the whole suite green. Contract changes come first and add only optional fields.
- Commands:
  - Pipeline, in `services/pipeline`: `uv run pytest -q`, `uv run ruff check .`, `uv run python -m kickstream.tools.gen_contracts`.
  - Web, in `apps/web`: `pnpm gen:contracts`, `pnpm exec vitest run`, `pnpm exec tsc -b`, `pnpm e2e --reporter=line`.
  - Do not stop the developer's servers on ports 8000 and 5173. The e2e servers use 8010, 5183 and (new) 8020.

## Review Focus

1. **A failed start changes nothing.** Starting a StatsBomb match whose download fails, or a live fixture the service refuses, must leave the running match running. It must not use up a match ID, and the Match tool must get the source's message (what went wrong and what to do).
2. **No invented numbers.** For `detail: "key_events"` matches, no pressure map, 3D pitch, momentum, danger or tactics are drawn or narrated. Stats show only the fields the source measured (`provided`), and recaps do not quote shots or xG the source never gave.
3. **The key never leaks.** Search the diff for the key reaching `log.*`, exception text, `SourceInfo`, `RunningMatch`, the budget file or a test snapshot.
4. **Budget honesty.** Every API-Football request goes through `DailyBudget.take()`, including fixture lists. The counter syncs from the `x-ratelimit-requests-remaining` header. When the budget is spent, the runner keeps the last state and waits until midnight UTC instead of retrying.
5. **Replay spoilers.** The StatsBomb browse routes never return a score (the listing model has no score field), and the Match tool shows none until the match is playing.

## Every place that assumes fixed teams (migrated in this plan)

| Place | Today | After | Task |
|---|---|---|---|
| `domain/teams.py` `HOME`, `AWAY` | The only clubs | The simulated match's clubs and the default pair for `GET /api/teams`. First 11 marked `starting` | 2 |
| `control.py` `MatchController(bus, clock_factory, home, away, prefix)` | Every match uses `self._home`, `self._away` | They are the simulated defaults. `teams` is the current match's pair | 7, 11 |
| `app.py` `MatchController(bus, clock_factory, HOME, AWAY, …)` and `build_router(teams=(HOME, AWAY))` | Static pair | `teams=lambda: pipeline.controller.teams` | 12 |
| `gateway/api.py` `GET /api/teams` | Returns the static tuple | Returns the current match's teams, or the defaults before any match | 12 |
| `agents/squad.py` `Squad.__init__` | First 11 of the sheet are on the pitch | Players marked `starting`, else the first 11. `refresh(home, away)` adds players who appear later | 3 |
| `agents/stage.py` `_Team` | Squad built once from the first status | Squad refreshed from every status (OpenLigaDB adds scorers as they score) | 3 |
| `studio/templates.py` Starting soon | `_title(3, "Northbridge FC vs Harbour City", …)` | `_title(3, "{home} vs {away}", …)`, filled in by the text element | 14 |
| `contracts` `PlayerReport.players` `maxItems: 40` | Two 14-man fictional squads | 60 | 1 |
| `apps/web/src/App.tsx` | `fetchTeams()` once on mount, passed to `PreferencesDrawer` | Teams from `data.status` when a match is known, `fetchTeams()` otherwise | 16 |
| `tools/find_demo_seed.py`, tests using `HOME`/`AWAY` | Simulated clubs | Unchanged (they are about the simulated match) | — |

Stages that already read teams from each `MatchStatus` and need no change: `narration/stage.py`, `overlay/stage.py`, `gateway/recorder.py`, `fans/service.py`, `broadcasts/rules.py` (`observe_status`), `copilot/view.py`. Web components already read `status.home` / `status.away` (`Header`, `Scoreboard`, `widgets.tsx` `colorsOf`/`namesOf`).

## File structure

Create (pipeline, `services/pipeline/`):

```
kickstream/ports/match_source.py      SourceFailure, SourceUnavailable, ReplayMatch, LiveEvent, LiveSnapshot, PollPlan, ReplaySource, LiveSource
kickstream/adapters/http_json.py      get_json(url, headers, timeout) -> (body, headers); maps failures to SourceFailure
kickstream/adapters/statsbomb.py      conversion (pure) + StatsBombOpenData (download, cache in .data/statsbomb/)
kickstream/adapters/api_football.py   parsing (pure) + DailyBudget + ApiFootball
kickstream/adapters/openligadb.py     parsing (pure) + OpenLigaDb
kickstream/live/__init__.py
kickstream/live/rules.py              LiveState, advance(state, snapshot) -> payloads (pure)
kickstream/live/runner.py             LiveMatch: poll schedule, backoff, budget wait, publish
kickstream/sources/__init__.py
kickstream/sources/api.py             GET /api/sources, StatsBomb browse, live fixtures
kickstream/tools/trim_statsbomb.py    makes the small StatsBomb fixtures from downloaded files
tests/conftest.py                     no-internet guard
tests/fixtures/statsbomb/competitions.json
tests/fixtures/statsbomb/matches/43/3.json
tests/fixtures/statsbomb/events/8658.json      (2018 World Cup final, trimmed to ~80 events, ~55 KB)
tests/fixtures/statsbomb/lineups/8658.json
tests/fixtures/api_football/*.json             (hand-written from the documented shape)
tests/fixtures/openligadb/*.json               (trimmed real responses, plus edited live states)
tests/test_match_sources.py           port types, team helpers
tests/test_statsbomb.py
tests/test_api_football.py
tests/test_openligadb.py
tests/test_live_rules.py
tests/test_live_runner.py
tests/test_sources_api.py
```

Modify (pipeline):

```
packages/contracts/kickstream.schema.json   (repo root)
kickstream/contracts.py                     (generated)
kickstream/domain/teams.py                  starting flags, PALETTE, team_colors, short_name
kickstream/analytics/state.py, stage.py     xg, located, no snapshots for key_events
kickstream/agents/interpreter.py, prediction.py, tracking.py, highlights.py, visualize.py, tactics.py, squad.py, stage.py
kickstream/overlay/build.py, stage.py       provided rows; no pressure map for key_events
kickstream/adapters/scripted_writer.py, agent_writer.py   no-facts moments; recaps without unmeasured stats
kickstream/simulator/stage.py               status metadata
kickstream/control.py                       sources, teams, running, failed starts change nothing
kickstream/gateway/api.py                   StartMatch {source, ref}, teams callable, POST /matches/stop
kickstream/studio/templates.py              "{home} vs {away}"
kickstream/app.py                           Settings, adapters, routers
tests/test_architecture.py                  STAGES += live, sources
tests/test_contracts.py, test_analytics.py, test_agents.py, test_agents_pipeline.py, test_overlay.py,
tests/test_scripted_writer.py, test_agent_writer.py, test_simulator.py, test_control.py, test_api.py, test_domain.py
```

Create (web, `apps/web/`):

```
src/matches/api.ts                    sources, browse, fixtures, start from a source, stop
src/matches/api.test.ts
src/matches/liveData.ts               which elements need positions; isKeyEvents
src/matches/liveData.test.ts
src/matches/MatchPicker.tsx           source picker, StatsBomb browse, speed, live fixtures, Start / Stop, errors
src/matches/MatchPicker.test.tsx
src/studio/tools/MatchTool.tsx        MatchPicker in the rail + running match and its problem
e2e/fake-sources.mjs                  local stand-in for StatsBomb, API-Football and OpenLigaDB
e2e/sources.spec.ts
e2e-network/sources.spec.ts
playwright.network.config.ts
```

Modify (web):

```
src/contracts.ts (generated), src/api.ts, src/i18n.ts
src/studio/elements.tsx, widgets.tsx, SceneCanvas.tsx, ToolRail.tsx, StudioPage.tsx (+ tests)
src/components/Header.tsx, src/App.tsx, src/agents/cards.tsx (+ tests)
playwright.config.ts, package.json, e2e/broadcasts.ts
README.md (repo root)
```

---

### Task 1: Contracts for real match data

**Files:**
- Modify: `packages/contracts/kickstream.schema.json`
- Regenerate: `services/pipeline/kickstream/contracts.py`, `apps/web/src/contracts.ts`
- Modify: `services/pipeline/tests/test_contracts.py`

**Interfaces (schema; every new property is optional with a default):**

```json
"Player": { … "starting": { "type": "boolean", "default": false },
               "grid": { "type": ["string", "null"], "maxLength": 5, "default": null } }
"TeamSheet": { … "formation": { "type": ["string", "null"], "maxLength": 12, "default": null } }
"MatchStatus": { …
  "state": { "enum": ["pre_match", "live", "half_time", "finished", "abandoned"] },
  "source": { "enum": ["simulated", "statsbomb", "api_football", "openligadb"], "default": "simulated" },
  "detail": { "enum": ["full", "key_events"], "default": "full" },
  "credit": { "type": ["string", "null"], "default": null },
  "competition": { "type": ["string", "null"], "default": null } }
"MatchEvent" and "PlayEvent": { …
  "xg": { "type": ["number", "null"], "default": null },
  "located": { "type": "boolean", "default": true } }
"StatsSnapshot": { …
  "provided": { "anyOf": [{ "type": "array", "items": { "enum": ["goals", "possession", "shots", "shots_on_target",
                "passes", "pass_accuracy", "fouls", "yellow_cards", "red_cards", "xg"] } }, { "type": "null" }],
                "default": null } }
"PlayerReport": { … "players": { …, "maxItems": 60 } }

"SourceInfo": { "required": ["id", "name", "kind", "detail", "available"], "properties": {
  "id": { "enum": ["simulated", "statsbomb", "api_football", "openligadb"] },
  "name": { "type": "string" },
  "kind": { "enum": ["simulated", "replay", "live"] },
  "detail": { "enum": ["full", "key_events"] },
  "available": { "type": "boolean" },
  "credit": { "type": ["string", "null"], "default": null },
  "setup": { "type": ["string", "null"], "default": null },
  "budget_used": { "type": ["integer", "null"], "default": null },
  "budget_limit": { "type": ["integer", "null"], "default": null } } }
"RunningMatch": { "required": ["match_id", "source"], "properties": {
  "match_id": { "type": "string" }, "source": { "enum": [ …same four… ] },
  "ref": { "type": ["string", "null"], "default": null },
  "title": { "type": ["string", "null"], "default": null },
  "problem": { "type": ["string", "null"], "default": null } } }
"Sources": { "required": ["sources"], "properties": {
  "sources": { "type": "array", "items": { "$ref": "#/$defs/SourceInfo" } },
  "running": { "anyOf": [{ "$ref": "#/$defs/RunningMatch" }, { "type": "null" }], "default": null } } }
"Competition": { "required": ["competition_id", "season_id", "competition_name", "season_name", "country_name"], … }
"MatchListing": { "required": ["ref", "date", "home", "away"], "properties": {
  "ref": { "type": "string" }, "date": { "type": "string" }, "home": { "type": "string" }, "away": { "type": "string" },
  "kick_off": { "type": ["string", "null"], "default": null }, "stage": { "type": ["string", "null"], "default": null } } }
"Fixture": { "required": ["ref", "source", "competition", "home", "away", "kickoff_at", "state"], "properties": {
  "ref": { "type": "string" }, "source": { "enum": ["api_football", "openligadb"] }, "competition": { "type": "string" },
  "home": { "type": "string" }, "away": { "type": "string" }, "kickoff_at": { "type": "number" },
  "state": { "enum": ["pre_match", "live", "half_time", "finished", "postponed"] },
  "minute": { "type": ["integer", "null"], "default": null },
  "score_home": { "type": ["integer", "null"], "default": null },
  "score_away": { "type": ["integer", "null"], "default": null } } }
```

All objects keep `"additionalProperties": false`. `MatchListing` deliberately has no score.

- [ ] **Step 1: Failing tests in `tests/test_contracts.py`**

```python
from kickstream.contracts import MatchEvent, MatchListing, MatchStatus, PlayerReport, StatsSnapshot

OLD_STATUS = {  # as saved before this phase: no source, detail, credit or competition
    "match_id": "m-1", "state": "finished", "minute": 90, "score_home": 1, "score_away": 0, "speed": 30,
    "home": {"id": "nbr", "name": "Northbridge FC", "short_name": "NBR", "color": "#0F6CBD", "players": []},
    "away": {"id": "hbc", "name": "Harbour City", "short_name": "HBC", "color": "#C50F1F", "players": []},
}

def test_a_status_saved_before_real_data_still_loads_as_a_simulated_full_match():
    status = MatchStatus.model_validate(OLD_STATUS)
    assert (status.source, status.detail, status.credit, status.competition) == ("simulated", "full", None, None)
    assert status.home.formation is None

def test_events_default_to_located_without_their_own_xg():
    event = MatchEvent(id="m-1-e1", match_id="m-1", seq=1, minute=0, second=0, type="pass", x=50, y=50)
    assert event.located is True and event.xg is None

def test_a_match_listing_cannot_carry_a_score():
    with pytest.raises(ValidationError):
        MatchListing(ref="43/3/8658", date="2018-07-15", home="France", away="Croatia", home_score=4)

def test_a_player_report_holds_two_real_squads():
    assert PlayerReport.model_fields["players"]  # maxItems 60: build one with 52 PlayerMetrics and validate

def test_stats_say_which_fields_the_source_measured():
    assert StatsSnapshot.model_validate({**_stats(), "provided": ["goals", "possession"]}).provided == ["goals", "possession"]
```

(`_stats()` is a minimal valid `StatsSnapshot` dict built from `tests.factories.stats().model_dump()`.)

- [ ] **Step 2: Run, expect fail:** `uv run pytest tests/test_contracts.py -q`
- [ ] **Step 3: Edit the schema, then regenerate both sides**

```bash
# services/pipeline
uv run python -m kickstream.tools.gen_contracts
# apps/web
pnpm gen:contracts
```

- [ ] **Step 4: Run everything, expect pass.** Nothing else changes yet, because every field is optional: `uv run pytest -q`, `uv run ruff check .`, `pnpm exec vitest run`, `pnpm exec tsc -b`.
- [ ] **Step 5: Commit**

```bash
git add packages/contracts/kickstream.schema.json services/pipeline/kickstream/contracts.py services/pipeline/tests/test_contracts.py apps/web/src/contracts.ts
git commit -m "Describe real match data in the contracts: source, detail, credit, xG, located events and per-match line-ups"
```

---

### Task 2: The match source port and team helpers

**Files:**
- Create: `services/pipeline/kickstream/ports/match_source.py`
- Modify: `services/pipeline/kickstream/domain/teams.py`
- Create: `services/pipeline/tests/test_match_sources.py`
- Modify: `services/pipeline/tests/test_domain.py`

**Interfaces:**

```python
# ports/match_source.py
"""What Kickstream needs from a football data service: past matches to replay, or live matches to follow."""
from dataclasses import dataclass, field
from datetime import date
from typing import Literal, Protocol
from kickstream.contracts import Competition, Fixture, MatchEvent, MatchListing, TeamSheet, TeamStats
from kickstream.domain.types import Side

LiveSourceId = Literal["api_football", "openligadb"]
LiveState = Literal["pre_match", "live", "half_time", "finished"]

class SourceFailure(Exception):
    """A source could not be read, or refused. The message is written for the streamer and says what to do."""
    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.retry_after = retry_after  # seconds; set when waiting is the only fix (a spent daily budget)

class SourceUnavailable(SourceFailure):
    """The source cannot be used at all as configured, e.g. its key is not set."""

@dataclass(frozen=True)
class ReplayMatch:
    home: TeamSheet
    away: TeamSheet
    events: list[MatchEvent]
    competition: str

@dataclass(frozen=True)
class LiveEvent:
    key: str                      # stable across polls, so an event is published once
    minute: int
    type: Literal["goal", "yellow_card", "red_card", "substitution"]
    team: Side
    player_id: str | None = None
    player_in_id: str | None = None

@dataclass(frozen=True)
class LiveSnapshot:
    state: LiveState
    minute: int
    score_home: int
    score_away: int
    home: TeamSheet
    away: TeamSheet
    competition: str
    kickoff_at: float             # Unix seconds
    events: tuple[LiveEvent, ...] = ()
    stats: tuple[TeamStats, TeamStats] | None = None
    provided: tuple[str, ...] = ()  # TeamStats fields the source measured

@dataclass(frozen=True)
class PollPlan:
    pre_match_s: float
    soon_s: float                 # within 15 minutes of kick-off
    live_s: float
    half_time_s: float

class ReplaySource(Protocol):
    id: str
    name: str
    credit: str
    async def competitions(self) -> list[Competition]: ...
    async def matches(self, competition_id: int, season_id: int) -> list[MatchListing]: ...
    async def load(self, ref: str, match_id: str) -> ReplayMatch:
        """Raises SourceFailure."""

class LiveSource(Protocol):
    id: LiveSourceId
    name: str
    credit: str
    available: bool               # false when its key is not set
    setup: str | None             # what to do to make it available
    poll: PollPlan
    async def fixtures(self, day: date) -> list[Fixture]: ...
    async def snapshot(self, ref: str) -> LiveSnapshot:
        """Raises SourceFailure."""
    def budget(self) -> tuple[int, int] | None:
        """(used today, daily limit), or None when the source has no limit."""
```

```python
# domain/teams.py additions
PALETTE = ("#0F6CBD", "#C50F1F", "#107C10", "#5C2E91", "#CA5010", "#038387", "#8764B8", "#986F0B")

def team_colors(home: str | None, away: str | None) -> tuple[str, str]:
    """Each side's colour: the source's own when it gives a valid `#RRGGBB`, else from PALETTE, never the same twice."""

def short_name(name: str) -> str:
    """Three letters for a scoreboard: "France" -> "FRA", "Bayern München" -> "BAY". Letters only, upper-cased."""
```

`_sheet()` sets `starting=number <= 11`, so `HOME` and `AWAY` have 11 starters each.

- [ ] **Step 1: Failing tests**

```python
# tests/test_domain.py
def test_the_fictional_clubs_name_their_starting_eleven():
    for sheet in (HOME, AWAY):
        assert [p.starting for p in sheet.players] == [True] * 11 + [False] * 3

def test_team_colors_keep_a_sources_colours_and_never_repeat():
    assert team_colors("#FFFFFF", "#000000") == ("#FFFFFF", "#000000")
    home, away = team_colors(None, None)
    assert home != away and {home, away} <= set(PALETTE)
    assert team_colors("#0F6CBD", "#0F6CBD")[0] != team_colors("#0F6CBD", "#0F6CBD")[1]
    assert team_colors("red", None)[0] in PALETTE  # not a #RRGGBB

@pytest.mark.parametrize("name, short", [("France", "FRA"), ("Bayern München", "BAY"), ("1. FC Köln", "FCK")])
def test_short_names(name, short):
    assert short_name(name) == short
```

(`"1. FC Köln"`: letters only, so it uses the initials of the words with letters when the first word has fewer than three letters. Write the rule to match the three cases and document it in the docstring.)

```python
# tests/test_match_sources.py
def test_a_source_failure_carries_the_message_and_when_to_retry():
    failure = SourceFailure("Today's 100 free requests are used up.", retry_after=3600)
    assert str(failure) == failure.message and failure.retry_after == 3600
    assert isinstance(SourceUnavailable("Set the key."), SourceFailure)
```

- [ ] **Step 2: Run, expect fail:** `uv run pytest tests/test_domain.py tests/test_match_sources.py -q`
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the whole suite** (the architecture test checks that `ports` imports only shared packages): `uv run pytest -q && uv run ruff check .`
- [ ] **Step 5: Commit**

```bash
git add services/pipeline/kickstream/ports/match_source.py services/pipeline/kickstream/domain/teams.py services/pipeline/tests/test_match_sources.py services/pipeline/tests/test_domain.py
git commit -m "Add the match source port and team colour and short-name helpers"
```

---

### Task 3: Analytics and agents use real xG and skip unlocated events

**Files:**
- Modify: `kickstream/analytics/state.py`, `kickstream/analytics/stage.py`
- Modify: `kickstream/agents/interpreter.py`, `prediction.py`, `tracking.py`, `highlights.py`, `visualize.py`, `tactics.py`, `squad.py`, `stage.py`
- Modify: `tests/test_analytics.py`, `tests/test_agents.py`, `tests/test_agents_pipeline.py`

**Interfaces:**
- `analytics.state.apply(state, event, cfg, *, snapshots: bool = True)`. With `snapshots=False` it returns only `KeyMoment`s.
- In `_record`:
  - The pressure grid is updated only when `event.located`.
  - A shot's chance is `event.xg` when it is not None. Otherwise it is the local `xg(...)` when located, and `0.0` when neither.
  - A goal's facts are today's three only when the state has seen a located event (`MatchState.located_seen: bool`). Otherwise they are `[]`.
  - A red card's facts are `[("players_on_pitch", 11 - tally.red)]` when nothing located has been seen.
- `AnalyticsStage` subscribes to `STATUS` as well as `EVENTS`. It remembers `detail` per match and calls `apply(..., snapshots=detail == "full")`. For key-events matches the live runner publishes the stats (Task 10).
- `EventInterpreter.handle` copies `xg` and `located` into the `PlayEvent`. For unlocated events `danger = 0.0`; `zone` and `lane` are the neutral `"middle_third"` / `"centre"`, which consumers ignore because `located` is false.
- `PredictionAgent`, `PlayerTracker`, `HighlightsAgent`:
  - Use `play.xg` when present.
  - Skip danger grids, heat, transition counts, `dangerous_turnover` and `big_save` (which reads the shot's position) for unlocated plays.
  - `PredictionAgent._rate`: when no located play has been seen, the rate is the base rate adjusted only for red cards (no xG, no momentum).
- `VisualizationAgent.handle` returns `[]` for an unlocated play and leaves its ball, lanes and columns untouched.
- `Squad.__init__`: `on_pitch` takes the players with `starting`, or the first 11 when none are marked. New `Squad.refresh(home, away)` replaces `sheets` and the player index and keeps `on_pitch`.
- `agents/stage.py` `_Team(status)`:
  - When `status.detail == "key_events"`, the agent list is `[EventInterpreter(), PredictionAgent(), PlayerTracker(squad), HighlightsAgent(squad)]`.
  - In `take`, every later `MatchStatus` for a known match calls `team.squad.refresh(payload.home, payload.away)`.

- [ ] **Step 1: Failing tests (use `tests.factories.event`)**

```python
# tests/test_analytics.py
def test_a_shot_counts_the_sources_own_xg_when_it_has_one():
    state, _ = run([event(1, "shot", "home", x=60, outcome="saved", xg=0.42)])
    assert state.tally["home"].xg == pytest.approx(0.42)

def test_unlocated_events_add_no_pressure_and_shots_without_xg_add_none():
    state, out = run([event(1, "shot", "home", x=90, outcome="off_target", located=False)])
    assert attack_pressure(state, "home") == 0 and state.tally["home"].xg == 0
    assert moments(out, "big_chance") == []

def test_a_goal_in_a_key_events_match_has_no_invented_facts():
    _, out = run([event(1, "goal", "home", located=False)])
    assert moments(out, "goal")[0].facts == []

async def test_the_stage_leaves_stats_to_the_source_for_key_events_matches():
    # publish MatchStatus(detail="key_events") then a goal; INSIGHTS gets a KeyMoment and no StatsSnapshot/PressureSnapshot
```

```python
# tests/test_agents.py
def test_the_interpreter_passes_xg_and_location_on():
    play = EventInterpreter().handle(event(1, "shot", "home", xg=0.3, located=False))[0]
    assert (play.xg, play.located, play.danger) == (0.3, False, 0.0)

def test_the_visualization_agent_draws_nothing_for_an_unlocated_play():
    assert VisualizationAgent(Squad(HOME, AWAY)).handle(play_of(event(1, "goal", "home", located=False))) == []

def test_the_squad_starts_the_players_marked_starting_and_learns_new_ones():
    home = HOME.model_copy(update={"players": [p.model_copy(update={"starting": p.number in range(4, 15)}) for p in HOME.players]})
    squad = Squad(home, AWAY)
    assert squad.on_pitch["home"] == [p.id for p in home.players if p.starting]
    newcomer = Player(id="ol-1", name="New Scorer", number=0, position="MF")
    squad.refresh(home.model_copy(update={"players": [*home.players, newcomer]}), AWAY)
    assert squad.player_name("ol-1") == "New Scorer"

def test_prediction_without_located_play_uses_the_base_rate_only(): ...
```

```python
# tests/test_agents_pipeline.py
async def test_position_only_agents_sit_out_a_key_events_match():
    # MatchStatus(detail="key_events") then a goal and a minute change:
    # AGENTS carries no TacticalInsight and no PitchScene; AgentRun ids name only the four running agents
```

- [ ] **Step 2: Run, expect fail:** `uv run pytest tests/test_analytics.py tests/test_agents.py tests/test_agents_pipeline.py -q`
- [ ] **Step 3: Implement.** Existing simulated-match tests must not change: simulated events are located and have no `xg`, so the old paths run.
- [ ] **Step 4: Full suite:** `uv run pytest -q && uv run ruff check .`
- [ ] **Step 5: Commit**

```bash
git add services/pipeline/kickstream/analytics services/pipeline/kickstream/agents services/pipeline/tests/test_analytics.py services/pipeline/tests/test_agents.py services/pipeline/tests/test_agents_pipeline.py
git commit -m "Use a source's own xG, ignore positions a live feed does not have, and follow real line-ups"
```

---

### Task 4: Narration and overlays say only what was measured

**Files:**
- Modify: `kickstream/overlay/build.py`, `kickstream/overlay/stage.py`
- Modify: `kickstream/adapters/scripted_writer.py`, `kickstream/adapters/agent_writer.py`
- Modify: `tests/test_overlay.py`, `tests/test_scripted_writer.py`, `tests/test_agent_writer.py`

**Interfaces:**
- `stat_card(...)` keeps only the rows of `_STAT_ROWS` that are in `snapshot.provided` (all of them when `provided is None`). `OverlayStage._build` sends no stat card when no row is left.
- `OverlayStage` remembers `detail` from each `MatchStatus` and sends no `pressure_map` for `key_events` matches.
- `ScriptedNarrativeWriter.write_moment`: when `moment.facts == []` it uses a new `_MOMENT_PLAIN[language][mode][kind]` (goal and red_card in en/es/hi) with no `{facts}` clause. Example en fan goal: `"{team} score through {player} ({minute}'). Score: {score}."`.
- `ScriptedNarrativeWriter.write_recap`:
  - When `ctx.stats.provided` is not None and lacks `"shots"` or `"xg"`, the bullets are `(headline, moments, measured)`. `measured` is a new `_RECAP[language]["measured"]`, e.g. en `"Detailed statistics are not available for this match."`.
  - The analyst text closes with the moments sentence instead of shots and xG.
- `agent_writer._stats_line(ctx)` names only provided fields. The recap prompt leaves out the "Match numbers" line when nothing beyond goals is provided.

- [ ] **Step 1: Failing tests**

```python
def test_a_stat_card_shows_only_what_the_source_measured():
    card = stat_card("o1", stats().model_copy(update={"provided": ["goals", "possession", "shots"]}), "en")
    assert [row.label for row in card.data.stat_rows] == ["Possession %", "Shots"]

async def test_no_pressure_map_or_empty_stat_card_for_a_key_events_match(): ...

async def test_a_goal_without_facts_reads_without_a_facts_clause():
    written = await ScriptedNarrativeWriter().write_moment(moment_ctx(facts=[]))
    assert ": ." not in written[("fan", "en")].text and "Score:" in written[("fan", "en")].text

async def test_a_recap_never_quotes_shots_or_xg_the_source_did_not_give(): ...

def test_the_agent_prompt_leaves_out_unmeasured_numbers(): ...
```

- [ ] **Step 2: Run, expect fail:** `uv run pytest tests/test_overlay.py tests/test_scripted_writer.py tests/test_agent_writer.py -q`
- [ ] **Step 3: Implement**
- [ ] **Step 4: Full suite**
- [ ] **Step 5: Commit**

```bash
git add services/pipeline/kickstream/overlay services/pipeline/kickstream/adapters/scripted_writer.py services/pipeline/kickstream/adapters/agent_writer.py services/pipeline/tests/test_overlay.py services/pipeline/tests/test_scripted_writer.py services/pipeline/tests/test_agent_writer.py
git commit -m "Narrate and overlay only the statistics a source actually measured"
```

---

### Task 5: StatsBomb conversion (pure) with trimmed real fixtures

**Files:**
- Create: `kickstream/adapters/statsbomb.py` (conversion half only)
- Create: `kickstream/tools/trim_statsbomb.py`
- Create: `tests/fixtures/statsbomb/{competitions.json, matches/43/3.json, events/8658.json, lineups/8658.json}`
- Create: `tests/test_statsbomb.py`

**Making the fixtures (once; network use by the implementer only, nothing in the suite):**

```powershell
$d = Join-Path $env:TEMP "statsbomb-raw"; New-Item -ItemType Directory -Force $d | Out-Null
$b = "https://raw.githubusercontent.com/hudl/open-data/master/data"
Invoke-WebRequest "$b/competitions.json" -OutFile "$d/competitions.json"
Invoke-WebRequest "$b/matches/43/3.json" -OutFile "$d/matches-43-3.json"
Invoke-WebRequest "$b/events/8658.json" -OutFile "$d/events-8658.json"
Invoke-WebRequest "$b/lineups/8658.json" -OutFile "$d/lineups-8658.json"
uv run python -m kickstream.tools.trim_statsbomb $d tests/fixtures/statsbomb
```

`trim_statsbomb` keeps:
- **Competitions:** three entries, including competition 43, season 3 (FIFA World Cup 2018).
- **Matches:** three matches of 43/3, including 8658 (France 4–2 Croatia, the final). `home_score` / `away_score` are kept so tests can prove the listing drops them.
- **Events:** every `Starting XI`, `Half Start`, `Half End`, `Shot` (without `freeze_frame`), `Substitution`, `Own Goal For` / `Own Goal Against`, `Bad Behaviour`, `Goal Keeper` of a save type, and `Foul Committed` with a card. Every `Pass` of type `Kick Off` or `Corner`, the four passes before each goal, and the first two passes that have an `outcome`. `related_events` is removed. In the real file this comes to about 80 events and 55 KB. It holds 5 shot goals and the own goal, so the final score is 4–2, and 2 yellow cards (France 26', Croatia 91').
- **Lineups:** the whole file, minus each player's `country`.

**Interfaces:**

```python
SB_LENGTH, SB_WIDTH = 120.0, 80.0
SAVE_TYPES = {"Shot Saved", "Penalty Saved", "Shot Saved to Post", "Shot Saved Off Target", "Save"}
SHOT_OUTCOME = {"Goal": "goal", "Saved": "saved", "Saved to Post": "saved", "Off T": "off_target",
                "Wayward": "off_target", "Post": "off_target", "Saved Off Target": "off_target", "Blocked": "blocked"}
CARD = {"Yellow Card": "yellow_card", "Second Yellow": "red_card", "Red Card": "red_card"}
POSITION = {1: ("GK", "1:1"), 2: ("DF", "2:1"), 3: ("DF", "2:2"), 4: ("DF", "2:3"), 5: ("DF", "2:4"), 6: ("DF", "2:5"),
            7: ("DF", "3:1"), 8: ("DF", "3:5"), 9: ("MF", "3:2"), 10: ("MF", "3:3"), 11: ("MF", "3:4"),
            12: ("MF", "4:1"), 13: ("MF", "4:2"), 14: ("MF", "4:3"), 15: ("MF", "4:4"), 16: ("MF", "4:5"),
            17: ("FW", "5:1"), 18: ("MF", "5:2"), 19: ("MF", "5:3"), 20: ("MF", "5:4"), 21: ("FW", "5:5"),
            22: ("FW", "6:2"), 23: ("FW", "6:3"), 24: ("FW", "6:4"), 25: ("FW", "5:3")}
# grid is "line:slot": line 1 the goalkeeper, rising towards attack; slot 1 is the team's right

def to_pitch(location: list[float], side: Side) -> tuple[float, float]:
    """StatsBomb's 120 x 80 pitch, seen from the acting team attacking left to right, as Kickstream's 0-100
    with the home side attacking x = 100. Away events are turned through 180 degrees (x and y flipped)."""

def formation(value: int | str | None) -> str | None:     # 442 -> "4-4-2", 4231 -> "4-2-3-1"

def team_sheets(listing: dict, lineups: list[dict], events: list[dict]) -> tuple[TeamSheet, TeamSheet]:
    """Home and away from the season's match list. Players are `sb-{player_id}`: the Starting XI first, in its
    order, with grid and starting=True, then the bench by shirt number. A bench player's position is their first
    `positions` entry, or MF when they never played. Formation comes from the Starting XI event."""

def convert_events(match_id: str, events: list[dict], home_team_id: int) -> list[MatchEvent]:
    """Kickstream events in file order (StatsBomb's own match-time order), numbered from 1."""

def convert(match_id: str, listing: dict, lineups: list[dict], events: list[dict]) -> ReplayMatch: ...
```

Conversion rules (events with no `location` get `x = y = 50`, `located=False`):

| StatsBomb | Kickstream |
|---|---|
| First `Half Start` of period 1–4 | `kickoff`, team and player of that period's first `Pass` of type `Kick Off`, at (50, 50), located |
| `Pass` of type `Corner` | `corner` |
| Other `Pass` | `pass`, `completed = "outcome" not in pass` |
| `Shot` | `shot` with the mapped outcome and `xg = shot.statsbomb_xg`. For `Goal`, followed by `goal` at x = 100 (home) or 0 (away), y = 50 |
| `Own Goal For` | `goal` for that team, `player_id=None` |
| `Goal Keeper` with a save type | `save` |
| `Foul Committed` | `foul`, then a card event when `foul_committed.card` is set |
| `Bad Behaviour` with `bad_behaviour.card` | the card event only |
| `Substitution` | `substitution`, `player_in_id = sb-{replacement.id}`, unlocated |
| First `Half End` of period 1 | `half_time` |
| First `Half End` of the last period played (2 or 4) | `full_time` |
| Anything in period 5; other `Half End`s; Carry, Pressure, Ball Receipt*, Duel and the rest | dropped |

- [ ] **Step 1: Failing tests (`tests/test_statsbomb.py`, reading the fixtures with `json.loads(Path(...).read_text("utf-8"))`)**

```python
FIX = Path(__file__).parent / "fixtures" / "statsbomb"

def final():
    listing = next(m for m in load("matches/43/3.json") if m["match_id"] == 8658)
    return convert("m-1", listing, load("lineups/8658.json"), load("events/8658.json"))

def test_positions_are_scaled_and_away_events_turned_round():
    assert to_pitch([120, 80], "home") == (100.0, 100.0)
    assert to_pitch([120, 0], "away") == (0.0, 100.0)
    assert to_pitch([60, 40], "away") == (50.0, 50.0)

def test_france_are_at_home_with_their_starting_eleven_first():
    match = final()
    assert (match.home.name, match.away.name) == ("France", "Croatia")
    assert match.home.formation == "4-4-2" and match.home.id == "sb-771"
    starters = [p for p in match.home.players if p.starting]
    assert len(starters) == 11 and match.home.players[:11] == starters
    lloris = next(p for p in match.home.players if p.name == "Hugo Lloris")
    assert (lloris.id, lloris.position, lloris.grid) == ("sb-3099", "GK", "1:1")
    assert len({p.id for p in match.home.players + match.away.players}) == 45

def test_the_final_replays_to_four_two_with_the_own_goal_unnamed():
    goals = [e for e in final().events if e.type == "goal"]
    assert [e.team for e in goals].count("home") == 4 and [e.team for e in goals].count("away") == 2
    assert goals[0].minute == 17 and goals[0].team == "home" and goals[0].player_id is None

def test_a_scored_shot_carries_statsbomb_xg_and_is_followed_by_the_goal():
    events = final().events
    index = next(i for i, e in enumerate(events) if e.type == "shot" and e.outcome == "goal")
    assert events[index].xg is not None and events[index + 1].type == "goal"

def test_saves_corners_incomplete_passes_and_cards(): ...
def test_substitutions_name_who_comes_on_and_are_unlocated(): ...

def test_periods_give_kickoffs_one_half_time_and_full_time_and_drop_the_shootout():
    # small synthetic list: Half Start/End for periods 1-5 plus a period-5 Shot
    types = [e.type for e in convert_events("m-1", synthetic_extra_time(), home_team_id=1)]
    assert types.count("kickoff") == 4 and types.count("half_time") == 1 and types[-1] == "full_time"
    assert "shot" not in types

def test_a_second_yellow_is_a_red_card_and_bad_behaviour_cards_count(): ...  # synthetic events
def test_ids_are_sequential_and_file_order_is_kept(): ...
def test_carries_and_pressures_are_left_out(): ...
```

- [ ] **Step 2: Run, expect fail:** `uv run pytest tests/test_statsbomb.py -q`
- [ ] **Step 3: Implement the conversion and the trim tool; produce the fixtures as above**
- [ ] **Step 4: Full suite and ruff**
- [ ] **Step 5: Commit**

```bash
git add services/pipeline/kickstream/adapters/statsbomb.py services/pipeline/kickstream/tools/trim_statsbomb.py services/pipeline/tests/fixtures/statsbomb services/pipeline/tests/test_statsbomb.py
git commit -m "Convert StatsBomb open data events and line-ups into Kickstream events and team sheets"
```

---

### Task 6: StatsBomb downloads and the offline cache

**Files:**
- Create: `kickstream/adapters/http_json.py`
- Modify: `kickstream/adapters/statsbomb.py`
- Modify: `tests/test_statsbomb.py`

**Interfaces:**

```python
# adapters/http_json.py
Get = Callable[[str, Mapping[str, str]], tuple[bytes, dict[str, str]]]

def http_get(url: str, headers: Mapping[str, str], timeout: float = 30.0) -> tuple[bytes, dict[str, str]]:
    """GET with urllib (`User-Agent: Kickstream`). Response headers are lower-cased. Raises HTTPError and URLError
    unchanged so each adapter writes its own message."""
```

```python
# adapters/statsbomb.py
OPEN_DATA = "https://raw.githubusercontent.com/hudl/open-data/master/data/"
LISTS_FRESH_S = 7 * 86400  # competitions and season lists are refreshed weekly; events and line-ups never change

class StatsBombOpenData:
    id = "statsbomb"
    name = "StatsBomb Open Data"
    credit = "Data: StatsBomb"

    def __init__(self, cache_dir: Path, base_url: str = OPEN_DATA, get: Get = http_get,
                 now: Callable[[], float] = time.time) -> None: ...
    async def competitions(self) -> list[Competition]       # newest season first, then by name
    async def matches(self, competition_id: int, season_id: int) -> list[MatchListing]
        # ref "c/s/m", date, kick_off "HH:MM", home/away names, stage name; sorted by date and kick-off; no scores
    async def load(self, ref: str, match_id: str) -> ReplayMatch
        # parses "c/s/m" (all digits, else SourceFailure), reads the listing, events and line-ups, calls convert()
```

- Files are cached under `cache_dir` at the same relative path as on the server (`competitions.json`, `matches/43/3.json`, `events/8658.json`, `lineups/8658.json`). They are written to a `.tmp` file and then renamed.
- Every read runs in `asyncio.to_thread`.
- A stale list is used when the network fails. With nothing cached, a failure raises `SourceFailure("StatsBomb's open data could not be reached. Check the internet connection and try again. Matches downloaded before still play offline.")`.
- An unknown match in the season list raises `SourceFailure("StatsBomb has no match {ref}. Choose one from the list.")`.
- JSON that does not parse raises `SourceFailure("StatsBomb sent a file Kickstream could not read. Try again later.")`.

- [ ] **Step 1: Failing tests (a fake `get` that serves `tests/fixtures/statsbomb` and counts calls)**

```python
async def test_a_match_is_downloaded_once_and_then_plays_offline(tmp_path):
    served = FixtureGet(FIX)
    source = StatsBombOpenData(tmp_path, base_url="https://sb.test/data/", get=served)
    first = await source.load("43/3/8658", "m-1")
    assert served.calls == ["https://sb.test/data/matches/43/3.json", ".../events/8658.json", ".../lineups/8658.json"]
    offline = StatsBombOpenData(tmp_path, base_url="https://sb.test/data/", get=failing_get)
    assert (await offline.load("43/3/8658", "m-2")).home.name == first.home.name

async def test_the_match_list_never_gives_away_the_score(tmp_path):
    listings = await source(tmp_path).matches(43, 3)
    final = next(m for m in listings if m.ref == "43/3/8658")
    assert (final.home, final.away, final.stage) == ("France", "Croatia", "Final")
    assert "score" not in json.dumps([m.model_dump() for m in listings])

async def test_competitions_are_newest_first(tmp_path): ...
async def test_a_stale_list_is_used_when_the_network_fails(tmp_path): ...   # now() moved 8 days on, failing get
async def test_no_cache_and_no_network_says_what_to_do(tmp_path):
    with pytest.raises(SourceFailure, match="internet connection"):
        await StatsBombOpenData(tmp_path, get=failing_get).competitions()

@pytest.mark.parametrize("ref", ["8658", "43/3/../x", "43/3/8658/1", "a/b/c"])
async def test_refs_that_are_not_three_numbers_are_refused(tmp_path, ref): ...
```

- [ ] **Step 2: Run, expect fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Full suite**
- [ ] **Step 5: Commit**

```bash
git add services/pipeline/kickstream/adapters/http_json.py services/pipeline/kickstream/adapters/statsbomb.py services/pipeline/tests/test_statsbomb.py
git commit -m "Download StatsBomb matches on first use and replay them offline from the cache"
```

---

### Task 7: Replays through the simulator, and per-match teams in the controller

**Files:**
- Modify: `kickstream/simulator/stage.py`, `kickstream/control.py`
- Modify: `tests/test_simulator.py`, `tests/test_control.py`

**Interfaces:**

```python
# simulator/stage.py
async def play(self, match_id, events, home, away, speed, *, source: str = "simulated", detail: str = "full",
               credit: str | None = None, competition: str | None = None) -> None
```

Every `MatchStatus` it publishes carries these four fields.

```python
# control.py
class MatchController:
    def __init__(self, bus, clock_factory, home, away, prefix="m", *,
                 replays: Mapping[str, ReplaySource] = MappingProxyType({}),
                 live: Mapping[str, LiveSource] = MappingProxyType({}),
                 live_match: Callable[..., LiveMatch] | None = None) -> None
    @property
    def teams(self) -> tuple[TeamSheet, TeamSheet]   # the current match's, or (home, away) before any
    def running(self) -> RunningMatch | None          # the playing match: id, source, ref, "Home vs Away", problem
    async def start(self, seed: int = DEMO_SEED, speed: float = 30.0, *, source: str = "simulated",
                    ref: str | None = None) -> str
```

The existing calls `start(11, 30)` and studio's `start(DEMO_SEED, STUDIO_MATCH_SPEED)` keep working.

`start` with `source="statsbomb"`:
- Under the lock, compute the next ID without recording it. Await `replays["statsbomb"].load(ref, match_id)` before cancelling anything.
- On `SourceFailure`, re-raise. The running match is untouched and the ID is not used.
- Otherwise cancel the running match and play the replay through a new `Simulator` with `source="statsbomb"`, `detail="full"`, `credit=replay_source.credit`, `competition=replay.competition`. Record the ID and announce the abandoned match as today.
- An unknown source name raises `SourceUnavailable(f"Kickstream has no source called {source}.")`. A missing `"statsbomb"` entry raises `SourceUnavailable`.

- [ ] **Step 1: Failing tests**

```python
# tests/test_simulator.py
async def test_a_replay_status_names_its_source_detail_and_credit():
    # play 3 events with source="statsbomb", credit="Data: StatsBomb", competition="FIFA World Cup 2018"
    assert (first.source, first.detail, first.credit, first.competition) == ("statsbomb", "full", "Data: StatsBomb", "FIFA World Cup 2018")

# tests/test_control.py
class FakeReplays:
    id, name, credit = "statsbomb", "StatsBomb Open Data", "Data: StatsBomb"
    def __init__(self, fail=False): self.fail = fail
    async def load(self, ref, match_id):
        if self.fail: raise SourceFailure("StatsBomb's open data could not be reached.")
        return ReplayMatch(home=REAL_HOME, away=REAL_AWAY, events=three_events(match_id), competition="Test Cup 2018")

async def test_a_statsbomb_match_plays_with_its_own_teams():
    control, statuses = controller(InstantClock, replays={"statsbomb": FakeReplays()})
    match_id = await control.start(speed=600, source="statsbomb", ref="43/3/8658")
    await asyncio.wait_for(control.wait(), 5)
    assert control.teams == (REAL_HOME, REAL_AWAY)
    assert {s.source for s in drain(statuses)} == {"statsbomb"}

async def test_a_failed_load_leaves_the_running_match_and_uses_no_id():
    control, statuses = controller(StuckClock, replays={"statsbomb": FakeReplays(fail=True)})
    await control.start(11, 30)
    with pytest.raises(SourceFailure):
        await control.start(source="statsbomb", ref="43/3/1")
    assert control.current == "m-1" and not control.exists("m-2")
    assert [s.state for s in drain(statuses)] == ["live"]  # nothing abandoned
    assert await control.start(11, 30) == "m-2"

async def test_teams_are_the_defaults_before_any_match(): ...
async def test_running_names_the_match_and_its_source(): ...
async def test_an_unknown_source_is_unavailable(): ...
```

- [ ] **Step 2: Run, expect fail:** `uv run pytest tests/test_simulator.py tests/test_control.py -q`
- [ ] **Step 3: Implement.** `control.py` may import `ports.match_source`; it is the composition layer, not a stage.
- [ ] **Step 4: Full suite**
- [ ] **Step 5: Commit**

```bash
git add services/pipeline/kickstream/simulator/stage.py services/pipeline/kickstream/control.py services/pipeline/tests/test_simulator.py services/pipeline/tests/test_control.py
git commit -m "Play StatsBomb replays through the match engine with each match's own teams"
```

---

### Task 8: API-Football adapter and its daily budget

**Files:**
- Create: `kickstream/adapters/api_football.py`
- Create: `tests/fixtures/api_football/`:
  - `fixtures-date.json`: three fixtures. One `NS` (Premier League), one `1H` 12' 0–0 (Premier League), one `FT` 2–1 (La Liga).
  - `fixture-1.json`: `1H` 12', 0–0. Line-ups with `colors`, `startXI` with `grid`, `substitutes`. Statistics.
  - `fixture-2.json`: `1H` 34', 1–0. A Normal Goal and a Yellow Card.
  - `fixture-3.json`: `HT`.
  - `fixture-4.json`: `FT` 2–1. A Penalty goal, a `subst` and a Second Yellow card.
  - `errors-plan.json`, `errors-token.json`, `errors-requests.json`.
  - `README.md`: one paragraph saying these are hand-written from https://www.api-football.com/documentation-v3 and should be replaced by recorded responses (see Task 18).
- Create: `tests/test_api_football.py`

**Interfaces:**

```python
API_FOOTBALL = "https://v3.football.api-sports.io"
DAILY_LIMIT = 100
LIST_FRESH_S = 600  # a day's fixture list is reused for ten minutes, to spare the budget

class DailyBudget:
    """Requests used today (UTC), saved in the data directory so a restart does not reset it."""
    def __init__(self, store, limit: int = DAILY_LIMIT, now: Callable[[], float] = time.time) -> None
        # store: anything with load() -> dict | None and save(dict); app.py passes JsonRecordStore(data_dir / "api-football-budget.json")
    def used(self) -> int
    def take(self) -> None      # raises SourceFailure(..., retry_after=seconds to 00:00 UTC) when spent
    def sync(self, remaining: int | None) -> None   # from x-ratelimit-requests-remaining: used = limit - remaining

STATE = {"TBD": "pre_match", "NS": "pre_match", "1H": "live", "2H": "live", "ET": "live", "BT": "live", "P": "live",
         "LIVE": "live", "SUSP": "live", "INT": "live", "HT": "half_time", "FT": "finished", "AET": "finished",
         "PEN": "finished", "PST": "postponed", "CANC": "postponed", "ABD": "postponed", "AWD": "finished", "WO": "finished"}
STAT = {"Ball Possession": "possession", "Total Shots": "shots", "Shots on Goal": "shots_on_target",
        "Total passes": "passes", "Passes %": "pass_accuracy", "Fouls": "fouls", "Yellow Cards": "yellow_cards",
        "Red Cards": "red_cards", "expected_goals": "xg"}
HINT = {"token": "Check KICKSTREAM_API_FOOTBALL_KEY in the .env file.",
        "plan": "The free plan does not cover this match. Choose another, or use StatsBomb or OpenLigaDB.",
        "requests": "Today's free requests are used up; live updates resume after midnight UTC.",
        "rateLimit": "Too many requests in one minute; Kickstream will try again shortly."}

def errors_message(body: dict) -> tuple[str, str | None] | None   # (text for the streamer, error key)
def fixture_listing(body: dict) -> list[Fixture]
def snapshot_from(body: dict) -> LiveSnapshot

class ApiFootball:
    id = "api_football"
    name = "API-Football"
    credit = "Data: API-Football"
    poll = PollPlan(pre_match_s=600, soon_s=120, live_s=90, half_time_s=300)

    def __init__(self, key: str | None, budget: DailyBudget, base_url: str = API_FOOTBALL, get: Get = http_get,
                 now: Callable[[], float] = time.time) -> None
    available: bool   # key is not None
    setup: str | None # None with a key, else "Add KICKSTREAM_API_FOOTBALL_KEY=<your key> to the .env file at the top of
                      # the project and restart the pipeline. Get a free key at https://dashboard.api-football.com/register."
    async def fixtures(self, day: date) -> list[Fixture]   # GET /fixtures?date=YYYY-MM-DD
    async def snapshot(self, ref: str) -> LiveSnapshot     # GET /fixtures?id={ref}; ref must be digits
    def budget(self) -> tuple[int, int]
```

Parsing rules:
- Team ids are `af-{team.id}`. Colours come from `lineups[i].team.colors.player.primary` as `#` + hex, through `team_colors`.
- Players come from `startXI` (`starting=True`, `grid`) and `substitutes`. Ids are `af-{player.id}`. Position `G/D/M/F` maps to `GK/DF/MF/FW`.
- A player who appears only in events is added with number 0 and position MF. Formation comes from `lineups[i].formation`.
- `minute = elapsed + (extra or 0)`.
- Events:
  - `Goal` (`Normal Goal`, `Penalty`, `Own Goal`) → `goal` for `event.team`.
  - `Missed Penalty` is skipped.
  - `Card` `Yellow Card` → `yellow_card`; `Red Card` and `Second Yellow card` → `red_card`.
  - `subst` → `substitution` with `player_id = player` and `player_in_id = assist` (see Risks).
  - `Var` is skipped.
  - Key: `f"{elapsed}-{extra}-{type}-{detail}-{team.id}-{player.id}"`.
- Stats: percent strings are stripped (`"55%"` → 55.0). `provided` lists the stats present and not null, plus `"goals"`. `goals` comes from `goals.home` / `goals.away`.
- `PST`, `CANC` and `ABD` in `snapshot_from` raise `SourceFailure("API-Football says this match is postponed or cancelled ({short}).")`.
- Requests:
  - Every request first calls `budget.take()`, sends only the header `x-apisports-key`, then calls `budget.sync(...)` from the response headers.
  - A non-empty `errors` (a dict, or a list of dicts) raises `SourceFailure(f"API-Football refused the request: {their text} {hint}")`. A `requests` error also sets `retry_after` to the time until midnight UTC.
  - HTTP 401/403 → token hint. 429 → rateLimit hint with `retry_after=60`. 5xx or network failure → `"API-Football could not be reached. Kickstream will keep trying."`.
  - The key is never part of any message.

- [ ] **Step 1: Failing tests**

```python
def test_a_live_fixture_becomes_a_snapshot_with_line_ups_and_colours():
    snap = snapshot_from(load("fixture-1.json"))
    assert (snap.state, snap.minute, snap.score_home, snap.score_away) == ("live", 12, 0, 0)
    assert snap.home.formation == "4-3-3" and sum(p.starting for p in snap.home.players) == 11
    assert snap.home.players[0].grid == "1:1" and snap.home.color.startswith("#")

def test_goals_cards_and_substitutions_are_key_events_with_stable_keys():
    first, later = snapshot_from(load("fixture-2.json")), snapshot_from(load("fixture-4.json"))
    assert {e.key for e in first.events} <= {e.key for e in later.events}
    assert [e.type for e in later.events].count("red_card") == 1  # the second yellow

def test_statistics_say_what_was_measured():
    snap = snapshot_from(load("fixture-1.json"))
    home, _ = snap.stats
    assert home.possession == 55.0 and "possession" in snap.provided and "xg" not in snap.provided

@pytest.mark.parametrize("name, hint", [("errors-plan.json", "free plan"), ("errors-token.json", "KICKSTREAM_API_FOOTBALL_KEY"),
                                        ("errors-requests.json", "midnight UTC")])
async def test_api_footballs_own_errors_are_shown_with_what_to_do(tmp_path, name, hint): ...

async def test_every_request_is_counted_and_the_counter_follows_the_api(tmp_path):
    budget = DailyBudget(JsonRecordStore(tmp_path / "budget.json"), now=lambda: NOON)
    source = ApiFootball("k", budget, get=Recorded("fixture-1.json", headers={"x-ratelimit-requests-remaining": "90"}))
    await source.snapshot("1035")
    assert budget.used() == 10

async def test_a_spent_budget_refuses_before_asking_and_says_when_it_resets(tmp_path): ...
def test_the_budget_resets_at_midnight_utc(tmp_path): ...
async def test_the_days_fixture_list_is_reused_for_ten_minutes(tmp_path): ...

async def test_the_key_is_sent_only_as_its_header_and_never_shown(tmp_path):
    seen = Recorded("errors-token.json")
    with pytest.raises(SourceFailure) as caught:
        await ApiFootball("secret-key-123", budget(tmp_path), get=seen).fixtures(date(2026, 10, 14))
    assert seen.headers == [{"x-apisports-key": "secret-key-123"}]
    assert "secret-key-123" not in str(caught.value) and "secret-key-123" not in repr(ApiFootball("secret-key-123", budget(tmp_path)))

def test_without_a_key_it_says_how_to_get_one(): ...
```

- [ ] **Step 2: Run, expect fail:** `uv run pytest tests/test_api_football.py -q`
- [ ] **Step 3: Implement.** Store the key in a private attribute, and define `__repr__` without it.
- [ ] **Step 4: Full suite**
- [ ] **Step 5: Commit**

```bash
git add services/pipeline/kickstream/adapters/api_football.py services/pipeline/tests/fixtures/api_football services/pipeline/tests/test_api_football.py
git commit -m "Follow API-Football fixtures within the free plan's daily request budget"
```

---

### Task 9: OpenLigaDB adapter

**Files:**
- Create: `kickstream/adapters/openligadb.py`
- Create: `tests/fixtures/openligadb/`:
  - `getmatchdata-bl1.json`: a real `/getmatchdata/bl1` response trimmed to three matches. Keep match 83194, TSG Hoffenheim 2–3 Hamburger SV, five goals including an own goal.
  - `match-83194.json`: the real `/getmatchdata/83194`.
  - `match-live-1.json`, `match-live-2.json`: copies of 83194 edited to `matchIsFinished: false` with the first one and first three goals, and no `After90Minutes` result.
- Create: `tests/test_openligadb.py`

Get the real files once with `Invoke-WebRequest https://api.openligadb.de/getmatchdata/bl1` and `.../getmatchdata/83194`. This is the implementer's network use only.

**Interfaces:**

```python
OPENLIGADB = "https://api.openligadb.de"
HALF_TIME_FROM, SECOND_HALF_FROM = 47, 62  # minutes after kick-off; OpenLigaDB gives no live clock

def estimated_minute(kickoff_at: float, now: float) -> int:
    """0 before kick-off; the elapsed minutes in the first half; 45 in the break; then 45 + minutes since the restart."""

def snapshot_from(match: dict, now: float) -> LiveSnapshot
def fixture_from(match: dict, now: float) -> Fixture

class OpenLigaDb:
    id = "openligadb"
    name = "OpenLigaDB"
    credit = "Data: OpenLigaDB"
    available = True
    setup = None
    poll = PollPlan(pre_match_s=300, soon_s=120, live_s=60, half_time_s=180)

    def __init__(self, leagues: tuple[str, ...] = ("pl", "la1", "ucl"), base_url: str = OPENLIGADB,
                 get: Get = http_get, now: Callable[[], float] = time.time) -> None
    async def fixtures(self, day: date) -> list[Fixture]   # /getmatchdata/{league} (the current matchday) per league,
                                                            # kept when the kick-off's local date is `day`
    async def snapshot(self, ref: str) -> LiveSnapshot      # /getmatchdata/{ref}; ref must be digits
    def budget(self) -> None
```

Parsing rules:
- Teams are `ol-{teamId}`, named by `teamName`. `short_name` is the source's `shortName` when it has at most 4 letters, otherwise `short_name(teamName)`. Colours come from `team_colors(None, None)`.
- Players are the goal scorers. Ids are `ol-{goalGetterID}`, number 0, position MF. Names are tidied: strip whitespace, and `"Poulsen, Yussuf"` becomes `"Yussuf Poulsen"`.
- Each goal's side comes from which of `scoreTeam1` / `scoreTeam2` went up since the previous goal, never from `scoringTeamId`. Its key is `goal-{goalID}` and its minute is `matchMinute`.
- State:
  - `matchIsFinished` → `finished`.
  - Before kick-off → `pre_match`.
  - Else `half_time` when a `HalfTime` result exists, the estimated elapsed time is between `HALF_TIME_FROM` and `SECOND_HALF_FROM`, and no goal is later than minute 45.
  - Else `live`.
- `minute` is `max(estimated_minute, latest goal minute)`. The score is the latest goal's score, or the final result when finished.
- `stats=None` and `provided=()`. The competition is `leagueName`.

- [ ] **Step 1: Failing tests**

```python
def test_a_finished_match_has_both_teams_the_final_score_and_every_scorer():
    snap = snapshot_from(load("match-83194.json"), now=AFTER)
    assert (snap.home.name, snap.away.name, snap.score_home, snap.score_away, snap.state) == ("TSG Hoffenheim", "Hamburger SV", 2, 3, "finished")
    assert snap.away.short_name == "HSV" and "Yussuf Poulsen" in {p.name for p in snap.away.players}

def test_each_goal_is_given_to_the_side_whose_score_went_up():
    sides = [e.team for e in snapshot_from(load("match-83194.json"), now=AFTER).events]
    assert sides == ["away", "home", "home", "away", "away"]

@pytest.mark.parametrize("minutes, state, minute", [(-10, "pre_match", 0), (20, "live", 20), (50, "half_time", 45), (80, "live", 63)])
def test_the_state_and_minute_are_estimated_from_the_kick_off(minutes, state, minute): ...  # match-live-1.json, now = kickoff + minutes

async def test_fixtures_are_the_days_matches_across_the_chosen_leagues(): ...
async def test_a_failure_says_openligadb_could_not_be_reached(): ...
```

- [ ] **Step 2: Run, expect fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Full suite**
- [ ] **Step 5: Commit**

```bash
git add services/pipeline/kickstream/adapters/openligadb.py services/pipeline/tests/fixtures/openligadb services/pipeline/tests/test_openligadb.py
git commit -m "Follow live German league scores and scorers from OpenLigaDB"
```

---

### Task 10: The live stage: snapshot rules and the polling runner

**Files:**
- Create: `kickstream/live/__init__.py`, `kickstream/live/rules.py`, `kickstream/live/runner.py`
- Create: `tests/test_live_rules.py`, `tests/test_live_runner.py`
- Modify: `tests/test_architecture.py` (`STAGES` += `"live"`)

**Interfaces:**

```python
# live/rules.py
@dataclass
class LiveState:
    match_id: str
    source: str
    credit: str
    seq: int = 0
    seen: set[str] = field(default_factory=set)
    state: str | None = None           # last published MatchStatus.state
    status: MatchStatus | None = None
    stats: tuple | None = None         # last published (home, away, provided)
    snapshots: int = 0

def advance(state: LiveState, snap: LiveSnapshot) -> list[MatchEvent | MatchStatus | StatsSnapshot]:
    """What to publish for this snapshot, in order: new events, then the status if anything changed, then stats."""
```

Rules (each one is a test):
1. The first snapshot always publishes a `MatchStatus` with `source`, `detail="key_events"`, `credit`, `competition`, `speed=1.0`, the snapshot's state, minute, score and teams.
2. Moving from `pre_match` (or nothing) to `live` publishes `kickoff` (team None, unlocated). Moving from `half_time` to `live` publishes `kickoff` at minute 45. Reaching `half_time` publishes `half_time` at minute 45. Reaching `finished` publishes `full_time` at the snapshot's minute.
3. Each `LiveEvent` whose key is new becomes a `MatchEvent` in minute order: `id=f"{match_id}-e{seq}"`, `second=0`, `x=y=50`, `located=False`, `xg=None`. A source goal publishes only `goal`; there is no unlocated shot before it. An event that disappears in a later snapshot (a VAR correction) is not retracted; the status score follows the source.
4. The status is published only when the state, minute, score or teams changed. A goal publishes the event before the status, as the simulator does.
5. `StatsSnapshot` (`id=f"{match_id}-ls{n}"`, `momentum=0`) is published when the source's stats or `provided` changed, and at `half_time` / `finished` with `period_end` set.
   - With `snap.stats` None (OpenLigaDB), goals come from the score and cards from the published events, the other fields are 0, and `provided=["goals", "yellow_cards", "red_cards"]`.
   - With source stats, `provided` is the snapshot's own.

```python
# live/runner.py
class LiveMatch:
    """Follows one live fixture: polls its source, publishes what changed, and stops at full time."""
    def __init__(self, bus: EventBus, source: LiveSource, ref: str, match_id: str, first: LiveSnapshot, *,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep, now: Callable[[], float] = time.time,
                 poll_s: float | None = None, max_backoff_s: float = 300.0) -> None
    status: MatchStatus | None
    problem: str | None               # the source's last failure message, cleared by the next success
    async def run(self) -> None
```

Run loop:
- Publish `advance(first)`. Until the state is `finished`:
  - Sleep the plan's interval: `pre_match_s`, or `soon_s` within 15 minutes of `kickoff_at`, `live_s`, or `half_time_s`. `poll_s` overrides all four in tests and e2e.
  - Then call `snapshot(ref)`.
- On a `SourceFailure`, keep the last state and set `problem`. Sleep `exc.retry_after` when set (a spent budget waits for midnight UTC). Otherwise back off: `min(max_backoff_s, interval * 2 ** failures)`.
- Every publish goes to `STATUS`, `EVENTS` or `INSIGHTS` by payload type.

- [ ] **Step 1: Failing tests**

```python
# tests/test_live_rules.py — snapshots built with a small helper live(state, minute, score, events=())
def test_the_first_snapshot_announces_a_key_events_match_with_its_credit(): ...
def test_kick_off_half_time_second_half_and_full_time_become_events(): ...
def test_a_new_goal_is_published_once_and_before_the_new_score():
    state = LiveState("m-1", "api_football", "Data: API-Football")
    advance(state, live("live", 10, (0, 0)))
    out = advance(state, live("live", 23, (1, 0), events=[goal("k1", 23, "home", "af-7")]))
    assert [type(o).__name__ for o in out] == ["MatchEvent", "MatchStatus"]
    assert out[0].type == "goal" and out[0].located is False and out[1].score_home == 1
    assert advance(state, live("live", 24, (1, 0), events=[goal("k1", 23, "home", "af-7")]))[0].type == "MatchStatus"  # minute only
def test_nothing_is_published_when_nothing_changed(): ...
def test_stats_come_from_the_source_or_from_the_score_and_cards(): ...
def test_a_snapshot_already_in_the_second_half_starts_with_one_kickoff(): ...

# tests/test_live_runner.py — FakeLiveSource returns scripted snapshots or raises; sleep records its arguments
async def test_it_polls_on_the_sources_schedule_and_stops_at_full_time(): ...
async def test_failures_back_off_and_the_last_state_is_kept():
    # snapshots: live, fail, fail, live, finished -> sleeps [90, 180, 360 capped..., 90] and problem cleared after success
async def test_a_spent_budget_waits_until_it_resets():
    # SourceFailure(retry_after=3600) -> next sleep is 3600 and problem says so
async def test_poll_s_overrides_the_schedule(): ...
```

- [ ] **Step 2: Run, expect fail:** `uv run pytest tests/test_live_rules.py tests/test_live_runner.py tests/test_architecture.py -q`
- [ ] **Step 3: Implement.** `live` imports only `contracts`, `domain`, `ports` and itself.
- [ ] **Step 4: Full suite**
- [ ] **Step 5: Commit**

```bash
git add services/pipeline/kickstream/live services/pipeline/tests/test_live_rules.py services/pipeline/tests/test_live_runner.py services/pipeline/tests/test_architecture.py
git commit -m "Turn polled live scores into match events, statuses and stats, with backoff and a budget wait"
```

---

### Task 11: Live matches in the controller

**Files:**
- Modify: `kickstream/control.py`
- Modify: `tests/test_control.py`

**Interfaces:**
- `start(source in live)`:
  - When the source is missing or not `available`, raise `SourceUnavailable(source.setup or ...)`.
  - Under the lock, await `source.snapshot(ref)` before cancelling anything. A `SourceFailure` re-raises and changes nothing.
  - Then cancel the running match. Create `LiveMatch(bus, source, ref, match_id, first)` through the injected `live_match` factory (the default builds a `LiveMatch` with `poll_s` from the constructor argument `live_poll_s: float | None = None`) and run it as the task.
  - Announce the abandoned match as today.
- `_cancel_running()` handles either a `Simulator` or a `LiveMatch`: both expose `.status`.
- `teams` and `running()` read the live match's latest status. `running().problem` is the runner's `problem`.
- `stop()` also stops a live match and announces it abandoned when it is not finished.
- `speed` is ignored for live sources; the status says `speed=1.0`.

- [ ] **Step 1: Failing tests**

```python
async def test_a_live_match_is_followed_until_full_time(): ...          # FakeLiveSource: pre_match, live, finished; poll_s=0
async def test_a_refused_fixture_changes_nothing():
    # running simulated match; FakeLiveSource.snapshot raises SourceFailure("API-Football refused ...") -> raised,
    # current unchanged, no abandoned status, next start gets m-2
async def test_a_live_source_without_its_key_is_unavailable_and_says_how_to_fix_it(): ...
async def test_replacing_a_live_match_announces_it_abandoned(): ...
async def test_running_reports_the_live_sources_problem(): ...
```

- [ ] **Step 2: Run, expect fail:** `uv run pytest tests/test_control.py -q`
- [ ] **Step 3: Implement**
- [ ] **Step 4: Full suite**
- [ ] **Step 5: Commit**

```bash
git add services/pipeline/kickstream/control.py services/pipeline/tests/test_control.py
git commit -m "Start and stop live matches from any live source in the match controller"
```

---

### Task 12: Settings, wiring and routes

**Files:**
- Modify: `kickstream/app.py`, `kickstream/gateway/api.py`
- Create: `kickstream/sources/__init__.py`, `kickstream/sources/api.py`
- Create: `tests/conftest.py`, `tests/test_sources_api.py`
- Modify: `tests/test_api.py`, `tests/test_architecture.py` (`STAGES` += `"sources"`)

**Interfaces:**

```python
# app.py Settings (new fields last, all defaulted, so Settings(None, None, None, ...) in tests keeps working)
api_football_key: str | None = field(default=None, repr=False)
statsbomb_url: str = "https://raw.githubusercontent.com/hudl/open-data/master/data/"
api_football_url: str = "https://v3.football.api-sports.io"
openligadb_url: str = "https://api.openligadb.de"
openligadb_leagues: tuple[str, ...] = ("pl", "la1", "ucl")
live_poll_s: float | None = None  # tests only: poll every N seconds instead of the source's schedule

# from_env: KICKSTREAM_API_FOOTBALL_KEY, KICKSTREAM_STATSBOMB_URL, KICKSTREAM_API_FOOTBALL_URL,
# KICKSTREAM_OPENLIGADB_URL, KICKSTREAM_OPENLIGADB_LEAGUES (comma-separated), KICKSTREAM_LIVE_POLL_S.
# An empty value means the default (`env.get(...) or DEFAULT`), as the other settings do.
```

The key is read through the existing `Settings.from_env(environment(Path(".env"), os.environ))` path in `create_app`. Nothing new reads `.env`.

- `build_pipeline` and `create_app` gain `replays: Mapping[str, ReplaySource] | None = None` and `live: Mapping[str, LiveSource] | None = None`, as `feeds=` works today.
- `_replays(settings)` returns `{"statsbomb": StatsBombOpenData(settings.data_dir / "statsbomb", settings.statsbomb_url)}`.
- `_live(settings)` returns `{"api_football": ApiFootball(settings.api_football_key, DailyBudget(JsonRecordStore(settings.data_dir / "api-football-budget.json")), settings.api_football_url), "openligadb": OpenLigaDb(settings.openligadb_leagues, settings.openligadb_url)}`.
- `MatchController(bus, clock_factory, HOME, AWAY, prefix=…, replays=…, live=…, live_poll_s=settings.live_poll_s)`.

```python
# gateway/api.py
SOURCES = ("simulated", "statsbomb", "api_football", "openligadb")

class StartMatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    source: Literal["simulated", "statsbomb", "api_football", "openligadb"] = "simulated"
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)
    ref: str | None = Field(default=None, pattern=r"^\d{1,10}(/\d{1,10}){0,2}$")
    speed: float = Field(default=30.0, ge=1.0, le=MAX_SPEED)

    @model_validator(mode="after")
    def _fits_the_source(self) -> "StartMatch":
        # simulated: no ref. statsbomb: ref "c/s/m" and no seed. live: ref one number and no seed.

class StartRefusal(Refusal):
    """A match could not be started from its source. 409 when unavailable as configured, 502 when the source failed."""

def build_router(*, store, broadcaster, teams: Callable[[], tuple[TeamSheet, TeamSheet]],
                 start_match: Callable[..., Awaitable[str]], stop_match: Callable[[], Awaitable[None]],
                 current_match, match_exists, socket_hosts=()) -> APIRouter
# GET  /api/teams          -> {"home": teams()[0], "away": teams()[1]}
# POST /api/matches        -> 201 {"match_id"}; start_match(seed=request.seed if not None else DEMO_SEED, speed=..., source=..., ref=...)
#                             SourceUnavailable -> StartRefusal(409, "source", msg); SourceFailure -> StartRefusal(502, "source", msg)
# POST /api/matches/stop   -> 204; stops and announces the running match abandoned
```

```python
# sources/api.py
class SourceRefusal(Refusal): ...

def build_sources_router(*, replays: Mapping[str, ReplaySource], live: Mapping[str, LiveSource],
                         running: Callable[[], RunningMatch | None], today: Callable[[], date] = date.today) -> APIRouter
# GET /api/sources                                                        -> Sources
#     simulated (always available, detail full, no credit); statsbomb (replay, full, "Data: StatsBomb");
#     api_football / openligadb (live, key_events, available, setup, budget_used / budget_limit from budget())
# GET /api/sources/statsbomb/competitions                                 -> list[Competition]
# GET /api/sources/statsbomb/competitions/{competition_id}/{season_id}/matches -> list[MatchListing]  (ints in the path)
# GET /api/sources/{source}/fixtures?date=YYYY-MM-DD                      -> list[Fixture] (default today)
#     404 unknown source; SourceUnavailable -> 409; SourceFailure -> 502, the source's message as `msg`
```

`tests/conftest.py`:

```python
import urllib.request
import pytest

@pytest.fixture(autouse=True)
def no_internet(monkeypatch, request):
    """The default suite never reaches the internet; adapters are tested with recorded responses."""
    if request.node.get_closest_marker("network"):
        return
    def refuse(*args, **kwargs):
        raise AssertionError("a test tried to use the internet")
    monkeypatch.setattr(urllib.request, "urlopen", refuse)
```

Register the `network` marker in `pyproject.toml` `[tool.pytest.ini_options] markers`.

- [ ] **Step 1: Failing tests**

```python
# tests/test_api.py (existing tests keep passing; add)
@pytest.mark.parametrize("body", [
    {"source": "statsbomb"}, {"source": "statsbomb", "ref": "8658"}, {"source": "statsbomb", "ref": "43/3/8658", "seed": 1},
    {"source": "simulated", "ref": "1"}, {"source": "api_football", "ref": "1/2"}, {"source": "sportapi", "ref": "1"},
], ids=str)
def test_a_start_that_does_not_fit_its_source_is_rejected_and_starts_nothing(client, body): ...

def test_teams_are_the_current_matchs(client_with_sources):
    client_with_sources.post("/api/matches", json={"source": "statsbomb", "ref": "43/3/8658", "speed": 600})
    assert client_with_sources.get("/api/teams").json()["home"]["name"] == "France"

def test_stop_ends_the_running_match(client): ...

# tests/test_sources_api.py: create_app(settings, clock_factory=InstantClock, replays={statsbomb over fixtures},
#   live={"api_football": ApiFootball("e2e", budget, get=Recorded(...)), "openligadb": OpenLigaDb(get=Recorded(...))})
def test_sources_list_all_four_and_say_what_a_missing_key_needs(client_without_key):
    body = client_without_key.get("/api/sources").json()
    football = next(s for s in body["sources"] if s["id"] == "api_football")
    assert football["available"] is False and "KICKSTREAM_API_FOOTBALL_KEY" in football["setup"]
def test_browsing_statsbomb_gives_competitions_then_matches_without_scores(client): ...
def test_live_fixtures_for_a_day(client): ...
def test_a_source_failure_is_a_502_with_the_sources_message(client): ...

async def test_a_statsbomb_replay_runs_through_the_whole_pipeline(client):
    match_id = client.post("/api/matches", json={"source": "statsbomb", "ref": "43/3/8658", "speed": 600}).json()["match_id"]
    # wait for the full-time recap card as _latest_overlays does in test_api.py, then:
    stream = read_stream(client, match_id)        # SSE envelopes
    status = last(stream, "match_status")
    assert (status["home"]["name"], status["score_home"], status["score_away"], status["credit"]) == ("France", 4, 2, "Data: StatsBomb")
    assert any(e["type"] == "narrative" and "France" in e["payload"]["text"] for e in stream)
    assert any(e["type"] == "pitch_scene" for e in stream)
    answer = client.post("/api/copilot/ask", json={"question": "What is the score?"}).json()
    assert "France" in answer["answer"]

def test_an_api_football_live_match_runs_to_full_time_without_position_data(client_live): ...
    # live_poll_s=0.01, Recorded sequence fixture-1..4: final status 2-1 finished, detail key_events,
    # no pressure snapshot or pitch_scene envelopes, stats envelope has provided
```

- [ ] **Step 2: Run, expect fail:** `uv run pytest tests/test_api.py tests/test_sources_api.py tests/test_architecture.py -q`
- [ ] **Step 3: Implement**
- [ ] **Step 4: Full suite.** The no-internet guard must not break any existing test: `uv run pytest -q && uv run ruff check .`
- [ ] **Step 5: Commit**

```bash
git add services/pipeline/kickstream/app.py services/pipeline/kickstream/gateway/api.py services/pipeline/kickstream/sources services/pipeline/tests/conftest.py services/pipeline/tests/test_sources_api.py services/pipeline/tests/test_api.py services/pipeline/tests/test_architecture.py services/pipeline/pyproject.toml
git commit -m "Offer StatsBomb, API-Football and OpenLigaDB matches through the API and start them by source"
```

---

### Task 13: Web data layer for sources

**Files:**
- Create: `apps/web/src/matches/api.ts`, `apps/web/src/matches/api.test.ts`
- Create: `apps/web/src/matches/liveData.ts`, `apps/web/src/matches/liveData.test.ts`
- Modify: `apps/web/src/i18n.ts`

**Interfaces:**

```ts
// matches/api.ts — uses `send` from ../studio/api so refusals carry the server's message
export type SourceId = SourceInfo["id"];
export interface StartRequest { source: SourceId; ref?: string; speed: number }
export const SPEEDS = [1, 2, 5, 10, 30] as const;           // "Real time", "2×", …
export const fetchSources = () => send<Sources>("GET", "/api/sources");
export const fetchCompetitions = () => send<Competition[]>("GET", "/api/sources/statsbomb/competitions");
export const fetchReplayMatches = (competitionId: number, seasonId: number) =>
  send<MatchListing[]>("GET", `/api/sources/statsbomb/competitions/${competitionId}/${seasonId}/matches`);
export const fetchFixtures = (source: "api_football" | "openligadb", day: string) =>
  send<Fixture[]>("GET", `/api/sources/${source}/fixtures?date=${day}`);
export const startMatchFrom = async (request: StartRequest) =>
  (await send<{ match_id: string }>("POST", "/api/matches", request)).match_id;
export const stopMatch = () => send<void>("POST", "/api/matches/stop");   // 204: make `send` tolerate an empty body
export function localDay(at = new Date()): string                         // "YYYY-MM-DD" in the browser's time zone
export function speedLabel(speed: number): string                         // 1 -> "Real time", 30 -> "30×"
```

```ts
// matches/liveData.ts
export const isKeyEvents = (status: MatchStatus | null | undefined) => status?.detail === "key_events";
/** Elements that draw positions, pressure or momentum, which a live feed does not give. */
export function needsPositions(element: Pick<SceneElement, "type" | "props">): boolean
// true for: pitch, pitch3d, replay; graph with metric momentum or xg (or no metric: momentum is the default);
// prediction with view next_action; chart with metric tactics
export function limitedByLiveData(element: Pick<SceneElement, "type" | "props">, status: MatchStatus | null | undefined): boolean
```

i18n keys (en / es / hi): `liveDataOnly` ("Not available with live data"), `preMatch` ("Before kick-off"), `chooseMatch` ("Choose match").

- [ ] **Step 1: Failing tests**

```ts
test("a pitch, a 3D pitch and a momentum graph need positions; a scoreboard does not", () => {
  expect(needsPositions(element({ type: "pitch" }))).toBe(true);
  expect(needsPositions(element({ type: "graph", props: { metric: "win_probability" } }))).toBe(false);
  expect(needsPositions(element({ type: "graph", props: {} }))).toBe(true);
  expect(needsPositions(element({ type: "scoreboard" }))).toBe(false);
});
test("only key-events matches are limited", () => {
  expect(limitedByLiveData(element({ type: "pitch" }), status({ detail: "full" }))).toBe(false);
  expect(limitedByLiveData(element({ type: "pitch" }), status({ detail: "key_events" }))).toBe(true);
});
test("startMatchFrom posts the source, ref and speed and reports the server's refusal", async () => {
  // stub fetch: 502 {detail:[{loc:["body","source"], msg:"API-Football refused the request: … Check KICKSTREAM_API_FOOTBALL_KEY …"}]}
  await expect(startMatchFrom({ source: "api_football", ref: "1", speed: 1 })).rejects.toThrow("Check KICKSTREAM_API_FOOTBALL_KEY");
});
test("localDay is the browser's date", () => expect(localDay(new Date(2026, 9, 14, 23, 30))).toBe("2026-10-14"));
```

- [ ] **Step 2: Run, expect fail:** `pnpm exec vitest run src/matches src/i18n.test.ts`
- [ ] **Step 3: Implement**
- [ ] **Step 4:** `pnpm exec vitest run && pnpm exec tsc -b`
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/matches apps/web/src/i18n.ts apps/web/src/studio/api.ts
git commit -m "Add the web client for match sources and the rule for what live data cannot show"
```

---

### Task 14: The program says what live data cannot show, and credits the data

**Files:**
- Modify: `apps/web/src/studio/elements.tsx`, `widgets.tsx`, `SceneCanvas.tsx` (+ `elements.test.tsx`, `widgets.test.tsx`, `SceneCanvas.test.tsx`, `ProgramPage.test.tsx`)
- Modify: `services/pipeline/kickstream/studio/templates.py`, `services/pipeline/tests/test_studio_rules.py` (add: the Starting soon title is `"{home} vs {away}"`)

**Interfaces:**
- `elements.tsx` `ElementView`: first, `if (limitedByLiveData(element, match.status)) return <LiveDataOnly language={language} />`. This is a `Panel` with centred muted text and `data-testid="live-data-only"`. It applies to widgets too, so `WidgetView` needs no change of its own.
- `Scoreboard` (elements) and `ScorecardView` (widgets) show `t(language, "preMatch")` instead of the minute when `status.state === "pre_match"`.
- The `text` element replaces `{home}` and `{away}` with `match.status?.home.name` / `away.name`. With no match status it renders an empty string for a text that contains a placeholder, so the fictional names never reappear.
- `SceneCanvas` draws the credit above every element when `data.match.status?.credit`: bottom-right of the 1920 × 1080 canvas (right 24, bottom 16), font 22, white at 0.8 opacity on a dark pill, `data-testid="program-credit"`, not selectable or editable. The program page and the studio stage both use `SceneCanvas`, so both show it.
- `templates.py` `STARTING_SOON` title: `_title(3, "{home} vs {away}", 700, 56)`. Studios saved before keep their old literal text (saved data keeps loading).

- [ ] **Step 1: Failing tests**

```tsx
test("on a key-events match the pitch and 3D pitch say they are not available, the scoreboard still shows", () => {
  renderElement(element({ type: "pitch3d" }), data({ status: status({ detail: "key_events" }) }));
  expect(screen.getByTestId("live-data-only")).toHaveTextContent("Not available with live data");
});
test("the credit is drawn in the corner while a sourced match plays", () => {
  renderCanvas(scene(), data({ status: status({ credit: "Data: StatsBomb" }) }));
  expect(screen.getByTestId("program-credit")).toHaveTextContent("Data: StatsBomb");
});
test("no credit for the simulated match", () => { /* credit null → no program-credit */ });
test("before kick-off the scoreboard says so", () => { /* state pre_match → "Before kick-off" */ });
test("a title can name the playing teams", () => { /* text "{home} vs {away}" → "France vs Croatia" */ });
```

- [ ] **Step 2: Run, expect fail:** `pnpm exec vitest run src/studio`
- [ ] **Step 3: Implement; run** `uv run pytest -q` too (the template text changed)
- [ ] **Step 4:** `pnpm exec vitest run && pnpm exec tsc -b`
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/studio/elements.tsx apps/web/src/studio/widgets.tsx apps/web/src/studio/SceneCanvas.tsx apps/web/src/studio/elements.test.tsx apps/web/src/studio/widgets.test.tsx apps/web/src/studio/SceneCanvas.test.tsx apps/web/src/studio/ProgramPage.test.tsx services/pipeline/kickstream/studio/templates.py services/pipeline/tests/test_studio_rules.py
git commit -m "Credit the match data on the program and say plainly what a live feed cannot show"
```

---

### Task 15: The Match tool in the studio rail

**Files:**
- Create: `apps/web/src/matches/MatchPicker.tsx`, `apps/web/src/matches/MatchPicker.test.tsx`
- Create: `apps/web/src/studio/tools/MatchTool.tsx`
- Modify: `apps/web/src/studio/ToolRail.tsx`, `StudioPage.tsx`, `ToolRail.test.tsx`, `StudioPage.test.tsx`, `tools/tools.test.tsx`

**Interfaces:**

```tsx
interface MatchPickerProps {
  /** Called with the new match's id once the server has started it. */
  onStarted(matchId: string): void;
  /** Speed offered first; `speedFromLocation(window.location.search)` adds e.g. 600× for the e2e run. */
  extraSpeed?: number;
}
export function MatchPicker(props: MatchPickerProps)
```

- **Source** (`RadioGroup`, label "Source"): "Simulated match", "StatsBomb replay", "API-Football live", "OpenLigaDB live". An unavailable source is disabled, with its `setup` text under it (e.g. how to set the API-Football key). The API-Football option shows "{used} of {limit} requests used today".
- **Simulated:** Speed, and Start match (posts `{source: "simulated", speed}`).
- **StatsBomb:**
  - `Select` "Competition", one option per competition-season, e.g. "FIFA World Cup · 2018".
  - Then a list of matches as buttons with `aria-label` `"{home} vs {away}"`. Each shows date and stage and **no score**; the chosen one is pressed.
  - `Select` "Speed": Real time, 2×, 5×, 10×, 30×, and `extraSpeed` when given. Real time is the default.
  - Start match.
- **Live sources:**
  - Today's fixtures (`localDay()`), a `Select` "Competition" filter ("All competitions" plus each fixture competition), and a Refresh button.
  - Each fixture is a button `"{home} vs {away}"` with a state badge (Not started HH:MM / Live 34' / Half-time / Full time / Postponed) and the live score.
  - Postponed fixtures are disabled. Start match.
- Loading states say "Loading competitions…" etc. Every failure shows a `MessageBar` (intent error) with the server's message, which says what to do. Nothing else is cleared.

```tsx
// studio/tools/MatchTool.tsx
export function MatchTool({ onStarted }: { onStarted(matchId: string): void })
```

- Polls `fetchSources()` every 10 s while mounted, for `running`.
- A "Now playing" box shows the running match's title and source, with **Stop match** (`stopMatch()`) and the source's `problem` as a warning MessageBar (e.g. "API-Football could not be reached. Kickstream will keep trying.").
- Below it, `<MatchPicker extraSpeed={speedFromLocation-derived} onStarted={onStarted} />`.
- `ToolRail`: `TOOLS = ["Match", "Banners", "Comments", "Guests", "Replays", "Timer", "Stream", "Settings"]`. The icon is `SportSoccerRegular` (present in `@fluentui/react-icons`).
- `StudioPage`: `case "Match": return <MatchTool onStarted={() => setProblem(null)} />`. `useCurrentMatch` moves to the new match by itself when the old one is announced abandoned or finished; no extra wiring.

- [ ] **Step 1: Failing tests (stub `fetch` per URL)**

```tsx
test("StatsBomb: choose a competition, then a match whose score is hidden, then start at the chosen speed", async () => {
  // sources: statsbomb available; competitions: [{43,3,"FIFA World Cup","2018","International"}];
  // matches: [{ref:"43/3/8658", home:"France", away:"Croatia", date:"2018-07-15", stage:"Final"}]
  // pick "StatsBomb replay" → select "FIFA World Cup · 2018" → button "France vs Croatia" → Speed "10×" → Start match
  // expect POST /api/matches body {source:"statsbomb", ref:"43/3/8658", speed:10} and onStarted("m-2")
  // expect no element text matching /\b4\s*[-–]\s*2\b/
});
test("an unavailable source is disabled and says how to make it available", async () => { /* setup text visible */ });
test("live fixtures show their state and can be filtered by competition", async () => { … });
test("a refusal is shown with the server's message and the choice is kept", async () => { … });
test("the Match tool shows the running match, its problem, and stops it", async () => { … });
test("the rail offers Match first", () => { … });
```

- [ ] **Step 2: Run, expect fail:** `pnpm exec vitest run src/matches src/studio`
- [ ] **Step 3: Implement**
- [ ] **Step 4:** `pnpm exec vitest run && pnpm exec tsc -b`
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/matches/MatchPicker.tsx apps/web/src/matches/MatchPicker.test.tsx apps/web/src/studio/tools/MatchTool.tsx apps/web/src/studio/ToolRail.tsx apps/web/src/studio/StudioPage.tsx apps/web/src/studio/ToolRail.test.tsx apps/web/src/studio/StudioPage.test.tsx apps/web/src/studio/tools/tools.test.tsx
git commit -m "Add the Match tool: pick a StatsBomb replay or a live match and start or stop it from the studio"
```

---

### Task 16: The match data page chooses real matches too

**Files:**
- Modify: `apps/web/src/components/Header.tsx`, `Header.test.tsx`
- Modify: `apps/web/src/App.tsx`, `App.test.tsx`
- Modify: `apps/web/src/agents/cards.tsx`, `apps/web/src/agents/AgentStudio.test.tsx`

**Interfaces:**
- `Header` gains `onChoose(): void`, a button `t(language, "chooseMatch")` beside Start / Restart match (the simulated quick start keeps its labels, so `smoke`, `agents` and `copilot` e2e are unchanged).
  - Under the scoreboard it shows `status.competition` and `status.credit` (small, muted) when present.
  - The minute badge shows `t(language, "preMatch")` for `pre_match`.
- `App`:
  - A `Dialog` titled "Choose a match" holds `<MatchPicker extraSpeed={speedFromLocation(window.location.search)} onStarted={(id) => { setMatchId(id); setChoosing(false); }} />`.
  - Teams for `PreferencesDrawer` are `data.status ? { home: data.status.home, away: data.status.away } : teams`.
  - The Pitch panel shows the `liveDataOnly` text and hides the pressure switch when `isKeyEvents(data.status)`.
- `agents/cards.tsx`: the Visualization card (3D pitch), the Tactical Analyst card and the Prediction card's danger heat grid show `liveDataOnly` for key-events matches. The Prediction outcome and next-goal meters stay.

- [ ] **Step 1: Failing tests**

```tsx
test("Choose match opens the picker and following the new match closes it", async () => { … });
test("the header names the competition and credits the data", () => { /* status({competition:"FIFA World Cup 2018", credit:"Data: StatsBomb"}) */ });
test("favourites are offered from the playing match's teams", async () => { /* status with France/Croatia → drawer lists France */ });
test("the pitch panel says live data has no positions", () => { … });
test("agent cards that need positions say so on a key-events match", () => { … });
```

- [ ] **Step 2: Run, expect fail:** `pnpm exec vitest run src/App.test.tsx src/components src/agents`
- [ ] **Step 3: Implement**
- [ ] **Step 4:** `pnpm exec vitest run && pnpm exec tsc -b`
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/Header.tsx apps/web/src/components/Header.test.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/agents/cards.tsx apps/web/src/agents/AgentStudio.test.tsx
git commit -m "Choose a real match on the match data page and follow its teams, competition and credit"
```

---

### Task 17: End-to-end with a local stand-in for the network

**Files:**
- Create: `apps/web/e2e/fake-sources.mjs`
- Create: `apps/web/e2e/sources.spec.ts`
- Modify: `apps/web/playwright.config.ts`, `apps/web/e2e/broadcasts.ts`

**Interfaces:**
- `fake-sources.mjs`: a `node:http` server on `127.0.0.1:8020` with no dependencies.
  - `GET /health` → 200.
  - `GET /statsbomb/<path>` → `services/pipeline/tests/fixtures/statsbomb/<path>`, path-checked to stay in that folder.
  - `GET /api-football/fixtures?date=D` → `fixtures-date.json` with every fixture's `date`/`timestamp` moved to D at the same time of day.
  - `GET /api-football/fixtures?id=N` → the next of `fixture-1..4.json` for that id, staying on the last. A missing or wrong `x-apisports-key` (anything but `e2e-fake-key`) → `errors-token.json`. Every answer carries `x-ratelimit-requests-remaining`.
  - `GET /openligadb/getmatchdata/bl1` → the recorded list, with kick-offs moved to today. `GET /openligadb/getmatchdata/N` → the next of `match-live-1`, `match-live-2`, `match-83194` with `matchDateTimeUTC` set so the estimated minutes come out right (live-1: kick-off 20 minutes ago).
  - `POST /__reset` resets the sequences. `POST /__mode` with `{"api_football": "token-error"}` serves errors for the next request.
- `playwright.config.ts`:
  - A third `webServer` `{ command: "node e2e/fake-sources.mjs", url: "http://127.0.0.1:8020/health" }`.
  - `TEST_SERVER` gains `KICKSTREAM_STATSBOMB_URL: "http://127.0.0.1:8020/statsbomb/"`, `KICKSTREAM_API_FOOTBALL_URL: "http://127.0.0.1:8020/api-football"`, `KICKSTREAM_API_FOOTBALL_KEY: "e2e-fake-key"`, `KICKSTREAM_OPENLIGADB_URL: "http://127.0.0.1:8020/openligadb"`, `KICKSTREAM_OPENLIGADB_LEAGUES: "bl1"`, `KICKSTREAM_LIVE_POLL_S: "1"`.
  - Export `FAKE_SOURCES = "http://127.0.0.1:8020"`. The StatsBomb cache lands in the run's own `DATA_DIR`.
- `e2e/broadcasts.ts` gains `openStudioAt(page, request, title, search)`. It calls `openStudio(...)` (the `/studio` redirect drops any query), then `page.goto(\`/broadcasts/${id}/studio${search}\`)`, and returns the id. The existing `openStudio` is unchanged.

`sources.spec.ts` (1536 × 864; `beforeEach` posts `/__reset`):
1. **A StatsBomb replay chosen in the studio plays to the program with the credit.**
   - `openStudioAt(page, request, title, "?speed=600")`, `openTool(page, "Match")`, check "StatsBomb replay", select "FIFA World Cup · 2018".
   - The "France vs Croatia" button is visible and the tool shows no "4" score text. Choose it, Speed "600×", Start match.
   - The Stage shows "France" and "Croatia". `/studio?output` in a second page shows `program-credit` "Data: StatsBomb", and the score reaches "4 - 2".
   - On the Analyst desk scene, a narration line names France.
   - `/match` shows France and Croatia in the header with the credit.
   - Ask Copilot ("What is the score?") answers naming France.
2. **An API-Football live match updates, and position elements say they are not available.**
   - Put a scene with a 3D pitch on air ("Match intelligence" from + Scene).
   - In the Match tool choose "API-Football live"; the fixture "Arsenal vs Chelsea" shows "Live 12'". Start match.
   - The program shows `live-data-only` in the 3D pitch and graph, and the score goes 0 - 0 → 1 - 0 → 2 - 1 as the fake advances, with the credit "Data: API-Football".
   - The Match tool shows "{n} of 100 requests used today".
3. **OpenLigaDB: scorers appear in the commentary.** Start the fixture; a narrative names "Yussuf Poulsen"; full time 2 - 3.
4. **A refused key is explained where it is chosen.** `/__mode` token-error, then choose API-Football → the error bar says "Check KICKSTREAM_API_FOOTBALL_KEY".
5. **The match data page's Choose match starts a replay.** `/match?speed=600` → Choose match → StatsBomb → France vs Croatia → Start → header "France", "Croatia".
6. **Stop match** in the Match tool ends the running match: the Match tool no longer shows "Now playing".

Also re-run `studio-layout.spec.ts`: the extra rail button must keep the rail, stage, backstage and scene strip in view at 1536 × 864.

- [ ] **Step 1: Write the fake server and the specs**
- [ ] **Step 2: Run:** `pnpm e2e --reporter=line`. The whole e2e suite must pass, and nothing may reach the internet. To check, run once with the network adapter disabled or watch the pipeline log for outgoing hosts.
- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/fake-sources.mjs apps/web/e2e/sources.spec.ts apps/web/e2e/broadcasts.ts apps/web/playwright.config.ts
git commit -m "Drive real match data end to end against a local stand-in for StatsBomb, API-Football and OpenLigaDB"
```

---

### Task 18: Opt-in network test

**Files:**
- Create: `apps/web/playwright.network.config.ts`, `apps/web/e2e-network/sources.spec.ts`
- Modify: `apps/web/package.json` (`"e2e:network": "playwright test --config playwright.network.config.ts"`)

**Interfaces:**
- The config follows `playwright.acs.config.ts`. It reads `KICKSTREAM_API_FOOTBALL_KEY` from `process.env` or the root `.env` with `parseEnv` and hands it to the servers through `process.env`, never through the config, which reporters may print. It sets `metadata: { apiFootball: key !== "" }`.
  - `webServer: webServers({ KICKSTREAM_STATSBOMB_URL: "", KICKSTREAM_API_FOOTBALL_URL: "", KICKSTREAM_OPENLIGADB_URL: "", KICKSTREAM_LIVE_POLL_S: "" })`, so the real services are used. The fake-sources server is not started.
  - `testDir: "e2e-network"`, `timeout: 300_000`.
- `e2e-network/sources.spec.ts`:
  1. Downloads StatsBomb competitions, finds FIFA World Cup 2018, starts 43/3/8658 at 600× through the API, and waits for full time 4–2.
  2. Lists today's OpenLigaDB fixtures (200, an array).
  3. Only when `metadata.apiFootball`: lists today's API-Football fixtures. A 502 whose message comes from API-Football's `errors` counts as a pass, with the message logged as an annotation, so a plan refusal is visible without failing.

- [ ] **Step 1: Write the config, the spec and the script**
- [ ] **Step 2: Run once by hand:** `pnpm e2e:network --reporter=line` (needs the internet; not part of the default suite)
- [ ] **Step 3: Commit**

```bash
git add apps/web/playwright.network.config.ts apps/web/e2e-network/sources.spec.ts apps/web/package.json
git commit -m "Add an opt-in network test against StatsBomb, OpenLigaDB and API-Football"
```

---

### Task 19: README and the final check

**Files:**
- Modify: `README.md` (new section **Real match data** after **Run it**, and the **Test it** list)

Content:
- What each source gives, in a table: name, kind, detail, key, limits, credit.
  - **StatsBomb Open Data**: past matches with every event and StatsBomb's own xG. No key. Downloaded on first use into `.data/statsbomb/`, so a replay plays offline afterwards. Credit "Data: StatsBomb".
  - **API-Football**: live fixtures worldwide. A free key gives 100 requests a day. Kickstream polls every 90 s while live, which is about 80 requests for one match. The free plan does not cover every season; when it refuses, the Match tool shows API-Football's own message.
  - **OpenLigaDB**: German leagues, live scores and scorers. No key. No live clock, so the minute is estimated.
- **Getting and setting the API-Football key:**
  1. Register at https://dashboard.api-football.com/register.
  2. Copy the key from the dashboard.
  3. Add `KICKSTREAM_API_FOOTBALL_KEY=<key>` to the `.env` file at the top of the project (git-ignored; never commit it).
  4. Restart the pipeline.
  The Match tool shows the day's request count. The counter is kept in `.data/api-football-budget.json` and resets at midnight UTC.
- How live data differs: the elements that show "Not available with live data", and why.
- Settings table: `KICKSTREAM_API_FOOTBALL_KEY`, `KICKSTREAM_OPENLIGADB_LEAGUES` (default `pl,la1,ucl`), and the test-only `KICKSTREAM_STATSBOMB_URL`, `KICKSTREAM_API_FOOTBALL_URL`, `KICKSTREAM_OPENLIGADB_URL`, `KICKSTREAM_LIVE_POLL_S`.
- Test it: `(cd apps/web && pnpm e2e:network)   # real StatsBomb and OpenLigaDB; API-Football only with KICKSTREAM_API_FOOTBALL_KEY in .env`.
- StatsBomb's terms: free for non-commercial use with attribution. Link the open-data repository's licence (LICENSE.pdf) and say the program credit is shown for that reason.

- [ ] **Step 1: Write the section**
- [ ] **Step 2: Verify everything**

```bash
# services/pipeline
uv run ruff check .
uv run pytest -q
# apps/web
pnpm exec tsc -b
pnpm exec vitest run
pnpm e2e --reporter=line
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document the free match data sources and how to set the API-Football key"
```

---

### Task 20: the countdown starts the chosen match

Decided by the user: when a studio countdown ends, the match last chosen in the Match tool starts; with no choice, the simulated demo match starts as today.

- Contract: the studio settings gain `queued_match: {source, ref, speed} | null` (default null; saved studios keep loading).
- Pipeline: choosing in the Match tool without starting stores the choice (`PUT /api/studio/queued-match`, null clears it); starting a match from the tool also stores it. Where the countdown ends today (`STUDIO_MATCH_SPEED` auto start), start the queued match through the same controller path as `POST /api/matches`; a failed start falls back to the simulated match and records the problem in the studio's errors.
- Web: the Match tool shows "Starts when the countdown ends" for the queued choice, with Clear.
- Tests first: pipeline (queued choice stored, countdown end starts it, failure falls back) and web (tool shows and clears the queued choice).

```bash
git commit -m "Start the match chosen in the Match tool when the studio countdown ends"
```

---

## Self-review (plan author)

| Spec requirement | Task |
|---|---|
| `MatchSource` port; StatsBomb, API-Football and (replacing SportAPI.ai) OpenLigaDB adapters | 2, 5, 6, 8, 9 |
| StatsBomb files fetched on first use, cached in `.data/statsbomb/`, replayed through the `Simulator` in match-time order at the chosen speed | 5, 6, 7 |
| Conversion table, 120 × 80 → 0–100 with the home side attacking one way, carries and pressures not separate events, extra time ends the match, no shoot-outs | 5 |
| Live sources offered only with their key; live runner replaces the simulator; controller starts and stops either kind and announces abandoned matches | 8, 10, 11, 12 |
| `MatchEvent.xg` / `located`; analytics prefer StatsBomb xG; position-based analytics ignore unlocated events | 1, 3 |
| `MatchStatus.source` / `detail` / `credit` / `competition` / `pre_match` | 1, 7, 10 |
| Teams per match; `GET /api/teams` gives the current match's or the defaults; colour from a palette | 2, 7, 12 |
| `TeamSheet.formation`, `Player.starting` / `grid` | 1, 5, 8 |
| "Not available with live data" for pitch with pressure, 3D pitch, momentum, pressure-based predictions; score, events, team stats from the source, timeline, narration, banners still work | 3, 4, 13, 14, 16 |
| Match tool: source; StatsBomb competition → season → match with score hidden; speeds real time to 30×; live fixtures filtered by competition with their state; Start and Stop | 15 |
| Credit in a program corner while a StatsBomb match plays | 14 |
| Routes: `GET /api/sources`, StatsBomb competitions and matches, `GET /api/sources/{live}/fixtures?date=`, `POST /api/matches {source, ref, speed}` keeping `{seed, speed}` | 12 |
| Errors: network failure, refused key, spent budget reported with what to do; a running live match keeps its state and retries with backoff; cached replays work offline | 6, 8, 10, 11, 15 |
| Source picker on the match data page's Start control | 16 |
| Testing: recorded fixtures under `tests/fixtures/`, architecture test covers the new packages, no test needs the internet, opt-in `pnpm e2e:network` | 5, 8, 9, 10, 12, 17, 18 |
| README documents the free sources and the key | 19 |
| Secrets never logged, printed, returned or in a `repr` | 8, 12 (tests), Review focus 3 |
| Saved data keeps loading | 1 (test), 14 (templates) |

**Placeholder scan:** none. The API-Football fixtures are hand-written on purpose, and each place that matters says so (Task 8, README, Risks).

**Type consistency:**
- `Competition`, `MatchListing`, `Fixture`, `SourceInfo`, `Sources` and `RunningMatch` are contract types on both sides.
- `ReplayMatch`, `LiveSnapshot`, `LiveEvent`, `PollPlan`, `SourceFailure` and `SourceUnavailable` live only in `ports/match_source.py`.
- Player ids are prefixed by source (`sb-`, `af-`, `ol-`) so two sources can never collide with each other or with `nbr-` / `hbc-`.

---

## Risks and open questions

**Risks**

1. **API-Football's free plan may not cover today's matches.** The free plan limits which seasons (and possibly which dates) a key may read. In practice API-Football live may be refused for current competitions. The plan surfaces API-Football's own `errors` text with a hint, and OpenLigaDB is the dependable free live source (German leagues only).
2. **API-Football response details are unverified.** No key was available, so the fixtures follow the documentation. Two semantics need checking against a recorded response before relying on them: in `subst` events, which of `player` / `assist` is the player coming on; and under which team an `Own Goal` is listed. The scoreboard always follows `goals`, so a wrong reading can only misname a scorer or a substitute. Record a real `/fixtures?id=` response with a key and replace `fixture-*.json`.
3. **OpenLigaDB has no live clock and no half-time flag.** The minute and the half-time break are estimated from the kick-off time. The data is community-entered, so goals can arrive late or be corrected. Corrections are not retracted from the event list, but the score follows the source.
4. **Budget drift.** Other programs using the same key spend the same 100 requests. The counter follows the API's `x-ratelimit-requests-remaining` header after every answer, but a request can still be refused before the first sync of the day.
5. **First StatsBomb start waits for a 2–4 MB download.** The start request blocks for a few seconds (30 s timeout). The Match tool shows "Starting…" with the button disabled, and a timeout comes back as a clear message.
6. **Real-match timing.** StatsBomb's second half restarts at 45:00 after first-half stoppage time (e.g. 48:26), and the clock goes backwards between halves. The simulator skips negative sleeps, but per-minute agent reports for minutes 45–48 of the second half only come once minute 49 starts. There is no real-time half-time pause in replays (the same as simulated matches).
7. **Bigger squads.** `PlayerReport` now allows 60 players (World Cup 2022 squads are 26 a side). Check that the player list UIs scroll rather than overflow.
8. **Copilot on key-events matches.** Tactics and pitch questions have no data. Copilot's assembled answers should say so rather than quote zeros; check `copilot/answer.py`'s tactics and pitch intents during Task 16 review and add a sentence if needed.

**Decisions (user, 2026-10-14)**

1. **Studio auto start:** the countdown starts the match last chosen in the Match tool, else the simulated demo. Task 20.
2. **StatsBomb attribution:** the program credit shows StatsBomb's logo with "Data: StatsBomb" (their terms ask for the logo). Use the logo image shipped in the open-data repository (look under its `img/` folder) as a bundled web asset; Task 14 renders it in the credit corner whenever `status.source == "statsbomb"`. Other sources keep a text credit.
3. **OpenLigaDB competitions:** default `pl,la1,ucl` (Premier League, LaLiga, Champions League 2026/27 shortcuts as listed by `/getavailableleagues`). These are community-entered and may lag; the Match tool says so. Tests keep using `bl1` fixtures through `KICKSTREAM_OPENLIGADB_LEAGUES`.
4. **Match picker on the match data page:** translated (en/es/hi) like the rest of that page. Task 16 adds the strings to `i18n.ts`.
5. **Replay speed default:** real time; the faster speeds stay selectable.
6. **StatsBomb files** come from `hudl/open-data` (the repository moved; the old `statsbomb/open-data` URL redirects).

---

## Execution handoff

Plan complete and saved at `docs/superpowers/plans/2026-10-14-kickstream-real-match-data.md`.

**Two execution options:**

1. **Subagent-driven (recommended).** A fresh subagent per task, reviewed between tasks.
2. **Inline.** Execute the tasks in this session one after another.

Which do you prefer?
