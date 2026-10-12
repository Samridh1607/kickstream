# Kickstream Cycle 1 Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One seeded synthetic football match plays locally through Ingest → Interpret → Explain → Render → Personalize and is watched live in a Fluent UI dashboard.

**Architecture:** A single Python process runs five stage modules that talk only through an event bus port and generated contracts. A recorder writes everything to an append-only match log; the gateway replays and streams that log to browsers over Server-Sent Events, filtered per viewer. Narratives are computed once per (key moment, mode, language) and fanned out, so model cost never grows with viewers.

**Tech Stack:** Python 3.13, uv, FastAPI 0.143, sse-starlette 3.5, Pydantic 2.14, Microsoft Agent Framework (core 1.21), pytest 9. Node 24, pnpm 10, Vite 8, React 19.3, TypeScript 7, Fluent UI v9 (`@fluentui/react-components` 9.74.9), zustand 5, Vitest 5, Playwright 1.64.

**Spec:** `docs/superpowers/specs/2026-10-12-kickstream-slice-design.md`

## Global Constraints

- Python `>=3.13`; Node 24; package managers are `uv` (Python) and `pnpm` (Node).
- Languages are exactly `en`, `es`, `hi`. Modes are exactly `fan`, `analyst`.
- Clubs and players are fictional. No real club names, crests or player names anywhere, including tests and fixtures.
- No stage package (`simulator`, `analytics`, `narration`, `overlay`, `gateway`) imports another stage package. Stages import only `kickstream.contracts`, `kickstream.domain` and `kickstream.ports`.
- Concrete adapters (`kickstream.adapters.*`) are named only in `kickstream/app.py` and in tests.
- `kickstream/contracts.py` and `apps/web/src/contracts.ts` are generated from `packages/contracts/kickstream.schema.json`. Never edit them by hand; change the schema and regenerate.
- No test calls a live model. The model endpoint is set only by `KICKSTREAM_LLM_BASE_URL`, `KICKSTREAM_LLM_MODEL`, `KICKSTREAM_LLM_API_KEY`; with any of them unset the system uses scripted narratives.
- Coordinates are 0–100 on both axes; the home team attacks toward x = 100 in both halves.
- Default playback speed is 30×. Allowed range is 1 to 600.
- Development is test-first: write the failing test, watch it fail, then implement.
- All Python commands run from `services/pipeline`; all web commands run from `apps/web`.
- Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

Inputs the spec does not spell out but a person will hit. Each has a pinning test in the task named.

1. **A second viewer, or a restart while others are watching.** Someone opens the dashboard while a match is running, or a match is restarted under a connected viewer. They should join the running match, and viewers of a replaced match should be told it ended and moved to the new one, not left on a frozen screen. (Tasks 11 and 15)
2. **Model output in the wrong shape.** The model wraps JSON in a code fence, adds prose, or omits a language. Fenced JSON should still be read; a missing or empty variant should make that whole item fall back to scripted text, never show a blank or half-translated narrative. (Tasks 7 and 8)
3. **Out-of-range start requests and stream parameters.** Speed 0, negative or enormous, a non-numeric seed, an unknown mode or language, a garbage `Last-Event-ID`. Each should get a clear 422 (or a full replay for the bad ID), never a match that runs forever or a crashed stream. (Task 11)
4. **A favorite that is not in this match.** Preferences saved earlier name a club or player that the current team sheets do not contain, or a player who has been substituted off. The stream should work normally with nothing highlighted. (Tasks 10 and 15)
5. **Corrupt or outdated saved preferences.** `localStorage` holds invalid JSON or a language the app no longer supports. The app should start with defaults. (Task 12)

## File Structure

```
.gitattributes  .gitignore  package.json  pnpm-workspace.yaml  README.md
packages/contracts/kickstream.schema.json      single source of truth for every message shape
services/pipeline/
  pyproject.toml
  kickstream/
    contracts.py            GENERATED Pydantic models
    tools/gen_contracts.py  regenerates contracts.py; --check fails when stale
    domain/                 pure helpers shared by stages
      types.py              Side, Mode, Language literals and VARIANTS
      pitch.py              zones, attacking direction, expected goals
      teams.py              the two fictional team sheets
      labels.py             localized stat and key-moment labels
      demo.py               DEMO_SEED
    ports/                  bus.py store.py broadcaster.py clock.py writer.py
    adapters/               memory_bus.py memory_store.py sse_broadcaster.py clocks.py
                            scripted_writer.py agent_writer.py
    simulator/              generate.py (match generation)  stage.py (timed playback)
    analytics/              state.py (fold + key-moment rules)  stage.py
    narration/              budget.py cache.py service.py stage.py
    overlay/                build.py stage.py
    gateway/                recorder.py personalize.py stream.py api.py
    control.py              MatchController: start / replace the running match
    app.py                  composition root: Settings, build_pipeline, create_app
  tests/                    one test module per unit, plus factories.py and fake_llm.py
apps/web/
  package.json vite.config.ts tsconfig.json index.html playwright.config.ts
  scripts/gen-contracts.mjs
  src/
    contracts.ts            GENERATED TypeScript types
    main.tsx App.tsx
    i18n.ts prefs.ts theme.ts api.ts
    stream/store.ts         pure reducer + zustand store
    stream/client.ts        the one EventSource owner
    components/             Header Pitch StatsPanel Timeline NarrativeFeed
                            PreferencesDrawer RecapDialog OverlayTab PipelinePanel
    test/setup.ts test/fixtures.ts
  e2e/smoke.spec.ts
```

Two additions to the spec, both already written back into it:

- `GET /api/matches/current` lets a browser find the running match (Review Focus 1).
- `MatchStatus.state` has an `abandoned` value for a match replaced by a new one.

---

### Task 1: Repository scaffold and generated Python contracts

**Files:**
- Create: `.gitattributes`, `.gitignore`
- Create: `packages/contracts/kickstream.schema.json`
- Create: `services/pipeline/pyproject.toml`
- Create: `services/pipeline/kickstream/__init__.py`, `services/pipeline/kickstream/tools/__init__.py`, `services/pipeline/kickstream/tools/gen_contracts.py`
- Create (generated): `services/pipeline/kickstream/contracts.py`
- Test: `services/pipeline/tests/__init__.py`, `services/pipeline/tests/test_contracts.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `kickstream.contracts` with Pydantic v2 models `Player, TeamSheet, MatchStatus, MatchEvent, TeamStats, StatsSnapshot, PressureSnapshot, StatFact, KeyMoment, Narrative, Recap, LowerThirdData, StatRow, StatCardData, PressureMapData, RecapCardData, Overlay, ViewerProfile, Envelope`. All forbid unknown fields. Enumerations are `Literal` types. Nullable fields default to `None`. `kickstream.tools.gen_contracts.render(out: Path) -> None` and constants `SCHEMA`, `TARGET`.

- [ ] **Step 1: Write the repository files**

`.gitattributes`:

```
* text=auto eol=lf
```

`.gitignore`:

```
__pycache__/
.venv/
.pytest_cache/
.ruff_cache/
.cache/
node_modules/
dist/
test-results/
playwright-report/
.env
```

`services/pipeline/pyproject.toml`:

```toml
[project]
name = "kickstream"
version = "0.1.0"
description = "Kickstream pipeline: synthetic match events to live narratives"
requires-python = ">=3.13"
dependencies = [
  "fastapi==0.143.0",
  "uvicorn==0.54.0",
  "pydantic==2.14.1",
  "sse-starlette==3.5.0",
]

[dependency-groups]
dev = [
  "pytest==9.1.1",
  "pytest-asyncio==1.4.0",
  "httpx==0.28.1",
  "datamodel-code-generator==0.83.0",
  "ruff==0.17.0",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["kickstream"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]

[tool.ruff]
line-length = 110
extend-exclude = ["kickstream/contracts.py"]
```

`services/pipeline/kickstream/__init__.py`, `services/pipeline/kickstream/tools/__init__.py` and `services/pipeline/tests/__init__.py` are empty files.

- [ ] **Step 2: Write the schema**

`packages/contracts/kickstream.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "KickstreamContracts",
  "$defs": {
    "Player": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "name", "number", "position"],
      "properties": {
        "id": { "type": "string" },
        "name": { "type": "string" },
        "number": { "type": "integer" },
        "position": { "enum": ["GK", "DF", "MF", "FW"] }
      }
    },
    "TeamSheet": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "name", "short_name", "color", "players"],
      "properties": {
        "id": { "type": "string" },
        "name": { "type": "string" },
        "short_name": { "type": "string" },
        "color": { "type": "string" },
        "players": { "type": "array", "items": { "$ref": "#/$defs/Player" } }
      }
    },
    "MatchStatus": {
      "type": "object", "additionalProperties": false,
      "required": ["match_id", "state", "minute", "score_home", "score_away", "speed", "home", "away"],
      "properties": {
        "match_id": { "type": "string" },
        "state": { "enum": ["live", "half_time", "finished", "abandoned"] },
        "minute": { "type": "integer" },
        "score_home": { "type": "integer" },
        "score_away": { "type": "integer" },
        "speed": { "type": "number" },
        "home": { "$ref": "#/$defs/TeamSheet" },
        "away": { "$ref": "#/$defs/TeamSheet" }
      }
    },
    "MatchEvent": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "match_id", "seq", "minute", "second", "type", "x", "y"],
      "properties": {
        "id": { "type": "string" },
        "match_id": { "type": "string" },
        "seq": { "type": "integer" },
        "minute": { "type": "integer" },
        "second": { "type": "integer" },
        "type": { "enum": ["kickoff", "pass", "shot", "goal", "save", "foul", "yellow_card", "red_card", "corner", "substitution", "half_time", "full_time"] },
        "team": { "enum": ["home", "away", null], "default": null },
        "player_id": { "type": ["string", "null"], "default": null },
        "x": { "type": "number" },
        "y": { "type": "number" },
        "outcome": { "enum": ["goal", "saved", "off_target", "blocked", null], "default": null },
        "completed": { "type": ["boolean", "null"], "default": null },
        "player_in_id": { "type": ["string", "null"], "default": null }
      }
    },
    "TeamStats": {
      "type": "object", "additionalProperties": false,
      "required": ["goals", "possession", "shots", "shots_on_target", "passes", "pass_accuracy", "fouls", "yellow_cards", "red_cards", "xg"],
      "properties": {
        "goals": { "type": "integer" },
        "possession": { "type": "number" },
        "shots": { "type": "integer" },
        "shots_on_target": { "type": "integer" },
        "passes": { "type": "integer" },
        "pass_accuracy": { "type": "number" },
        "fouls": { "type": "integer" },
        "yellow_cards": { "type": "integer" },
        "red_cards": { "type": "integer" },
        "xg": { "type": "number" }
      }
    },
    "StatsSnapshot": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "match_id", "minute", "home", "away", "momentum"],
      "properties": {
        "id": { "type": "string" },
        "match_id": { "type": "string" },
        "minute": { "type": "integer" },
        "home": { "$ref": "#/$defs/TeamStats" },
        "away": { "$ref": "#/$defs/TeamStats" },
        "momentum": { "type": "number" },
        "period_end": { "enum": ["half_time", "full_time", null], "default": null }
      }
    },
    "PressureSnapshot": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "match_id", "minute", "cols", "rows", "home", "away"],
      "properties": {
        "id": { "type": "string" },
        "match_id": { "type": "string" },
        "minute": { "type": "integer" },
        "cols": { "type": "integer" },
        "rows": { "type": "integer" },
        "home": { "type": "array", "items": { "type": "number" } },
        "away": { "type": "array", "items": { "type": "number" } }
      }
    },
    "StatFact": {
      "type": "object", "additionalProperties": false,
      "required": ["label", "value"],
      "properties": {
        "label": { "enum": ["xg", "shots", "shots_on_target", "possession", "pressure", "momentum", "players_on_pitch", "fouls"] },
        "value": { "type": "number" }
      }
    },
    "KeyMoment": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "match_id", "minute", "kind", "team", "score_home", "score_away", "facts"],
      "properties": {
        "id": { "type": "string" },
        "match_id": { "type": "string" },
        "minute": { "type": "integer" },
        "kind": { "enum": ["goal", "red_card", "big_chance", "momentum_swing", "sustained_pressure"] },
        "team": { "enum": ["home", "away"] },
        "player_id": { "type": ["string", "null"], "default": null },
        "event_id": { "type": ["string", "null"], "default": null },
        "score_home": { "type": "integer" },
        "score_away": { "type": "integer" },
        "facts": { "type": "array", "items": { "$ref": "#/$defs/StatFact" } }
      }
    },
    "Narrative": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "match_id", "minute", "moment_id", "mode", "language", "text", "source", "agent", "evidence", "team"],
      "properties": {
        "id": { "type": "string" },
        "match_id": { "type": "string" },
        "minute": { "type": "integer" },
        "moment_id": { "type": "string" },
        "mode": { "enum": ["fan", "analyst"] },
        "language": { "enum": ["en", "es", "hi"] },
        "text": { "type": "string", "minLength": 1 },
        "source": { "enum": ["agent", "scripted"] },
        "agent": { "type": "string" },
        "evidence": { "type": "array", "items": { "type": "string" } },
        "team": { "enum": ["home", "away"] },
        "player_id": { "type": ["string", "null"], "default": null }
      }
    },
    "Recap": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "match_id", "minute", "period", "mode", "language", "title", "bullets", "text", "source", "agent", "score_home", "score_away"],
      "properties": {
        "id": { "type": "string" },
        "match_id": { "type": "string" },
        "minute": { "type": "integer" },
        "period": { "enum": ["half_time", "full_time"] },
        "mode": { "enum": ["fan", "analyst"] },
        "language": { "enum": ["en", "es", "hi"] },
        "title": { "type": "string", "minLength": 1 },
        "bullets": { "type": "array", "items": { "type": "string" }, "minItems": 3, "maxItems": 3 },
        "text": { "type": "string", "minLength": 1 },
        "source": { "enum": ["agent", "scripted"] },
        "agent": { "type": "string" },
        "score_home": { "type": "integer" },
        "score_away": { "type": "integer" }
      }
    },
    "LowerThirdData": {
      "type": "object", "additionalProperties": false,
      "required": ["headline", "subline", "team", "minute"],
      "properties": {
        "headline": { "type": "string" },
        "subline": { "type": "string" },
        "team": { "type": "string" },
        "minute": { "type": "integer" }
      }
    },
    "StatRow": {
      "type": "object", "additionalProperties": false,
      "required": ["label", "home", "away"],
      "properties": {
        "label": { "type": "string" },
        "home": { "type": "number" },
        "away": { "type": "number" }
      }
    },
    "StatCardData": {
      "type": "object", "additionalProperties": false,
      "required": ["stat_rows"],
      "properties": {
        "stat_rows": { "type": "array", "items": { "$ref": "#/$defs/StatRow" }, "maxItems": 4 }
      }
    },
    "PressureMapData": {
      "type": "object", "additionalProperties": false,
      "required": ["cols", "rows", "home", "away"],
      "properties": {
        "cols": { "type": "integer" },
        "rows": { "type": "integer" },
        "home": { "type": "array", "items": { "type": "number" } },
        "away": { "type": "array", "items": { "type": "number" } }
      }
    },
    "RecapCardData": {
      "type": "object", "additionalProperties": false,
      "required": ["title", "score", "bullets"],
      "properties": {
        "title": { "type": "string" },
        "score": { "type": "string" },
        "bullets": { "type": "array", "items": { "type": "string" }, "minItems": 3, "maxItems": 3 }
      }
    },
    "Overlay": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "match_id", "minute", "kind", "duration_ms", "sources", "data"],
      "properties": {
        "id": { "type": "string" },
        "match_id": { "type": "string" },
        "minute": { "type": "integer" },
        "kind": { "enum": ["lower_third", "stat_card", "pressure_map", "recap_card"] },
        "language": { "enum": ["en", "es", "hi", null], "default": null },
        "duration_ms": { "type": "integer" },
        "sources": { "type": "array", "items": { "type": "string" } },
        "data": {
          "anyOf": [
            { "$ref": "#/$defs/LowerThirdData" },
            { "$ref": "#/$defs/StatCardData" },
            { "$ref": "#/$defs/PressureMapData" },
            { "$ref": "#/$defs/RecapCardData" }
          ]
        }
      }
    },
    "ViewerProfile": {
      "type": "object", "additionalProperties": false,
      "required": ["mode", "language"],
      "properties": {
        "mode": { "enum": ["fan", "analyst"] },
        "language": { "enum": ["en", "es", "hi"] },
        "club": { "type": ["string", "null"], "default": null },
        "player": { "type": ["string", "null"], "default": null }
      }
    },
    "Envelope": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "type", "match_id", "minute", "highlighted", "payload"],
      "properties": {
        "id": { "type": "integer" },
        "type": { "enum": ["match_status", "match_event", "stats", "pressure", "key_moment", "narrative", "recap", "overlay"] },
        "match_id": { "type": "string" },
        "minute": { "type": "integer" },
        "highlighted": { "type": "boolean" },
        "payload": { "type": "object" }
      }
    }
  }
}
```

The four overlay data shapes have different required field names on purpose (`stat_rows` versus `rows`), so a union of them is never ambiguous.

- [ ] **Step 3: Write the failing tests**

`services/pipeline/tests/test_contracts.py`:

```python
from pathlib import Path

import pytest
from pydantic import ValidationError

from kickstream.tools.gen_contracts import TARGET, render


def _normalized(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def test_generated_contracts_are_current(tmp_path):
    fresh = tmp_path / "contracts.py"
    render(fresh)
    assert _normalized(fresh) == _normalized(TARGET), "run: uv run python -m kickstream.tools.gen_contracts"


def test_match_event_accepts_minimal_event_and_defaults_nullables():
    from kickstream.contracts import MatchEvent

    event = MatchEvent(id="m-1-e1", match_id="m-1", seq=1, minute=0, second=0, type="half_time", x=50, y=50)
    assert event.team is None
    assert event.player_id is None
    assert event.outcome is None


def test_models_reject_unknown_fields_and_values():
    from kickstream.contracts import MatchEvent

    base = dict(id="e", match_id="m", seq=1, minute=0, second=0, type="pass", x=1, y=1)
    with pytest.raises(ValidationError):
        MatchEvent(**base, bogus=1)
    with pytest.raises(ValidationError):
        MatchEvent(**{**base, "type": "handball"})


def test_overlay_data_resolves_to_the_matching_shape():
    from kickstream.contracts import Overlay, PressureMapData, StatCardData

    stat = Overlay(id="o1", match_id="m", minute=5, kind="stat_card", duration_ms=8000, sources=[],
                   data={"stat_rows": [{"label": "Shots", "home": 3, "away": 1}]})
    heat = Overlay(id="o2", match_id="m", minute=5, kind="pressure_map", duration_ms=8000, sources=[],
                   data={"cols": 6, "rows": 4, "home": [0.0] * 24, "away": [0.0] * 24})
    assert isinstance(stat.data, StatCardData)
    assert isinstance(heat.data, PressureMapData)


def test_recap_requires_exactly_three_bullets():
    from kickstream.contracts import Recap

    fields = dict(id="r", match_id="m", minute=45, period="half_time", mode="fan", language="en", title="t",
                  text="x", source="scripted", agent="scripted", score_home=0, score_away=0)
    with pytest.raises(ValidationError):
        Recap(**fields, bullets=["a", "b"])
    assert len(Recap(**fields, bullets=["a", "b", "c"]).bullets) == 3
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `uv sync && uv run pytest tests/test_contracts.py -v`
Expected: collection error, `ModuleNotFoundError: No module named 'kickstream.tools.gen_contracts'`.

- [ ] **Step 5: Write the generator**

`services/pipeline/kickstream/tools/gen_contracts.py`:

```python
"""Generate kickstream/contracts.py from the shared JSON Schema.

Run `python -m kickstream.tools.gen_contracts` to regenerate.
Run with `--check` to exit non-zero when the checked-in file is stale.
"""

import subprocess
import sys
import tempfile
from pathlib import Path

PIPELINE_ROOT = Path(__file__).resolve().parents[2]
SCHEMA = PIPELINE_ROOT.parents[1] / "packages" / "contracts" / "kickstream.schema.json"
TARGET = PIPELINE_ROOT / "kickstream" / "contracts.py"


def render(out: Path) -> None:
    subprocess.run(
        [
            sys.executable, "-m", "datamodel_code_generator",
            "--input", str(SCHEMA),
            "--input-file-type", "jsonschema",
            "--output", str(out),
            "--output-model-type", "pydantic_v2.BaseModel",
            "--target-python-version", "3.13",
            "--use-standard-collections",
            "--use-union-operator",
            "--enum-field-as-literal", "all",
            "--disable-timestamp",
        ],
        check=True,
    )


def _normalized(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def main(argv: list[str]) -> int:
    if "--check" not in argv:
        render(TARGET)
        return 0
    with tempfile.TemporaryDirectory() as tmp:
        fresh = Path(tmp) / "contracts.py"
        render(fresh)
        if _normalized(fresh) != _normalized(TARGET):
            print("kickstream/contracts.py is stale; run: python -m kickstream.tools.gen_contracts")
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
```

- [ ] **Step 6: Generate the contracts**

Run: `uv run python -m kickstream.tools.gen_contracts`
Expected: `kickstream/contracts.py` exists and contains `class MatchEvent(BaseModel):` with `model_config = ConfigDict(extra='forbid')` and `type: Literal['kickoff', 'pass', ...]`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `uv run pytest tests/test_contracts.py -v`
Expected: 5 passed.

- [ ] **Step 8: Commit**

```bash
git add .gitattributes .gitignore packages/contracts services/pipeline
git commit -m "feat: add contract schema and generated Python models"
```

---

### Task 2: Domain helpers

**Files:**
- Create: `services/pipeline/kickstream/domain/__init__.py` (empty), `types.py`, `pitch.py`, `teams.py`, `labels.py`
- Test: `services/pipeline/tests/test_domain.py`

**Interfaces:**
- Consumes: `kickstream.contracts.Player, TeamSheet, StatFact`.
- Produces:
  - `domain.types`: `Side = Literal["home","away"]`, `Mode = Literal["fan","analyst"]`, `Language = Literal["en","es","hi"]`, `SIDES`, `MODES`, `LANGUAGES` (tuples), `Variant = tuple[Mode, Language]`, `VARIANTS: tuple[Variant, ...]` (6 entries), `other(side: Side) -> Side`.
  - `domain.pitch`: `COLS = 6`, `ROWS = 4`, `attacking_x(side, x) -> float`, `zone_index(x, y) -> int`, `attacking_third(side) -> tuple[int, ...]`, `xg(attacking_x: float, y: float) -> float`.
  - `domain.teams`: `HOME: TeamSheet`, `AWAY: TeamSheet`, `find_player(sheets: Iterable[TeamSheet], player_id: str | None) -> Player | None`.
  - `domain.labels`: `FACT_LABELS: dict[Language, dict[str, str]]`, `KIND_LABELS: dict[Language, dict[str, str]]`, `fact_text(facts: list[StatFact], language: Language) -> str`.

- [ ] **Step 1: Write the failing tests**

`services/pipeline/tests/test_domain.py`:

```python
from kickstream.contracts import StatFact
from kickstream.domain.labels import FACT_LABELS, KIND_LABELS, fact_text
from kickstream.domain.pitch import COLS, ROWS, attacking_third, attacking_x, xg, zone_index
from kickstream.domain.teams import AWAY, HOME, find_player
from kickstream.domain.types import LANGUAGES, VARIANTS, other


def test_variants_cover_every_mode_and_language_once():
    assert len(VARIANTS) == 6
    assert len(set(VARIANTS)) == 6
    assert ("analyst", "hi") in VARIANTS
    assert other("home") == "away" and other("away") == "home"


def test_attacking_x_mirrors_for_the_away_side():
    assert attacking_x("home", 80) == 80
    assert attacking_x("away", 80) == 20


def test_zone_index_covers_the_grid_without_overflow():
    assert zone_index(0, 0) == 0
    assert zone_index(100, 100) == COLS * ROWS - 1
    assert zone_index(99.9, 0) == COLS - 1
    assert zone_index(0, 99.9) == (ROWS - 1) * COLS


def test_attacking_third_is_the_last_two_columns_in_attack_direction():
    assert set(attacking_third("home")) == {r * COLS + c for r in range(ROWS) for c in (4, 5)}
    assert set(attacking_third("away")) == {r * COLS + c for r in range(ROWS) for c in (0, 1)}


def test_xg_rewards_distance_and_angle_and_stays_in_bounds():
    assert xg(94, 50) > xg(80, 50) > xg(60, 50)
    assert xg(90, 50) > xg(90, 10)
    for ax in (0, 50, 99.9, 100):
        for y in (0, 50, 100):
            assert 0.01 <= xg(ax, y) <= 0.95


def test_team_sheets_are_complete_and_distinct():
    for sheet in (HOME, AWAY):
        assert len(sheet.players) == 14
        assert [p.position for p in sheet.players[:11]].count("GK") == 1
        assert len({p.id for p in sheet.players}) == 14
    assert HOME.id != AWAY.id
    assert not {p.id for p in HOME.players} & {p.id for p in AWAY.players}


def test_find_player_returns_none_for_unknown_or_missing_ids():
    first = HOME.players[0]
    assert find_player((HOME, AWAY), first.id) == first
    assert find_player((HOME, AWAY), "nobody") is None
    assert find_player((HOME, AWAY), None) is None


def test_labels_exist_for_every_language():
    for language in LANGUAGES:
        assert set(FACT_LABELS[language]) == set(FACT_LABELS["en"])
        assert set(KIND_LABELS[language]) == {"goal", "red_card", "big_chance", "momentum_swing", "sustained_pressure"}


def test_fact_text_localizes_labels_and_trims_whole_numbers():
    facts = [StatFact(label="xg", value=0.42), StatFact(label="shots", value=7.0)]
    assert fact_text(facts, "en") == "expected goals 0.42, shots 7"
    assert fact_text(facts, "es") == "goles esperados 0.42, remates 7"
    assert fact_text([], "en") == ""
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_domain.py -v`
Expected: collection error, `ModuleNotFoundError: No module named 'kickstream.domain'`.

- [ ] **Step 3: Write the domain modules**

`services/pipeline/kickstream/domain/types.py`:

```python
from typing import Literal

Side = Literal["home", "away"]
Mode = Literal["fan", "analyst"]
Language = Literal["en", "es", "hi"]
Variant = tuple[Mode, Language]

SIDES: tuple[Side, ...] = ("home", "away")
MODES: tuple[Mode, ...] = ("fan", "analyst")
LANGUAGES: tuple[Language, ...] = ("en", "es", "hi")
VARIANTS: tuple[Variant, ...] = tuple((mode, language) for mode in MODES for language in LANGUAGES)


def other(side: Side) -> Side:
    return "away" if side == "home" else "home"
```

`services/pipeline/kickstream/domain/pitch.py`:

```python
"""Pitch geometry. Coordinates are 0-100 on both axes; home attacks toward x = 100."""

import math

from kickstream.domain.types import Side

COLS = 6
ROWS = 4
_PITCH_LENGTH_M = 105.0
_PITCH_WIDTH_M = 68.0


def attacking_x(side: Side, x: float) -> float:
    """Distance travelled along the attacking direction of `side`, 0-100."""
    return x if side == "home" else 100.0 - x


def zone_index(x: float, y: float) -> int:
    col = min(COLS - 1, max(0, int(x / 100.0 * COLS)))
    row = min(ROWS - 1, max(0, int(y / 100.0 * ROWS)))
    return row * COLS + col


def attacking_third(side: Side) -> tuple[int, ...]:
    cols = (COLS - 2, COLS - 1) if side == "home" else (0, 1)
    return tuple(row * COLS + col for row in range(ROWS) for col in cols)


def xg(attacking_x: float, y: float) -> float:
    """A simple expected-goals value from distance and angle to the goal centre."""
    dx = (100.0 - attacking_x) / 100.0 * _PITCH_LENGTH_M
    dy = (y - 50.0) / 100.0 * _PITCH_WIDTH_M
    distance = math.hypot(dx, dy)
    angle = math.atan2(abs(dy), max(dx, 0.01))
    value = 0.9 * math.exp(-distance / 9.0) * max(0.2, math.cos(angle))
    return max(0.01, min(0.95, value))
```

`services/pipeline/kickstream/domain/teams.py`:

```python
"""The two fictional clubs used by the simulator. No real clubs or players."""

from collections.abc import Iterable

from kickstream.contracts import Player, TeamSheet

_POSITIONS = ["GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "FW", "FW", "FW", "DF", "MF", "FW"]

_HOME_NAMES = [
    "Tobin Ashgrove", "Milo Ferncastle", "Idris Vantongeren", "Caspian Holloway", "Renzo Albarran",
    "Kellan Whitlock", "Jovan Stradling", "Emeka Okonjo-Reyes", "Luca Marrowby", "Dashiell Pruett",
    "Arjun Venkataraghavan", "Soren Applewhite", "Mateus Calderwood", "Finnian Ostrander",
]
_AWAY_NAMES = [
    "Osric Pendlebury", "Bastien Roquefeuil", "Nikhil Thorncroft", "Aurelio Zambrana", "Wendell Kirkby",
    "Tariq Halvorsen", "Ignatius Bellweather", "Rohan Castellane", "Evander Quillfeather", "Yusuf Marlowe-Diaz",
    "Cormac Linthwaite", "Anselm Drakeford", "Vikram Elderfield", "Leopold Varga-Nilsen",
]


def _sheet(team_id: str, name: str, short_name: str, color: str, names: list[str]) -> TeamSheet:
    players = [
        Player(id=f"{team_id}-{number}", name=player_name, number=number, position=position)
        for number, (player_name, position) in enumerate(zip(names, _POSITIONS, strict=True), start=1)
    ]
    return TeamSheet(id=team_id, name=name, short_name=short_name, color=color, players=players)


HOME = _sheet("nbr", "Northbridge FC", "NBR", "#0F6CBD", _HOME_NAMES)
AWAY = _sheet("hbc", "Harbour City", "HBC", "#C50F1F", _AWAY_NAMES)


def find_player(sheets: Iterable[TeamSheet], player_id: str | None) -> Player | None:
    if player_id is None:
        return None
    for sheet in sheets:
        for player in sheet.players:
            if player.id == player_id:
                return player
    return None
```

`services/pipeline/kickstream/domain/labels.py`:

```python
"""Localized labels shared by the scripted writer and the overlay engine."""

from kickstream.contracts import StatFact
from kickstream.domain.types import Language

FACT_LABELS: dict[Language, dict[str, str]] = {
    "en": {
        "xg": "expected goals", "shots": "shots", "shots_on_target": "shots on target",
        "possession": "possession %", "pressure": "pressure", "momentum": "momentum",
        "players_on_pitch": "players on pitch", "fouls": "fouls",
    },
    "es": {
        "xg": "goles esperados", "shots": "remates", "shots_on_target": "remates a puerta",
        "possession": "posesión %", "pressure": "presión", "momentum": "impulso",
        "players_on_pitch": "jugadores en el campo", "fouls": "faltas",
    },
    "hi": {
        "xg": "अपेक्षित गोल", "shots": "शॉट", "shots_on_target": "निशाने पर शॉट",
        "possession": "कब्ज़ा %", "pressure": "दबाव", "momentum": "गति",
        "players_on_pitch": "मैदान पर खिलाड़ी", "fouls": "फाउल",
    },
}

KIND_LABELS: dict[Language, dict[str, str]] = {
    "en": {"goal": "GOAL", "red_card": "RED CARD", "big_chance": "BIG CHANCE",
           "momentum_swing": "MOMENTUM SHIFT", "sustained_pressure": "SUSTAINED PRESSURE"},
    "es": {"goal": "GOL", "red_card": "TARJETA ROJA", "big_chance": "GRAN OCASIÓN",
           "momentum_swing": "CAMBIO DE IMPULSO", "sustained_pressure": "PRESIÓN SOSTENIDA"},
    "hi": {"goal": "गोल", "red_card": "रेड कार्ड", "big_chance": "बड़ा मौका",
           "momentum_swing": "रुख बदला", "sustained_pressure": "लगातार दबाव"},
}


def _number(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else f"{value:.2f}"


def fact_text(facts: list[StatFact], language: Language) -> str:
    labels = FACT_LABELS[language]
    return ", ".join(f"{labels[fact.label]} {_number(fact.value)}" for fact in facts)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_domain.py -v`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add services/pipeline/kickstream/domain services/pipeline/tests/test_domain.py
git commit -m "feat: add pitch geometry, team sheets and localized labels"
```

---

### Task 3: Ports and in-memory adapters

**Files:**
- Create: `services/pipeline/kickstream/ports/__init__.py` (empty), `bus.py`, `store.py`, `broadcaster.py`, `clock.py`, `writer.py`
- Create: `services/pipeline/kickstream/adapters/__init__.py` (empty), `memory_bus.py`, `memory_store.py`, `sse_broadcaster.py`, `clocks.py`
- Test: `services/pipeline/tests/factories.py`, `services/pipeline/tests/test_memory_adapters.py`

**Interfaces:**
- Consumes: contracts and `domain.types`.
- Produces:
  - `ports.bus`: topic constants `EVENTS, INSIGHTS, NARRATIVES, OVERLAYS, STATUS`; `BusMessage(topic: str, match_id: str, payload: BaseModel)` (frozen dataclass); `Subscription` (async-iterable of `BusMessage`, with `close()`); `EventBus` with `async publish(topic, match_id, payload) -> None` and `subscribe(*topics: str, maxsize: int = 256) -> Subscription`. `subscribe` registers immediately, so a stage that subscribes in its constructor misses nothing.
  - `ports.store`: `LogItem(id: int, match_id: str, type: str, minute: int, payload: BaseModel, language: str | None, mode: str | None, team_id: str | None, player_id: str | None)` (frozen dataclass); `MatchStore` with `append(match_id, type, minute, payload, *, language=None, mode=None, team_id=None, player_id=None) -> LogItem`, `read(match_id, after_id=0) -> list[LogItem]`, `has(match_id) -> bool`.
  - `ports.broadcaster`: `Feed` (async-iterable of `LogItem`, with `close()`); `Broadcaster` with `publish(item: LogItem) -> None` and `subscribe(match_id: str, maxsize: int = 512) -> Feed`. A feed that overflows is ended, not blocked.
  - `ports.clock`: `Clock` with `async sleep(match_seconds: float) -> None`.
  - `ports.writer`: `MomentContext`, `RecapContext`, `WrittenText`, `WrittenRecap`, `NarrativeWriter`, `NarrationError` (full definitions in Step 3).
  - Adapters: `InMemoryEventBus`, `InMemoryMatchStore`, `InProcessBroadcaster`, `RealClock(speed: float)`, `InstantClock()`.
  - `tests.factories`: `event(seq, type_, team=None, minute=0, second=0, x=50.0, y=50.0, **extra) -> MatchEvent`; `moment(n=1, kind="goal", team="home", minute=10, **extra) -> KeyMoment`; `team_stats(**overrides) -> TeamStats`; `stats(minute=10, period_end=None, **sides) -> StatsSnapshot`.

- [ ] **Step 1: Write the test factories**

`services/pipeline/tests/factories.py`:

```python
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
```

- [ ] **Step 2: Write the failing tests**

`services/pipeline/tests/test_memory_adapters.py`:

```python
import asyncio
import logging

from kickstream.adapters.clocks import InstantClock, RealClock
from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.adapters.memory_store import InMemoryMatchStore
from kickstream.adapters.sse_broadcaster import InProcessBroadcaster
from kickstream.ports.bus import EVENTS, INSIGHTS

from tests.factories import MATCH, event


async def _take(subscription, count):
    received = []
    async for message in subscription:
        received.append(message)
        if len(received) == count:
            break
    return received


async def test_bus_delivers_in_order_only_to_matching_topics():
    bus = InMemoryEventBus()
    events = bus.subscribe(EVENTS)
    both = bus.subscribe(EVENTS, INSIGHTS)
    await bus.publish(EVENTS, MATCH, event(1, "kickoff"))
    await bus.publish(INSIGHTS, MATCH, event(2, "pass"))
    await bus.publish(EVENTS, MATCH, event(3, "pass"))
    assert [m.payload.seq for m in await _take(events, 2)] == [1, 3]
    assert [(m.topic, m.payload.seq) for m in await _take(both, 3)] == [(EVENTS, 1), (INSIGHTS, 2), (EVENTS, 3)]


async def test_bus_drops_and_logs_invalid_payloads(caplog):
    bus = InMemoryEventBus()
    subscription = bus.subscribe(EVENTS)
    broken = event(1, "pass").model_copy(update={"minute": "soon"})
    with caplog.at_level(logging.WARNING):
        await bus.publish(EVENTS, MATCH, broken)
    await bus.publish(EVENTS, MATCH, event(2, "pass"))
    assert [m.payload.seq for m in await _take(subscription, 1)] == [2]
    assert "dropped invalid MatchEvent on events" in caplog.text


async def test_bus_applies_backpressure_when_a_subscriber_is_full():
    bus = InMemoryEventBus()
    subscription = bus.subscribe(EVENTS, maxsize=1)
    await bus.publish(EVENTS, MATCH, event(1, "pass"))
    blocked = asyncio.create_task(bus.publish(EVENTS, MATCH, event(2, "pass")))
    await asyncio.sleep(0.01)
    assert not blocked.done()
    await _take(subscription, 1)
    await asyncio.wait_for(blocked, 1)


async def test_closed_subscription_ends_iteration_and_stops_receiving():
    bus = InMemoryEventBus()
    subscription = bus.subscribe(EVENTS)
    subscription.close()
    assert [m async for m in subscription] == []
    await asyncio.wait_for(bus.publish(EVENTS, MATCH, event(1, "pass")), 1)


def test_store_assigns_increasing_ids_per_match_and_reads_after_an_id():
    store = InMemoryMatchStore()
    assert not store.has(MATCH)
    first = store.append(MATCH, "match_event", 0, event(1, "kickoff"))
    second = store.append(MATCH, "match_event", 1, event(2, "pass"), team_id="nbr", player_id="nbr-9")
    other = store.append("m-2", "match_event", 0, event(1, "kickoff"))
    assert (first.id, second.id, other.id) == (1, 2, 1)
    assert store.has(MATCH)
    assert [item.id for item in store.read(MATCH)] == [1, 2]
    assert [item.id for item in store.read(MATCH, after_id=1)] == [2]
    assert store.read("unknown") == []
    assert second.team_id == "nbr" and second.player_id == "nbr-9"


async def test_broadcaster_fans_out_per_match():
    store, broadcaster = InMemoryMatchStore(), InProcessBroadcaster()
    one, two, elsewhere = broadcaster.subscribe(MATCH), broadcaster.subscribe(MATCH), broadcaster.subscribe("m-2")
    item = store.append(MATCH, "match_event", 0, event(1, "kickoff"))
    broadcaster.publish(item)
    assert (await anext(aiter(one))).id == 1
    assert (await anext(aiter(two))).id == 1
    assert elsewhere.queue.empty()


async def test_broadcaster_ends_a_feed_that_cannot_keep_up():
    store, broadcaster = InMemoryMatchStore(), InProcessBroadcaster()
    slow = broadcaster.subscribe(MATCH, maxsize=2)
    for seq in range(1, 4):
        broadcaster.publish(store.append(MATCH, "match_event", 0, event(seq, "pass")))
    assert [item async for item in slow] == []
    broadcaster.publish(store.append(MATCH, "match_event", 0, event(4, "pass")))


async def test_closing_a_feed_unsubscribes_it():
    store, broadcaster = InMemoryMatchStore(), InProcessBroadcaster()
    feed = broadcaster.subscribe(MATCH)
    feed.close()
    broadcaster.publish(store.append(MATCH, "match_event", 0, event(1, "pass")))
    assert [item async for item in feed] == []


async def test_real_clock_divides_match_time_by_speed(monkeypatch):
    slept = []

    async def fake_sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(asyncio, "sleep", fake_sleep)
    await RealClock(30).sleep(60)
    await RealClock(30).sleep(0)
    assert slept == [2.0]


async def test_instant_clock_yields_without_waiting():
    await asyncio.wait_for(InstantClock().sleep(5400), 0.5)
```

- [ ] **Step 3: Write the ports**

`services/pipeline/kickstream/ports/bus.py`:

```python
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol

from pydantic import BaseModel

EVENTS = "events"
INSIGHTS = "insights"
NARRATIVES = "narratives"
OVERLAYS = "overlays"
STATUS = "status"


@dataclass(frozen=True)
class BusMessage:
    topic: str
    match_id: str
    payload: BaseModel


class Subscription(Protocol):
    def __aiter__(self) -> AsyncIterator[BusMessage]: ...

    def close(self) -> None: ...


class EventBus(Protocol):
    async def publish(self, topic: str, match_id: str, payload: BaseModel) -> None: ...

    def subscribe(self, *topics: str, maxsize: int = 256) -> Subscription: ...
```

`services/pipeline/kickstream/ports/store.py`:

```python
from dataclasses import dataclass
from typing import Protocol

from pydantic import BaseModel


@dataclass(frozen=True)
class LogItem:
    """One entry in a match log. The variant fields drive per-viewer filtering."""

    id: int
    match_id: str
    type: str
    minute: int
    payload: BaseModel
    language: str | None = None
    mode: str | None = None
    team_id: str | None = None
    player_id: str | None = None


class MatchStore(Protocol):
    def append(self, match_id: str, type: str, minute: int, payload: BaseModel, *, language: str | None = None,
               mode: str | None = None, team_id: str | None = None, player_id: str | None = None) -> LogItem: ...

    def read(self, match_id: str, after_id: int = 0) -> list[LogItem]: ...

    def has(self, match_id: str) -> bool: ...
```

`services/pipeline/kickstream/ports/broadcaster.py`:

```python
from collections.abc import AsyncIterator
from typing import Protocol

from kickstream.ports.store import LogItem


class Feed(Protocol):
    def __aiter__(self) -> AsyncIterator[LogItem]: ...

    def close(self) -> None: ...


class Broadcaster(Protocol):
    def publish(self, item: LogItem) -> None: ...

    def subscribe(self, match_id: str, maxsize: int = 512) -> Feed: ...
```

`services/pipeline/kickstream/ports/clock.py`:

```python
from typing import Protocol


class Clock(Protocol):
    async def sleep(self, match_seconds: float) -> None:
        """Wait for the given amount of match time."""
```

`services/pipeline/kickstream/ports/writer.py`:

```python
from dataclasses import dataclass
from typing import Literal, Protocol

from kickstream.contracts import KeyMoment, StatsSnapshot, TeamSheet
from kickstream.domain.types import Variant


class NarrationError(Exception):
    """A writer could not produce a complete, well-formed result."""


@dataclass(frozen=True)
class MomentContext:
    moment: KeyMoment
    home: TeamSheet
    away: TeamSheet
    player_name: str | None
    stats: StatsSnapshot | None


@dataclass(frozen=True)
class RecapContext:
    match_id: str
    period: Literal["half_time", "full_time"]
    minute: int
    home: TeamSheet
    away: TeamSheet
    stats: StatsSnapshot
    moments: tuple[KeyMoment, ...]


@dataclass(frozen=True)
class WrittenText:
    text: str
    agent: str


@dataclass(frozen=True)
class WrittenRecap:
    title: str
    bullets: tuple[str, str, str]
    text: str
    agent: str


class NarrativeWriter(Protocol):
    """Writes one item in every (mode, language) variant. Localization happens inside the writer."""

    model: str

    async def write_moment(self, ctx: MomentContext) -> dict[Variant, WrittenText]: ...

    async def write_recap(self, ctx: RecapContext) -> dict[Variant, WrittenRecap]: ...
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `uv run pytest tests/test_memory_adapters.py -v`
Expected: collection error, `ModuleNotFoundError: No module named 'kickstream.adapters'`.

- [ ] **Step 5: Write the adapters**

`services/pipeline/kickstream/adapters/memory_bus.py`:

```python
import asyncio
import logging

from pydantic import BaseModel, ValidationError

from kickstream.ports.bus import BusMessage

log = logging.getLogger(__name__)
_CLOSED = object()


class _Subscription:
    def __init__(self, topics: tuple[str, ...], maxsize: int, on_close) -> None:
        self.topics = frozenset(topics)
        self.queue: asyncio.Queue = asyncio.Queue(maxsize)
        self.closed = False
        self._on_close = on_close

    def __aiter__(self):
        return self

    async def __anext__(self) -> BusMessage:
        if self.closed and self.queue.empty():
            raise StopAsyncIteration
        item = await self.queue.get()
        if item is _CLOSED:
            raise StopAsyncIteration
        return item

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self._on_close(self)
        while not self.queue.empty():
            self.queue.get_nowait()
        self.queue.put_nowait(_CLOSED)


class InMemoryEventBus:
    """Ordered, bounded, in-process pub/sub. Publishing waits when a subscriber is full."""

    def __init__(self) -> None:
        self._subscriptions: list[_Subscription] = []

    def subscribe(self, *topics: str, maxsize: int = 256) -> _Subscription:
        subscription = _Subscription(topics, maxsize, self._subscriptions.remove)
        self._subscriptions.append(subscription)
        return subscription

    async def publish(self, topic: str, match_id: str, payload: BaseModel) -> None:
        try:
            type(payload).model_validate(payload.model_dump(warnings=False))
        except ValidationError as exc:
            log.warning("dropped invalid %s on %s: %s", type(payload).__name__, topic, exc.errors()[0]["msg"])
            return
        message = BusMessage(topic, match_id, payload)
        for subscription in list(self._subscriptions):
            if topic in subscription.topics and not subscription.closed:
                await subscription.queue.put(message)
```

`services/pipeline/kickstream/adapters/memory_store.py`:

```python
from pydantic import BaseModel

from kickstream.ports.store import LogItem


class InMemoryMatchStore:
    def __init__(self) -> None:
        self._logs: dict[str, list[LogItem]] = {}

    def append(self, match_id: str, type: str, minute: int, payload: BaseModel, *, language: str | None = None,
               mode: str | None = None, team_id: str | None = None, player_id: str | None = None) -> LogItem:
        log = self._logs.setdefault(match_id, [])
        item = LogItem(id=len(log) + 1, match_id=match_id, type=type, minute=minute, payload=payload,
                       language=language, mode=mode, team_id=team_id, player_id=player_id)
        log.append(item)
        return item

    def read(self, match_id: str, after_id: int = 0) -> list[LogItem]:
        return self._logs.get(match_id, [])[max(0, after_id):]

    def has(self, match_id: str) -> bool:
        return match_id in self._logs
```

`services/pipeline/kickstream/adapters/sse_broadcaster.py`:

```python
import asyncio

from kickstream.ports.store import LogItem

_CLOSED = object()


class _Feed:
    def __init__(self, maxsize: int, on_close) -> None:
        # One extra slot so the end marker always fits after an overflow.
        self.queue: asyncio.Queue = asyncio.Queue(maxsize + 1)
        self.maxsize = maxsize
        self.closed = False
        self._on_close = on_close

    def __aiter__(self):
        return self

    async def __anext__(self) -> LogItem:
        item = await self.queue.get()
        if item is _CLOSED:
            raise StopAsyncIteration
        return item

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self._on_close(self)
        while not self.queue.empty():
            self.queue.get_nowait()
        self.queue.put_nowait(_CLOSED)


class InProcessBroadcaster:
    """Fans a match log out to connected viewers. A viewer that falls behind is disconnected."""

    def __init__(self) -> None:
        self._feeds: dict[str, list[_Feed]] = {}

    def subscribe(self, match_id: str, maxsize: int = 512) -> _Feed:
        feeds = self._feeds.setdefault(match_id, [])
        feed = _Feed(maxsize, feeds.remove)
        feeds.append(feed)
        return feed

    def publish(self, item: LogItem) -> None:
        for feed in list(self._feeds.get(item.match_id, ())):
            if feed.queue.qsize() >= feed.maxsize:
                feed.close()
            else:
                feed.queue.put_nowait(item)
```

`services/pipeline/kickstream/adapters/clocks.py`:

```python
import asyncio


class RealClock:
    def __init__(self, speed: float) -> None:
        self._speed = speed

    async def sleep(self, match_seconds: float) -> None:
        if match_seconds > 0:
            await asyncio.sleep(match_seconds / self._speed)


class InstantClock:
    """Runs a match as fast as the pipeline can absorb it. For tests."""

    async def sleep(self, match_seconds: float) -> None:
        await asyncio.sleep(0)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `uv run pytest tests/test_memory_adapters.py -v`
Expected: 10 passed.

- [ ] **Step 7: Commit**

```bash
git add services/pipeline/kickstream/ports services/pipeline/kickstream/adapters services/pipeline/tests
git commit -m "feat: add ports and in-memory bus, store, broadcaster and clocks"
```

---

### Task 4: Simulator (Ingest)

**Files:**
- Create: `services/pipeline/kickstream/simulator/__init__.py` (empty), `generate.py`, `stage.py`
- Test: `services/pipeline/tests/test_simulator.py`

**Interfaces:**
- Consumes: `MatchEvent, MatchStatus, TeamSheet`; `domain.pitch.xg`; `domain.types.SIDES, Side, other`; `ports.bus.EVENTS, STATUS, EventBus`; `ports.clock.Clock`.
- Produces:
  - `simulator.generate.generate(match_id: str, seed: int, home: TeamSheet, away: TeamSheet) -> list[MatchEvent]`. Deterministic per seed. First event `kickoff`, exactly one `half_time` at minute 45, last event `full_time` at minute 90. A `shot` with `outcome="goal"` is immediately followed by a `goal` event for the same team and player.
  - `simulator.stage.Simulator(bus: EventBus, clock: Clock)` with attribute `status: MatchStatus | None` (the latest status published) and `async play(match_id: str, events: list[MatchEvent], home: TeamSheet, away: TeamSheet, speed: float) -> None`. Publishes each event on `EVENTS` and a `MatchStatus` on `STATUS` at start, after each goal, at half-time, at the second-half kickoff and at full-time.

- [ ] **Step 1: Write the failing tests**

`services/pipeline/tests/test_simulator.py`:

```python
from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.domain.teams import AWAY, HOME
from kickstream.ports.bus import EVENTS, STATUS
from kickstream.simulator.generate import generate
from kickstream.simulator.stage import Simulator

MATCH = "m-1"


def _match(seed=11):
    return generate(MATCH, seed, HOME, AWAY)


def test_same_seed_gives_the_same_match_and_different_seeds_differ():
    assert [e.model_dump() for e in _match(11)] == [e.model_dump() for e in _match(11)]
    assert [e.model_dump() for e in _match(11)] != [e.model_dump() for e in _match(12)]


def test_match_has_a_complete_ordered_structure():
    events = _match()
    assert 300 <= len(events) <= 900
    assert events[0].type == "kickoff" and events[0].minute == 0
    assert events[-1].type == "full_time" and events[-1].minute == 90
    assert [e.seq for e in events] == list(range(1, len(events) + 1))
    assert len({e.id for e in events}) == len(events)
    times = [e.minute * 60 + e.second for e in events]
    assert times == sorted(times)
    halves = [e for e in events if e.type == "half_time"]
    assert len(halves) == 1 and halves[0].minute == 45


def test_every_event_is_on_the_pitch_and_names_a_real_player():
    known = {p.id for p in HOME.players} | {p.id for p in AWAY.players}
    for e in _match():
        assert 0 <= e.x <= 100 and 0 <= e.y <= 100
        if e.type not in ("half_time", "full_time"):
            assert e.team in ("home", "away")
            assert e.player_id in known
            prefix = HOME.id if e.team == "home" else AWAY.id
            assert e.player_id.startswith(prefix + "-")


def test_goals_follow_scoring_shots():
    events = _match()
    for index, e in enumerate(events):
        if e.type == "shot":
            assert e.outcome in ("goal", "saved", "off_target", "blocked")
        if e.type == "shot" and e.outcome == "goal":
            follow = events[index + 1]
            assert (follow.type, follow.team, follow.player_id) == ("goal", e.team, e.player_id)
    assert sum(e.type == "goal" for e in events) == sum(e.type == "shot" and e.outcome == "goal" for e in events)


def test_passes_record_completion_and_substitutions_come_from_the_bench():
    events = _match()
    assert all(e.completed is not None for e in events if e.type == "pass")
    for side, sheet in (("home", HOME), ("away", AWAY)):
        subs = [e for e in events if e.type == "substitution" and e.team == side]
        assert len(subs) <= 3
        bench = {p.id for p in sheet.players[11:]}
        assert all(e.player_in_id in bench for e in subs)
        assert len({e.player_in_id for e in subs}) == len(subs)


class RecordingClock:
    def __init__(self):
        self.slept = 0.0

    async def sleep(self, match_seconds):
        assert match_seconds >= 0
        self.slept += match_seconds


async def test_play_publishes_events_in_order_and_tracks_status():
    events = _match()
    bus, clock = InMemoryEventBus(), RecordingClock()
    subscription = bus.subscribe(EVENTS, STATUS, maxsize=5000)
    simulator = Simulator(bus, clock)
    await simulator.play(MATCH, events, HOME, AWAY, speed=30)
    messages = []
    while not subscription.queue.empty():
        messages.append(subscription.queue.get_nowait())

    published = [m.payload for m in messages if m.topic == EVENTS]
    statuses = [m.payload for m in messages if m.topic == STATUS]
    assert [e.id for e in published] == [e.id for e in events]
    assert clock.slept == 5400

    home_goals = sum(e.type == "goal" and e.team == "home" for e in events)
    away_goals = sum(e.type == "goal" and e.team == "away" for e in events)
    assert (statuses[0].state, statuses[0].score_home, statuses[0].score_away) == ("live", 0, 0)
    assert statuses[0].home == HOME and statuses[0].speed == 30
    assert "half_time" in [s.state for s in statuses]
    assert [s.state for s in statuses].index("half_time") < len(statuses) - 1
    final = statuses[-1]
    assert (final.state, final.minute, final.score_home, final.score_away) == ("finished", 90, home_goals, away_goals)
    assert simulator.status == final
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_simulator.py -v`
Expected: collection error, `ModuleNotFoundError: No module named 'kickstream.simulator'`.

- [ ] **Step 3: Write the generator**

`services/pipeline/kickstream/simulator/generate.py`:

```python
"""Generate a full synthetic match. The same seed always produces the same events.

Positions are tracked as `ax`, the distance along the attacking direction of the side
in possession (0-100), and converted to pitch coordinates when an event is emitted.
"""

import random
from dataclasses import dataclass, field

from kickstream.contracts import MatchEvent, TeamSheet
from kickstream.domain.pitch import xg
from kickstream.domain.types import SIDES, Side, other

HALF = 2700.0
FULL = 5400.0
_SHOT_WEIGHT = {"FW": 5, "MF": 3, "DF": 1}


def _clamp(value: float, low: float = 3.0, high: float = 97.0) -> float:
    return max(low, min(high, value))


@dataclass
class _Sim:
    match_id: str
    rng: random.Random
    sheets: dict[Side, TeamSheet]
    events: list[MatchEvent] = field(default_factory=list)
    on_pitch: dict[Side, list[str]] = field(default_factory=dict)
    bench: dict[Side, list[str]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for side, sheet in self.sheets.items():
            ids = [player.id for player in sheet.players]
            self.on_pitch[side], self.bench[side] = ids[:11], ids[11:]

    def _position(self, side: Side, player_id: str) -> str:
        return next(p.position for p in self.sheets[side].players if p.id == player_id)

    def keeper(self, side: Side) -> str:
        keepers = [p for p in self.on_pitch[side] if self._position(side, p) == "GK"]
        return keepers[0] if keepers else self.on_pitch[side][0]

    def outfield(self, side: Side) -> list[str]:
        return [p for p in self.on_pitch[side] if self._position(side, p) != "GK"]

    def passer(self, side: Side) -> str:
        return self.rng.choice(self.outfield(side))

    def shooter(self, side: Side) -> str:
        players = self.outfield(side)
        return self.rng.choices(players, [_SHOT_WEIGHT[self._position(side, p)] for p in players])[0]

    def emit(self, t: float, type_: str, side: Side | None = None, player_id: str | None = None,
             ax: float = 50.0, y: float = 50.0, **extra) -> None:
        seq = len(self.events) + 1
        x = 100.0 - ax if side == "away" else ax
        self.events.append(MatchEvent(
            id=f"{self.match_id}-e{seq}", match_id=self.match_id, seq=seq, minute=int(t // 60), second=int(t % 60),
            type=type_, team=side, player_id=player_id, x=round(x, 1), y=round(y, 1), **extra))

    def substitute(self, t: float, side: Side) -> None:
        if not self.bench[side] or not self.outfield(side):
            return
        leaving = self.rng.choice(self.outfield(side))
        arriving = self.bench[side].pop(0)
        self.on_pitch[side][self.on_pitch[side].index(leaving)] = arriving
        self.emit(t, "substitution", side, leaving, 50.0, 0.0, player_in_id=arriving)

    def send_off(self, side: Side, player_id: str) -> None:
        if len(self.outfield(side)) > 7:
            self.on_pitch[side].remove(player_id)


def _pass(sim: _Sim, t: float, side: Side, ax: float, y: float) -> tuple[Side, float, float]:
    completed = sim.rng.random() < 0.82
    sim.emit(t, "pass", side, sim.passer(side), ax, y, completed=completed)
    if completed:
        return side, _clamp(ax + sim.rng.uniform(-8.0, 18.0)), _clamp(y + sim.rng.uniform(-25.0, 25.0))
    return other(side), _clamp(100.0 - ax), y


def _foul(sim: _Sim, t: float, side: Side, ax: float, y: float) -> None:
    defending = other(side)
    offender = sim.passer(defending)
    sim.emit(t, "foul", defending, offender, 100.0 - ax, y)
    card = sim.rng.random()
    if card < 0.015:
        sim.emit(t, "red_card", defending, offender, 100.0 - ax, y)
        sim.send_off(defending, offender)
    elif card < 0.14:
        sim.emit(t, "yellow_card", defending, offender, 100.0 - ax, y)


def _corner(sim: _Sim, t: float, side: Side) -> tuple[Side, float, float, float]:
    sim.emit(t, "corner", side, sim.passer(side), 99.0, sim.rng.choice((1.0, 99.0)))
    return side, 88.0, sim.rng.uniform(35.0, 65.0), t


def _shot(sim: _Sim, t: float, side: Side, ax: float, y: float) -> tuple[Side, float, float, float]:
    rng, shooter, defending = sim.rng, sim.shooter(side), other(side)
    if rng.random() < xg(ax, y):
        sim.emit(t, "shot", side, shooter, ax, y, outcome="goal")
        sim.emit(t, "goal", side, shooter, 100.0, 50.0)
        boundary = HALF if t < HALF else FULL
        restart = max(t, min(t + 45.0, boundary - 1.0))
        sim.emit(restart, "kickoff", defending, sim.passer(defending))
        return defending, 50.0, 50.0, restart
    kind = rng.random()
    if kind < 0.40:
        sim.emit(t, "shot", side, shooter, ax, y, outcome="saved")
        sim.emit(t, "save", defending, sim.keeper(defending), 3.0, 50.0)
        if rng.random() < 0.30:
            return _corner(sim, t, side)
        return defending, 12.0, 50.0, t
    if kind < 0.75:
        sim.emit(t, "shot", side, shooter, ax, y, outcome="off_target")
        return defending, 10.0, 50.0, t
    sim.emit(t, "shot", side, shooter, ax, y, outcome="blocked")
    if rng.random() < 0.30:
        return _corner(sim, t, side)
    return defending, _clamp(100.0 - ax), y, t


def generate(match_id: str, seed: int, home: TeamSheet, away: TeamSheet) -> list[MatchEvent]:
    rng = random.Random(seed)
    sim = _Sim(match_id, rng, {"home": home, "away": away})
    sub_times = {side: sorted(rng.uniform(58 * 60, 82 * 60) for _ in range(3)) for side in SIDES}
    side: Side = "home"
    ax, y, t = 50.0, 50.0, 0.0
    second_half = False
    sim.emit(t, "kickoff", side, sim.passer(side))

    while True:
        t += rng.uniform(4.0, 13.0)
        if not second_half and t >= HALF:
            sim.emit(HALF, "half_time")
            second_half, side, ax, y, t = True, "away", 50.0, 50.0, HALF
            sim.emit(t, "kickoff", side, sim.passer(side))
            continue
        if t >= FULL:
            break
        for team in SIDES:
            while sub_times[team] and sub_times[team][0] <= t:
                sub_times[team].pop(0)
                sim.substitute(t, team)
        if ax >= 68.0 and rng.random() < 0.22:
            side, ax, y, t = _shot(sim, t, side, ax, y)
        elif rng.random() < 0.06:
            _foul(sim, t, side, ax, y)
            ax = _clamp(ax + rng.uniform(0.0, 6.0))
        else:
            side, ax, y = _pass(sim, t, side, ax, y)

    sim.emit(FULL, "full_time")
    return sim.events
```

- [ ] **Step 4: Write the playback stage**

`services/pipeline/kickstream/simulator/stage.py`:

```python
from kickstream.contracts import MatchEvent, MatchStatus, TeamSheet
from kickstream.ports.bus import EVENTS, STATUS, EventBus
from kickstream.ports.clock import Clock


class Simulator:
    """Releases a generated match onto the bus in match-time order."""

    def __init__(self, bus: EventBus, clock: Clock) -> None:
        self._bus = bus
        self._clock = clock
        self.status: MatchStatus | None = None

    async def play(self, match_id: str, events: list[MatchEvent], home: TeamSheet, away: TeamSheet,
                   speed: float) -> None:
        score = {"home": 0, "away": 0}

        async def publish_status(state: str, minute: int) -> None:
            self.status = MatchStatus(match_id=match_id, state=state, minute=minute, score_home=score["home"],
                                      score_away=score["away"], speed=speed, home=home, away=away)
            await self._bus.publish(STATUS, match_id, self.status)

        await publish_status("live", 0)
        previous = 0.0
        for event in events:
            at = event.minute * 60 + event.second
            await self._clock.sleep(at - previous)
            previous = at
            await self._bus.publish(EVENTS, match_id, event)
            if event.type == "goal":
                score[event.team] += 1
                await publish_status("live", event.minute)
            elif event.type == "half_time":
                await publish_status("half_time", event.minute)
            elif event.type == "kickoff" and self.status.state == "half_time":
                await publish_status("live", event.minute)
            elif event.type == "full_time":
                await publish_status("finished", event.minute)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_simulator.py -v`
Expected: 6 passed. If `test_match_has_a_complete_ordered_structure` fails on the event count, print `len(generate("m", 11, HOME, AWAY))` and fix the generator, not the bounds: 5400 seconds at 4 to 13 seconds per step must land near 640.

- [ ] **Step 6: Commit**

```bash
git add services/pipeline/kickstream/simulator services/pipeline/tests/test_simulator.py
git commit -m "feat: add deterministic match simulator and timed playback"
```

---

### Task 5: Analytics (Interpret) and the demo seed

**Files:**
- Create: `services/pipeline/kickstream/analytics/__init__.py` (empty), `state.py`, `stage.py`
- Create: `services/pipeline/kickstream/domain/demo.py`, `services/pipeline/kickstream/tools/find_demo_seed.py`
- Test: `services/pipeline/tests/test_analytics.py`, `services/pipeline/tests/test_demo_seed.py`

**Interfaces:**
- Consumes: `MatchEvent, KeyMoment, StatFact, StatsSnapshot, PressureSnapshot, TeamStats`; `domain.pitch`; `ports.bus.EVENTS, INSIGHTS, EventBus`; `tests.factories.event`.
- Produces:
  - `analytics.state.AnalyticsConfig` (dataclass; fields and defaults in Step 3).
  - `analytics.state.MatchState(match_id: str)`.
  - `analytics.state.apply(state: MatchState, event: MatchEvent, cfg: AnalyticsConfig) -> list[KeyMoment | StatsSnapshot | PressureSnapshot]`. Depends only on its arguments. Key moments come before snapshots in the returned list. A `StatsSnapshot` is returned when the match minute advances and always for `half_time` / `full_time`, with `period_end` set for those two.
  - `analytics.state.attack_pressure(state, side) -> float`, `analytics.state.momentum(state) -> float` (−1 to 1, positive for home).
  - IDs: key moments `{match_id}-k{n}`, stats `{match_id}-s{event.seq}`, pressure `{match_id}-p{event.seq}`.
  - `analytics.stage.AnalyticsStage(bus: EventBus, cfg: AnalyticsConfig | None = None)` with `async run() -> None`; subscribes to `EVENTS` in its constructor and publishes on `INSIGHTS`.
  - `domain.demo.DEMO_SEED: int`.
  - `tools.find_demo_seed.summarize(seed: int) -> tuple[int, list[KeyMoment]]` (goals, key moments).

- [ ] **Step 1: Write the failing analytics tests**

`services/pipeline/tests/test_analytics.py`:

```python
import asyncio

import pytest

from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.analytics.stage import AnalyticsStage
from kickstream.analytics.state import AnalyticsConfig, MatchState, apply, attack_pressure, momentum
from kickstream.contracts import KeyMoment, PressureSnapshot, StatsSnapshot
from kickstream.domain.pitch import xg, zone_index
from kickstream.ports.bus import EVENTS, INSIGHTS

from tests.factories import MATCH, event

CFG = AnalyticsConfig()


def run(events):
    state, out = MatchState(MATCH), []
    for e in events:
        out.extend(apply(state, e, CFG))
    return state, out


def moments(out, kind=None):
    return [o for o in out if isinstance(o, KeyMoment) and (kind is None or o.kind == kind)]


def last_stats(out):
    return [o for o in out if isinstance(o, StatsSnapshot)][-1]


def test_possession_and_pass_accuracy_come_from_passes():
    events = [event(i, "pass", "home", completed=i != 3) for i in (1, 2, 3)]
    events += [event(4, "pass", "away", completed=True), event(5, "half_time", minute=45)]
    snapshot = last_stats(run(events)[1])
    assert snapshot.home.possession == 75.0 and snapshot.away.possession == 25.0
    assert snapshot.home.passes == 3 and snapshot.home.pass_accuracy == pytest.approx(66.7)
    assert snapshot.away.pass_accuracy == 100.0


def test_possession_is_even_before_any_touch():
    snapshot = last_stats(run([event(1, "kickoff", "home")])[1])
    assert snapshot.home.possession == 50.0 and snapshot.away.possession == 50.0


def test_shots_accumulate_xg_and_only_goal_or_saved_count_on_target():
    events = [
        event(1, "shot", "home", x=90, y=50, outcome="saved"),
        event(2, "shot", "home", x=75, y=30, outcome="off_target"),
        event(3, "shot", "away", x=10, y=50, outcome="blocked"),
        event(4, "half_time", minute=45),
    ]
    snapshot = last_stats(run(events)[1])
    assert (snapshot.home.shots, snapshot.home.shots_on_target) == (2, 1)
    assert snapshot.home.xg == pytest.approx(round(xg(90, 50) + xg(75, 30), 2))
    assert snapshot.away.xg == pytest.approx(round(xg(90, 50), 2))


def test_goal_produces_a_key_moment_with_score_and_evidence():
    events = [
        event(1, "shot", "away", minute=12, x=8, y=50, outcome="goal", player_id="hbc-9"),
        event(2, "goal", "away", minute=12, x=0, y=50, player_id="hbc-9"),
    ]
    out = run(events)[1]
    [goal] = moments(out)
    assert (goal.id, goal.kind, goal.team, goal.minute) == (f"{MATCH}-k1", "goal", "away", 12)
    assert (goal.score_home, goal.score_away) == (0, 1)
    assert (goal.player_id, goal.event_id) == ("hbc-9", f"{MATCH}-e2")
    assert {f.label for f in goal.facts} == {"xg", "shots", "possession"}
    assert last_stats(out).away.goals == 1


def test_big_chance_needs_high_xg_and_no_goal():
    close = event(1, "shot", "home", x=95, y=50, outcome="saved", player_id="nbr-9")
    far = event(2, "shot", "home", x=60, y=50, outcome="saved")
    [chance] = moments(run([close, far])[1])
    assert chance.kind == "big_chance" and chance.player_id == "nbr-9"
    assert chance.facts[0].label == "xg" and chance.facts[0].value == pytest.approx(round(xg(95, 50), 2))
    assert moments(run([event(1, "shot", "home", x=95, y=50, outcome="goal")])[1]) == []


def test_red_card_reports_players_left_on_the_pitch():
    [card] = moments(run([event(1, "red_card", "away", minute=30, player_id="hbc-4")])[1])
    assert (card.kind, card.team, card.player_id) == ("red_card", "away", "hbc-4")
    assert {f.label: f.value for f in card.facts}["players_on_pitch"] == 10


def test_pressure_lands_in_the_event_zone_and_halves_every_five_minutes():
    state, _ = run([event(1, "pass", "home", x=90, y=50, completed=True)])
    zone = zone_index(90, 50)
    assert state.grid["home"][zone] == 1.0 and sum(state.grid["away"]) == 0
    apply(state, event(2, "foul", "away", minute=5), CFG)
    assert state.grid["home"][zone] == pytest.approx(0.5)


def test_momentum_is_signed_toward_the_side_pressing_in_the_final_third():
    state, _ = run([event(i, "pass", "home", second=i, x=90, completed=True) for i in range(1, 11)])
    assert attack_pressure(state, "home") > 9 and attack_pressure(state, "away") == 0
    assert momentum(state) > 0.5
    state, _ = run([event(i, "pass", "away", second=i, x=10, completed=True) for i in range(1, 11)])
    assert momentum(state) < -0.5


def _passes(side, x, start_minute, end_minute, first_seq):
    events, seq = [], first_seq
    for minute in range(start_minute, end_minute):
        for second in range(0, 60, 10):
            events.append(event(seq, "pass", side, minute=minute, second=second, x=x, completed=True))
            seq += 1
    return events


def test_sustained_pressure_fires_once_while_the_cooldown_runs():
    out = run(_passes("home", 90, 0, 8, 1))[1]
    [pressure] = moments(out, "sustained_pressure")
    assert pressure.team == "home" and pressure.player_id is None
    assert {f.label for f in pressure.facts} == {"pressure", "shots"}


def test_momentum_swing_fires_when_control_changes_sides():
    home_spell = _passes("home", 90, 0, 4, 1)
    away_spell = _passes("away", 10, 4, 14, len(home_spell) + 1)
    swings = moments(run(home_spell + away_spell)[1], "momentum_swing")
    assert len(swings) == 1 and swings[0].team == "away"
    assert {f.label for f in swings[0].facts} == {"momentum", "pressure"}


def test_snapshots_are_emitted_once_per_minute_and_at_period_ends():
    events = [event(1, "pass", "home", minute=0, completed=True), event(2, "pass", "home", minute=0, second=30, completed=True),
              event(3, "pass", "home", minute=1, completed=True), event(4, "half_time", minute=45),
              event(5, "full_time", minute=90)]
    out = run(events)[1]
    snapshots = [o for o in out if isinstance(o, StatsSnapshot)]
    assert [(s.minute, s.period_end) for s in snapshots] == [(0, None), (1, None), (45, "half_time"), (90, "full_time")]
    assert [s.id for s in snapshots] == [f"{MATCH}-s1", f"{MATCH}-s3", f"{MATCH}-s4", f"{MATCH}-s5"]
    heat = [o for o in out if isinstance(o, PressureSnapshot)]
    assert len(heat) == 4 and len(heat[0].home) == heat[0].cols * heat[0].rows == 24


def test_key_moments_precede_the_snapshot_for_the_same_event():
    out = apply(MatchState(MATCH), event(1, "goal", "home", minute=3), CFG)
    assert [type(o).__name__ for o in out] == ["KeyMoment", "StatsSnapshot", "PressureSnapshot"]


async def test_stage_publishes_insights_per_match():
    bus = InMemoryEventBus()
    insights = bus.subscribe(INSIGHTS)
    task = asyncio.create_task(AnalyticsStage(bus).run())
    await bus.publish(EVENTS, MATCH, event(1, "goal", "home", minute=3))
    await bus.publish(EVENTS, "m-2", event(1, "kickoff", "home").model_copy(update={"match_id": "m-2", "id": "m-2-e1"}))
    received = [await asyncio.wait_for(anext(aiter(insights)), 1) for _ in range(5)]
    task.cancel()
    assert [(m.match_id, type(m.payload).__name__) for m in received] == [
        (MATCH, "KeyMoment"), (MATCH, "StatsSnapshot"), (MATCH, "PressureSnapshot"),
        ("m-2", "StatsSnapshot"), ("m-2", "PressureSnapshot")]
    assert received[3].payload.home.goals == 0
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_analytics.py -v`
Expected: collection error, `ModuleNotFoundError: No module named 'kickstream.analytics'`.

- [ ] **Step 3: Write the analytics state and rules**

`services/pipeline/kickstream/analytics/state.py`:

```python
"""Per-match analytics folded over events. `apply` depends only on its arguments."""

from dataclasses import dataclass, field

from kickstream.contracts import KeyMoment, MatchEvent, PressureSnapshot, StatFact, StatsSnapshot, TeamStats
from kickstream.domain.pitch import COLS, ROWS, attacking_third, attacking_x, xg, zone_index
from kickstream.domain.types import SIDES, Side

_PRESSURE_WEIGHT = {"pass": 1.0, "corner": 3.0, "shot": 4.0, "goal": 5.0}


@dataclass(frozen=True)
class AnalyticsConfig:
    big_chance_xg: float = 0.30
    swing_strength: float = 0.35      # |momentum| at which one side is "in control"
    swing_window_min: int = 10        # control must change sides within this many minutes
    swing_cooldown_min: int = 8
    pressure_level: float = 12.0      # attacking-third pressure that counts as high
    pressure_minutes: int = 4         # how long it must be held
    pressure_cooldown_min: int = 10
    half_life_s: float = 300.0        # pressure decay


@dataclass
class _Tally:
    goals: int = 0
    shots: int = 0
    on_target: int = 0
    passes: int = 0
    completed: int = 0
    fouls: int = 0
    yellow: int = 0
    red: int = 0
    xg: float = 0.0
    touches: int = 0


def _per_side(factory):
    return field(default_factory=lambda: {side: factory() for side in SIDES})


@dataclass
class MatchState:
    match_id: str
    tally: dict[Side, _Tally] = _per_side(_Tally)
    grid: dict[Side, list[float]] = _per_side(lambda: [0.0] * (COLS * ROWS))
    clock: float = 0.0
    snapshot_minute: int = -1
    moment_count: int = 0
    strong_sign: int = 0
    strong_minute: int = -99
    last_swing_minute: int = -99
    pressure_since: dict[Side, int | None] = _per_side(lambda: None)
    last_pressure_minute: dict[Side, int] = _per_side(lambda: -99)


def attack_pressure(state: MatchState, side: Side) -> float:
    return sum(state.grid[side][zone] for zone in attacking_third(side))


def momentum(state: MatchState) -> float:
    home, away = attack_pressure(state, "home"), attack_pressure(state, "away")
    return (home - away) / (home + away + 5.0)


def _possession(state: MatchState, side: Side) -> float:
    total = sum(tally.touches for tally in state.tally.values())
    return 50.0 if total == 0 else round(state.tally[side].touches / total * 100, 1)


def _team_stats(state: MatchState, side: Side) -> TeamStats:
    tally = state.tally[side]
    accuracy = 0.0 if tally.passes == 0 else round(tally.completed / tally.passes * 100, 1)
    return TeamStats(goals=tally.goals, possession=_possession(state, side), shots=tally.shots,
                     shots_on_target=tally.on_target, passes=tally.passes, pass_accuracy=accuracy,
                     fouls=tally.fouls, yellow_cards=tally.yellow, red_cards=tally.red, xg=round(tally.xg, 2))


def _moment(state: MatchState, event: MatchEvent, kind: str, team: Side, facts: list[tuple[str, float]],
            *, from_event: bool) -> KeyMoment:
    state.moment_count += 1
    return KeyMoment(
        id=f"{state.match_id}-k{state.moment_count}", match_id=state.match_id, minute=event.minute, kind=kind,
        team=team, player_id=event.player_id if from_event else None, event_id=event.id if from_event else None,
        score_home=state.tally["home"].goals, score_away=state.tally["away"].goals,
        facts=[StatFact(label=label, value=round(value, 2)) for label, value in facts])


def _record(state: MatchState, event: MatchEvent, cfg: AnalyticsConfig) -> list[KeyMoment]:
    side = event.team
    if side is None:
        return []
    tally = state.tally[side]
    weight = _PRESSURE_WEIGHT.get(event.type)
    if weight is not None:
        state.grid[side][zone_index(event.x, event.y)] += weight

    if event.type == "pass":
        tally.passes += 1
        tally.touches += 1
        tally.completed += 1 if event.completed else 0
    elif event.type == "shot":
        chance = xg(attacking_x(side, event.x), event.y)
        tally.shots += 1
        tally.touches += 1
        tally.xg += chance
        tally.on_target += 1 if event.outcome in ("goal", "saved") else 0
        if chance >= cfg.big_chance_xg and event.outcome != "goal":
            return [_moment(state, event, "big_chance", side, [("xg", chance), ("shots", tally.shots)], from_event=True)]
    elif event.type == "goal":
        tally.goals += 1
        facts = [("xg", tally.xg), ("shots", tally.shots), ("possession", _possession(state, side))]
        return [_moment(state, event, "goal", side, facts, from_event=True)]
    elif event.type == "foul":
        tally.fouls += 1
    elif event.type == "yellow_card":
        tally.yellow += 1
    elif event.type == "red_card":
        tally.red += 1
        facts = [("players_on_pitch", 11 - tally.red), ("fouls", tally.fouls)]
        return [_moment(state, event, "red_card", side, facts, from_event=True)]
    return []


def _swing(state: MatchState, event: MatchEvent, cfg: AnalyticsConfig) -> list[KeyMoment]:
    value = momentum(state)
    sign = 1 if value >= cfg.swing_strength else -1 if value <= -cfg.swing_strength else 0
    if sign == 0:
        return []
    changed = state.strong_sign not in (0, sign)
    recent = event.minute - state.strong_minute <= cfg.swing_window_min
    rested = event.minute - state.last_swing_minute >= cfg.swing_cooldown_min
    state.strong_sign, state.strong_minute = sign, event.minute
    if not (changed and recent and rested):
        return []
    state.last_swing_minute = event.minute
    team: Side = "home" if sign > 0 else "away"
    facts = [("momentum", abs(value)), ("pressure", attack_pressure(state, team))]
    return [_moment(state, event, "momentum_swing", team, facts, from_event=False)]


def _sustained(state: MatchState, event: MatchEvent, cfg: AnalyticsConfig) -> list[KeyMoment]:
    found = []
    for side in SIDES:
        level = attack_pressure(state, side)
        if level < cfg.pressure_level:
            state.pressure_since[side] = None
            continue
        if state.pressure_since[side] is None:
            state.pressure_since[side] = event.minute
        held = event.minute - state.pressure_since[side] >= cfg.pressure_minutes
        rested = event.minute - state.last_pressure_minute[side] >= cfg.pressure_cooldown_min
        if held and rested:
            state.last_pressure_minute[side] = event.minute
            state.pressure_since[side] = event.minute
            facts = [("pressure", level), ("shots", state.tally[side].shots)]
            found.append(_moment(state, event, "sustained_pressure", side, facts, from_event=False))
    return found


def apply(state: MatchState, event: MatchEvent, cfg: AnalyticsConfig) -> list[KeyMoment | StatsSnapshot | PressureSnapshot]:
    at = event.minute * 60 + event.second
    decay = 0.5 ** (max(0.0, at - state.clock) / cfg.half_life_s)
    state.clock = at
    for side in SIDES:
        state.grid[side] = [value * decay for value in state.grid[side]]

    out: list = [*_record(state, event, cfg), *_swing(state, event, cfg), *_sustained(state, event, cfg)]

    period_end = event.type if event.type in ("half_time", "full_time") else None
    if event.minute > state.snapshot_minute or period_end:
        state.snapshot_minute = event.minute
        out.append(StatsSnapshot(
            id=f"{state.match_id}-s{event.seq}", match_id=state.match_id, minute=event.minute,
            home=_team_stats(state, "home"), away=_team_stats(state, "away"),
            momentum=round(momentum(state), 3), period_end=period_end))
        out.append(PressureSnapshot(
            id=f"{state.match_id}-p{event.seq}", match_id=state.match_id, minute=event.minute, cols=COLS, rows=ROWS,
            home=[round(v, 2) for v in state.grid["home"]], away=[round(v, 2) for v in state.grid["away"]]))
    return out
```

- [ ] **Step 4: Write the analytics stage**

`services/pipeline/kickstream/analytics/stage.py`:

```python
from kickstream.analytics.state import AnalyticsConfig, MatchState, apply
from kickstream.contracts import MatchEvent
from kickstream.ports.bus import EVENTS, INSIGHTS, EventBus


class AnalyticsStage:
    def __init__(self, bus: EventBus, cfg: AnalyticsConfig | None = None) -> None:
        self._bus = bus
        self._cfg = cfg or AnalyticsConfig()
        self._states: dict[str, MatchState] = {}
        self._events = bus.subscribe(EVENTS)

    async def run(self) -> None:
        async for message in self._events:
            if not isinstance(message.payload, MatchEvent):
                continue
            state = self._states.setdefault(message.match_id, MatchState(message.match_id))
            for insight in apply(state, message.payload, self._cfg):
                await self._bus.publish(INSIGHTS, message.match_id, insight)
```

- [ ] **Step 5: Run the analytics tests to verify they pass**

Run: `uv run pytest tests/test_analytics.py -v`
Expected: 13 passed.

- [ ] **Step 6: Write the demo seed test**

`services/pipeline/tests/test_demo_seed.py`:

```python
from kickstream.domain.demo import DEMO_SEED
from kickstream.tools.find_demo_seed import summarize


def test_demo_seed_gives_a_watchable_match():
    goals, key_moments = summarize(DEMO_SEED)
    assert 2 <= goals <= 5
    assert 10 <= len(key_moments) <= 20
    assert len({m.kind for m in key_moments}) >= 3
    assert any(m.kind == "goal" and m.minute < 45 for m in key_moments), "a first-half goal keeps the demo lively"
```

`services/pipeline/kickstream/tools/find_demo_seed.py`:

```python
"""Find a seed whose match makes a good demo. Run: python -m kickstream.tools.find_demo_seed"""

from collections import Counter

from kickstream.analytics.state import AnalyticsConfig, MatchState, apply
from kickstream.contracts import KeyMoment
from kickstream.domain.teams import AWAY, HOME
from kickstream.simulator.generate import generate


def summarize(seed: int) -> tuple[int, list[KeyMoment]]:
    events = generate("m-demo", seed, HOME, AWAY)
    state, cfg = MatchState("m-demo"), AnalyticsConfig()
    key_moments = [o for e in events for o in apply(state, e, cfg) if isinstance(o, KeyMoment)]
    return sum(e.type == "goal" for e in events), key_moments


def is_watchable(goals: int, key_moments: list[KeyMoment]) -> bool:
    return (2 <= goals <= 5 and 10 <= len(key_moments) <= 20 and len({m.kind for m in key_moments}) >= 3
            and any(m.kind == "goal" and m.minute < 45 for m in key_moments))


def main() -> None:
    counts = []
    for seed in range(1, 301):
        goals, key_moments = summarize(seed)
        counts.append(len(key_moments))
        if is_watchable(goals, key_moments):
            print(f"DEMO_SEED = {seed}  goals={goals} moments={len(key_moments)} "
                  f"kinds={dict(Counter(m.kind for m in key_moments))}")
            return
    counts.sort()
    print(f"no seed in 1..300 qualifies; key moments per match: min={counts[0]} median={counts[150]} max={counts[-1]}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 7: Choose the demo seed**

Run: `uv run python -m kickstream.tools.find_demo_seed`
Expected: one line starting `DEMO_SEED = <n>`.

Create `services/pipeline/kickstream/domain/demo.py` with the printed number (shown here with 7; use the number the tool printed):

```python
"""The seed used when a viewer starts a match without choosing one."""

DEMO_SEED = 7
```

If the tool prints `no seed in 1..300 qualifies`, the printed median shows which way the defaults are off. A median above 20 means too many key moments: raise `pressure_level` by 2 and `swing_strength` by 0.05 in `AnalyticsConfig`. A median below 10 means too few: lower each by the same amounts. Rerun the tool, then rerun `tests/test_analytics.py`, which must still pass.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `uv run pytest tests/test_demo_seed.py tests/test_analytics.py -v`
Expected: 14 passed.

- [ ] **Step 9: Commit**

```bash
git add services/pipeline/kickstream/analytics services/pipeline/kickstream/domain/demo.py services/pipeline/kickstream/tools/find_demo_seed.py services/pipeline/tests
git commit -m "feat: add match analytics, key-moment rules and demo seed"
```

---

### Task 6: Scripted narrative writer

**Files:**
- Create: `services/pipeline/kickstream/adapters/scripted_writer.py`
- Modify: `services/pipeline/tests/factories.py` (append context builders)
- Test: `services/pipeline/tests/test_scripted_writer.py`

**Interfaces:**
- Consumes: `ports.writer.MomentContext, RecapContext, WrittenText, WrittenRecap`; `domain.labels.fact_text`; `domain.types.VARIANTS`; `domain.teams.HOME, AWAY`.
- Produces:
  - `adapters.scripted_writer.ScriptedNarrativeWriter()` with `model = "scripted"`, `async write_moment(ctx) -> dict[Variant, WrittenText]` and `async write_recap(ctx) -> dict[Variant, WrittenRecap]`. Every one of the six variants is always present and non-empty; `agent` is always `"scripted"`. English fan goal text starts with `GOAL!`; English analyst goal text contains `The goal reflects the balance of play`; Spanish fan goal text starts with `¡GOL!`; the English full-time recap title starts with `Full-time:` and the Spanish one with `Final:`. The end-to-end test in Task 16 relies on these exact phrases.
  - `tests.factories.moment_ctx(**moment_fields) -> MomentContext` and `tests.factories.recap_ctx(period="half_time", minute=45) -> RecapContext`.

- [ ] **Step 1: Extend the test factories**

Append to `services/pipeline/tests/factories.py`:

```python
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
```

- [ ] **Step 2: Write the failing tests**

`services/pipeline/tests/test_scripted_writer.py`:

```python
import pytest

from kickstream.adapters.scripted_writer import ScriptedNarrativeWriter
from kickstream.domain.types import VARIANTS

from tests.factories import moment_ctx, recap_ctx

KINDS = ["goal", "red_card", "big_chance", "momentum_swing", "sustained_pressure"]


@pytest.mark.parametrize("kind", KINDS)
async def test_every_kind_is_written_in_all_six_variants(kind):
    written = await ScriptedNarrativeWriter().write_moment(moment_ctx(kind=kind))
    assert set(written) == set(VARIANTS)
    for item in written.values():
        assert item.text.strip() and item.agent == "scripted"
        assert "{" not in item.text and "}" not in item.text


async def test_goal_text_names_player_team_minute_and_score():
    written = await ScriptedNarrativeWriter().write_moment(moment_ctx(kind="goal", minute=23))
    fan = written[("fan", "en")].text
    assert fan.startswith("GOAL!")
    assert "Luca Marrowby" in fan and "Northbridge FC" in fan and "23" in fan and "1-0" in fan
    assert written[("fan", "es")].text.startswith("¡GOL!")
    assert written[("fan", "hi")].text.startswith("गोल!")


async def test_analyst_text_cites_the_localized_facts():
    written = await ScriptedNarrativeWriter().write_moment(moment_ctx(kind="goal"))
    assert "The goal reflects the balance of play: expected goals 0.42" in written[("analyst", "en")].text
    assert "goles esperados 0.42" in written[("analyst", "es")].text
    assert "अपेक्षित गोल 0.42" in written[("analyst", "hi")].text


async def test_moment_without_a_player_falls_back_to_the_team_name():
    ctx = moment_ctx(kind="red_card", player_id=None)
    assert ctx.player_name is None
    text = (await ScriptedNarrativeWriter().write_moment(ctx))[("fan", "en")].text
    assert "None" not in text and "Northbridge FC" in text


async def test_away_moments_use_the_away_team_name():
    text = (await ScriptedNarrativeWriter().write_moment(moment_ctx(kind="sustained_pressure", team="away")))[("fan", "en")].text
    assert text.startswith("Harbour City")


async def test_recap_has_title_three_bullets_and_text_in_every_variant():
    written = await ScriptedNarrativeWriter().write_recap(recap_ctx())
    assert set(written) == set(VARIANTS)
    for item in written.values():
        assert item.title.strip() and item.text.strip() and item.agent == "scripted"
        assert len(item.bullets) == 3 and all(b.strip() for b in item.bullets)
    english = written[("fan", "en")]
    assert english.title == "Half-time: Northbridge FC 2-1 Harbour City"
    assert english.bullets[0] == "Northbridge FC lead 2-1."
    assert "9-4" in english.bullets[1] and "58%-42%" in english.bullets[1]
    assert "1.7-0.6" in english.bullets[2]
    assert written[("fan", "en")].text != written[("analyst", "en")].text


async def test_full_time_titles_and_level_scores():
    written = await ScriptedNarrativeWriter().write_recap(recap_ctx(period="full_time", minute=90))
    assert written[("fan", "en")].title.startswith("Full-time:")
    assert written[("fan", "es")].title.startswith("Final:")
    assert written[("fan", "hi")].title.startswith("फुल टाइम:")

    ctx = recap_ctx()
    level = ctx.stats.model_copy(update={"away": ctx.stats.away.model_copy(update={"goals": 2})})
    from dataclasses import replace
    written = await ScriptedNarrativeWriter().write_recap(replace(ctx, stats=level))
    assert written[("fan", "en")].bullets[0] == "Northbridge FC and Harbour City are level at 2-2."
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest tests/test_scripted_writer.py -v`
Expected: collection error, `ModuleNotFoundError: No module named 'kickstream.adapters.scripted_writer'`.

- [ ] **Step 4: Write the scripted writer**

`services/pipeline/kickstream/adapters/scripted_writer.py`:

```python
"""Template-based narratives. Needs no network; used whenever the agent writer is unavailable."""

from kickstream.domain.labels import fact_text
from kickstream.domain.types import VARIANTS, Language, Mode, Variant
from kickstream.ports.writer import MomentContext, RecapContext, WrittenRecap, WrittenText

_MOMENT: dict[Language, dict[Mode, dict[str, str]]] = {
    "en": {
        "fan": {
            "goal": "GOAL! {player} scores for {team} in minute {minute}. It's {score}!",
            "red_card": "Red card! {team} are a player down after {player} is sent off in minute {minute}.",
            "big_chance": "So close! {player} had a huge chance for {team} in minute {minute}.",
            "momentum_swing": "The game is turning. {team} have taken control around minute {minute}.",
            "sustained_pressure": "{team} are camped in the final third and the pressure keeps building.",
        },
        "analyst": {
            "goal": "{team} score through {player} ({minute}'). The goal reflects the balance of play: {facts}. Score: {score}.",
            "red_card": "{player} is dismissed ({minute}'), leaving {team} short-handed. Expect a deeper block and fewer forward passes: {facts}.",
            "big_chance": "{player} gets a high-value chance for {team} ({minute}'). Chance quality: {facts}.",
            "momentum_swing": "Momentum has shifted to {team} ({minute}'). Territory and shot volume now favor them: {facts}.",
            "sustained_pressure": "{team} have held high pressure in the attacking third for several minutes ({minute}'): {facts}.",
        },
    },
    "es": {
        "fan": {
            "goal": "¡GOL! {player} marca para {team} en el minuto {minute}. ¡{score}!",
            "red_card": "¡Tarjeta roja! {team} se queda con uno menos tras la expulsión de {player} en el minuto {minute}.",
            "big_chance": "¡Qué cerca! {player} tuvo una ocasión clarísima para {team} en el minuto {minute}.",
            "momentum_swing": "El partido está cambiando. {team} toma el control hacia el minuto {minute}.",
            "sustained_pressure": "{team} está instalado en el último tercio y la presión no deja de crecer.",
        },
        "analyst": {
            "goal": "{team} marca por medio de {player} ({minute}'). El gol refleja el desarrollo del juego: {facts}. Marcador: {score}.",
            "red_card": "{player} es expulsado ({minute}') y {team} queda en inferioridad. Es previsible un bloque más bajo y menos pases hacia adelante: {facts}.",
            "big_chance": "{player} dispone de una ocasión de alto valor para {team} ({minute}'). Calidad de la ocasión: {facts}.",
            "momentum_swing": "El impulso ha pasado a {team} ({minute}'). El territorio y el volumen de remates ahora le favorecen: {facts}.",
            "sustained_pressure": "{team} ha mantenido una presión alta en el tercio de ataque durante varios minutos ({minute}'): {facts}.",
        },
    },
    "hi": {
        "fan": {
            "goal": "गोल! {player} ने {minute}वें मिनट में {team} के लिए गोल किया। स्कोर {score}!",
            "red_card": "रेड कार्ड! {minute}वें मिनट में {player} को बाहर भेजा गया, {team} अब एक खिलाड़ी कम है।",
            "big_chance": "बहुत करीब! {minute}वें मिनट में {player} के पास {team} के लिए बड़ा मौका था।",
            "momentum_swing": "मैच का रुख बदल रहा है। {minute}वें मिनट के आसपास {team} ने नियंत्रण ले लिया है।",
            "sustained_pressure": "{team} लगातार आखिरी तिहाई में डटी है और दबाव बढ़ता जा रहा है।",
        },
        "analyst": {
            "goal": "{team} ने {player} के ज़रिए गोल किया ({minute}')। यह गोल खेल के संतुलन को दर्शाता है: {facts}। स्कोर: {score}।",
            "red_card": "{player} को बाहर भेजा गया ({minute}'), {team} एक खिलाड़ी कम है। अब गहरी रक्षा पंक्ति और कम आगे के पास की उम्मीद है: {facts}।",
            "big_chance": "{player} को {team} के लिए उच्च गुणवत्ता का मौका मिला ({minute}')। मौके की गुणवत्ता: {facts}।",
            "momentum_swing": "खेल की गति अब {team} के पक्ष में है ({minute}')। क्षेत्र और शॉट की संख्या अब उनके पक्ष में है: {facts}।",
            "sustained_pressure": "{team} ने कई मिनटों से आक्रमण क्षेत्र में ऊँचा दबाव बनाए रखा है ({minute}'): {facts}।",
        },
    },
}

_RECAP: dict[Language, dict[str, str]] = {
    "en": {
        "half_time": "Half-time", "full_time": "Full-time",
        "lead": "{leader} lead {score}.", "level": "{home} and {away} are level at {score}.",
        "shots": "Shots {home_shots}-{away_shots}, possession {home_poss}%-{away_poss}%.",
        "xg": "Expected goals {home_xg}-{away_xg}.",
        "moments": "{count} key moments so far.",
    },
    "es": {
        "half_time": "Descanso", "full_time": "Final",
        "lead": "{leader} gana {score}.", "level": "{home} y {away} empatan {score}.",
        "shots": "Remates {home_shots}-{away_shots}, posesión {home_poss}%-{away_poss}%.",
        "xg": "Goles esperados {home_xg}-{away_xg}.",
        "moments": "{count} momentos clave hasta ahora.",
    },
    "hi": {
        "half_time": "हाफ टाइम", "full_time": "फुल टाइम",
        "lead": "{leader} {score} से आगे है।", "level": "{home} और {away} {score} से बराबरी पर हैं।",
        "shots": "शॉट {home_shots}-{away_shots}, कब्ज़ा {home_poss}%-{away_poss}%।",
        "xg": "अपेक्षित गोल {home_xg}-{away_xg}।",
        "moments": "अब तक {count} अहम पल।",
    },
}


def _percent(value: float) -> str:
    return str(round(value))


class ScriptedNarrativeWriter:
    model = "scripted"

    async def write_moment(self, ctx: MomentContext) -> dict[Variant, WrittenText]:
        moment = ctx.moment
        team = (ctx.home if moment.team == "home" else ctx.away).name
        values = dict(team=team, player=ctx.player_name or team, minute=moment.minute,
                      score=f"{moment.score_home}-{moment.score_away}")
        return {
            (mode, language): WrittenText(
                _MOMENT[language][mode][moment.kind].format(**values, facts=fact_text(moment.facts, language)),
                "scripted")
            for mode, language in VARIANTS
        }

    async def write_recap(self, ctx: RecapContext) -> dict[Variant, WrittenRecap]:
        home, away = ctx.stats.home, ctx.stats.away
        score = f"{home.goals}-{away.goals}"
        leader = None if home.goals == away.goals else (ctx.home.name if home.goals > away.goals else ctx.away.name)
        values = dict(home=ctx.home.name, away=ctx.away.name, score=score, leader=leader,
                      home_shots=home.shots, away_shots=away.shots,
                      home_poss=_percent(home.possession), away_poss=_percent(away.possession),
                      home_xg=home.xg, away_xg=away.xg, count=len(ctx.moments))
        written = {}
        for mode, language in VARIANTS:
            strings = _RECAP[language]
            headline = strings["level" if leader is None else "lead"].format(**values)
            shots, expected = strings["shots"].format(**values), strings["xg"].format(**values)
            title = f"{strings[ctx.period]}: {ctx.home.name} {score} {ctx.away.name}"
            closing = strings["moments"].format(**values) if mode == "fan" else f"{shots} {expected}"
            written[(mode, language)] = WrittenRecap(title, (headline, shots, expected), f"{headline} {closing}", "scripted")
        return written
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_scripted_writer.py -v`
Expected: 11 passed.

- [ ] **Step 6: Commit**

```bash
git add services/pipeline/kickstream/adapters/scripted_writer.py services/pipeline/tests
git commit -m "feat: add scripted narrative writer in three languages"
```

---

### Task 7: Narration service and stage (Explain)

**Files:**
- Create: `services/pipeline/kickstream/narration/__init__.py` (empty), `budget.py`, `cache.py`, `service.py`, `stage.py`
- Modify: `services/pipeline/tests/factories.py` (append `FakeWriter`)
- Test: `services/pipeline/tests/test_narration_service.py`, `services/pipeline/tests/test_narration_stage.py`

**Interfaces:**
- Consumes: `ports.writer.*`; `ports.bus.STATUS, INSIGHTS, NARRATIVES, EventBus`; contracts `Narrative, Recap, KeyMoment, StatsSnapshot, MatchStatus`; `domain.teams.find_player`; `domain.types.VARIANTS`.
- Produces:
  - `narration.budget.Budget(max_calls: int, reserve: int, min_gap_s: float, now: Callable[[], float] = time.monotonic)` with `try_spend(match_id: str, cost: int, priority: bool) -> bool`.
  - `narration.cache.DiskCache(directory: Path)` with `get(key: str) -> dict | None` and `put(key: str, value: dict) -> None`.
  - `narration.service.NarrationService(fallback: NarrativeWriter, primary: NarrativeWriter | None = None, budget: Budget | None = None, cache: DiskCache | None = None, timeout_s: float = 20.0)` with `async moment(ctx: MomentContext) -> list[Narrative]`, `async recap(ctx: RecapContext) -> list[Recap]`, `async scripted_moment(ctx: MomentContext) -> list[Narrative]`. Each returns six items, one per variant. Constants `MOMENT_COST = 3`, `RECAP_COST = 2`.
  - IDs: narrative `{moment.id}-{mode}-{language}`; recap `{match_id}-r-{period}-{mode}-{language}`.
  - `narration.stage.NarrationStage(bus: EventBus, service: NarrationService, max_pending: int = 4)` with `async run() -> None`; subscribes to `STATUS` and `INSIGHTS` in its constructor and publishes `Narrative` and `Recap` on `NARRATIVES`.
  - `tests.factories.FakeWriter(fail: Exception | None = None, delay: float = 0.0, drop: Variant | None = None, blank: Variant | None = None, gate: asyncio.Event | None = None)` with `model = "fake-model"` and a `calls` counter.

- [ ] **Step 1: Add the fake writer to the test factories**

Append to `services/pipeline/tests/factories.py`:

```python
import asyncio  # noqa: E402

from kickstream.domain.types import VARIANTS  # noqa: E402
from kickstream.ports.writer import WrittenRecap, WrittenText  # noqa: E402


class FakeWriter:
    """Stands in for the agent writer. Can fail, stall, or return an incomplete result."""

    model = "fake-model"

    def __init__(self, fail=None, delay=0.0, drop=None, blank=None, gate=None):
        self.fail, self.delay, self.drop, self.blank, self.gate = fail, delay, drop, blank, gate
        self.calls = 0

    async def _run(self, make):
        self.calls += 1
        if self.gate is not None:
            await self.gate.wait()
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail is not None:
            raise self.fail
        written = {variant: make(variant, "" if variant == self.blank else f"{variant[0]}-{variant[1]} text")
                   for variant in VARIANTS}
        written.pop(self.drop, None)
        return written

    async def write_moment(self, ctx):
        return await self._run(lambda v, text: WrittenText(text, "commentator" if v[0] == "fan" else "tactical_analyst"))

    async def write_recap(self, ctx):
        return await self._run(lambda v, text: WrittenRecap(text, (text, text, text), text, "recap_writer"))
```

- [ ] **Step 2: Write the failing service tests**

`services/pipeline/tests/test_narration_service.py`:

```python
import pytest

from kickstream.adapters.scripted_writer import ScriptedNarrativeWriter
from kickstream.domain.types import VARIANTS
from kickstream.narration.budget import Budget
from kickstream.narration.cache import DiskCache
from kickstream.narration.service import MOMENT_COST, RECAP_COST, NarrationService
from kickstream.ports.writer import NarrationError

from tests.factories import MATCH, FakeWriter, moment_ctx, recap_ctx


def service(primary=None, **kwargs):
    return NarrationService(ScriptedNarrativeWriter(), primary, **kwargs)


def sources(items):
    return {item.source for item in items}


async def test_without_a_primary_writer_everything_is_scripted():
    narratives = await service().moment(moment_ctx(kind="goal", minute=23))
    assert {(n.mode, n.language) for n in narratives} == set(VARIANTS)
    assert sources(narratives) == {"scripted"} and {n.agent for n in narratives} == {"scripted"}
    first = next(n for n in narratives if (n.mode, n.language) == ("fan", "en"))
    assert first.id == f"{MATCH}-k1-fan-en" and first.moment_id == f"{MATCH}-k1" and first.minute == 23
    assert first.evidence == [f"{MATCH}-k1", f"{MATCH}-e40", f"{MATCH}-s23"]
    assert (first.team, first.player_id) == ("home", "nbr-9")


async def test_primary_writer_output_is_used_and_attributed():
    primary = FakeWriter()
    narratives = await service(primary).moment(moment_ctx())
    assert sources(narratives) == {"agent"}
    assert {n.agent for n in narratives if n.mode == "fan"} == {"commentator"}
    assert {n.agent for n in narratives if n.mode == "analyst"} == {"tactical_analyst"}
    assert next(n for n in narratives if (n.mode, n.language) == ("analyst", "hi")).text == "analyst-hi text"


async def test_cache_replays_without_calling_the_writer_or_spending_budget(tmp_path):
    primary, budget = FakeWriter(), Budget(max_calls=MOMENT_COST, reserve=0, min_gap_s=0)
    cached = service(primary, cache=DiskCache(tmp_path), budget=budget)
    first = await cached.moment(moment_ctx())
    second = await cached.moment(moment_ctx())
    assert primary.calls == 1
    assert [n.model_dump() for n in first] == [n.model_dump() for n in second]
    assert sources(second) == {"agent"}
    assert sources(await cached.moment(moment_ctx(n=2, minute=50))) == {"scripted"}, "budget is spent"


async def test_cache_key_depends_on_the_model_name(tmp_path):
    cache, other = DiskCache(tmp_path), FakeWriter()
    other.model = "another-model"
    await service(FakeWriter(), cache=cache).moment(moment_ctx())
    await service(other, cache=cache).moment(moment_ctx())
    assert other.calls == 1


@pytest.mark.parametrize("primary", [
    FakeWriter(fail=NarrationError("malformed")),
    FakeWriter(fail=RuntimeError("rate limited")),
    FakeWriter(drop=("fan", "hi")),
    FakeWriter(blank=("analyst", "es")),
], ids=["narration-error", "provider-error", "missing-variant", "blank-variant"])
async def test_any_incomplete_or_failed_result_falls_back_whole(primary, tmp_path):
    cache = DiskCache(tmp_path)
    narratives = await service(primary, cache=cache).moment(moment_ctx())
    assert len(narratives) == 6 and sources(narratives) == {"scripted"}
    assert all(n.text.strip() for n in narratives)
    assert list(tmp_path.iterdir()) == [], "a failed result must not be cached"


async def test_a_slow_writer_times_out_to_scripted():
    narratives = await service(FakeWriter(delay=0.5), timeout_s=0.01).moment(moment_ctx())
    assert sources(narratives) == {"scripted"}


async def test_an_unreadable_cache_entry_is_ignored(tmp_path):
    primary, cache = FakeWriter(), DiskCache(tmp_path)
    await service(primary, cache=cache).moment(moment_ctx())
    [entry] = tmp_path.iterdir()
    entry.write_text('{"fan:en": {"wrong": 1}}', encoding="utf-8")
    assert sources(await service(primary, cache=cache).moment(moment_ctx())) == {"agent"}
    assert primary.calls == 2


async def test_recap_builds_six_recaps_with_score_and_ids():
    recaps = await service(FakeWriter()).recap(recap_ctx(period="full_time", minute=90))
    assert {(r.mode, r.language) for r in recaps} == set(VARIANTS)
    first = next(r for r in recaps if (r.mode, r.language) == ("fan", "en"))
    assert first.id == f"{MATCH}-r-full_time-fan-en"
    assert (first.period, first.minute, first.score_home, first.score_away) == ("full_time", 90, 2, 1)
    assert first.source == "agent" and first.agent == "recap_writer" and len(first.bullets) == 3


async def test_recap_with_a_blank_bullet_falls_back():
    class BlankBullet(FakeWriter):
        async def write_recap(self, ctx):
            written = await super().write_recap(ctx)
            item = written[("fan", "en")]
            written[("fan", "en")] = type(item)(item.title, ("a", " ", "c"), item.text, item.agent)
            return written

    assert sources(await service(BlankBullet()).recap(recap_ctx())) == {"scripted"}


async def test_scripted_moment_never_touches_the_primary_writer():
    primary = FakeWriter()
    assert sources(await service(primary).scripted_moment(moment_ctx())) == {"scripted"}
    assert primary.calls == 0


def test_budget_caps_calls_per_match():
    budget = Budget(max_calls=5, reserve=0, min_gap_s=0)
    assert budget.try_spend("a", MOMENT_COST, priority=True)
    assert not budget.try_spend("a", MOMENT_COST, priority=True)
    assert budget.try_spend("a", RECAP_COST, priority=True)
    assert budget.try_spend("b", MOMENT_COST, priority=True), "each match has its own budget"


def test_budget_keeps_a_reserve_for_goals_and_recaps():
    budget = Budget(max_calls=9, reserve=6, min_gap_s=0)
    assert budget.try_spend("a", MOMENT_COST, priority=False)
    assert not budget.try_spend("a", MOMENT_COST, priority=False), "would eat into the reserve"
    assert budget.try_spend("a", MOMENT_COST, priority=True)
    assert budget.try_spend("a", MOMENT_COST, priority=True)
    assert not budget.try_spend("a", RECAP_COST, priority=True)


def test_budget_spaces_out_non_priority_calls():
    clock = [100.0]
    budget = Budget(max_calls=100, reserve=0, min_gap_s=5, now=lambda: clock[0])
    assert budget.try_spend("a", MOMENT_COST, priority=False)
    clock[0] = 103.0
    assert not budget.try_spend("a", MOMENT_COST, priority=False)
    assert budget.try_spend("a", MOMENT_COST, priority=True), "goals and recaps ignore the gap"
    clock[0] = 108.5
    assert budget.try_spend("a", MOMENT_COST, priority=False)


def test_disk_cache_round_trips_and_tolerates_missing_or_corrupt_files(tmp_path):
    cache = DiskCache(tmp_path / "nested")
    assert cache.get("absent") is None
    cache.put("k", {"fan:hi": {"text": "गोल!", "agent": "commentator"}})
    assert cache.get("k") == {"fan:hi": {"text": "गोल!", "agent": "commentator"}}
    (tmp_path / "nested" / "k.json").write_text("{not json", encoding="utf-8")
    assert cache.get("k") is None
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest tests/test_narration_service.py -v`
Expected: collection error, `ModuleNotFoundError: No module named 'kickstream.narration'`.

- [ ] **Step 4: Write the budget and cache**

`services/pipeline/kickstream/narration/budget.py`:

```python
import time
from collections.abc import Callable


class Budget:
    """Bounds model calls per match. Goals and recaps (priority) are served first."""

    def __init__(self, max_calls: int, reserve: int, min_gap_s: float,
                 now: Callable[[], float] = time.monotonic) -> None:
        self._max_calls = max_calls
        self._reserve = reserve
        self._min_gap_s = min_gap_s
        self._now = now
        self._used: dict[str, int] = {}
        self._last: dict[str, float] = {}

    def try_spend(self, match_id: str, cost: int, priority: bool) -> bool:
        remaining = self._max_calls - self._used.get(match_id, 0)
        if cost > remaining:
            return False
        if not priority:
            if remaining - cost < self._reserve:
                return False
            last = self._last.get(match_id)
            if last is not None and self._now() - last < self._min_gap_s:
                return False
        self._used[match_id] = self._used.get(match_id, 0) + cost
        self._last[match_id] = self._now()
        return True
```

`services/pipeline/kickstream/narration/cache.py`:

```python
import json
from pathlib import Path


class DiskCache:
    """One JSON file per key. Replaying a seeded match reuses earlier model output."""

    def __init__(self, directory: Path) -> None:
        self._directory = Path(directory)
        self._directory.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        return self._directory / f"{key}.json"

    def get(self, key: str) -> dict | None:
        try:
            value = json.loads(self._path(key).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return value if isinstance(value, dict) else None

    def put(self, key: str, value: dict) -> None:
        temporary = self._path(key).with_suffix(".tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        temporary.replace(self._path(key))
```

- [ ] **Step 5: Write the service**

`services/pipeline/kickstream/narration/service.py`:

```python
"""Chooses between the agent writer and the scripted writer for each item.

Order of preference: cached agent output, a fresh agent call if the budget allows,
then scripted text. Any failure or incomplete result falls back for the whole item.
"""

import asyncio
import dataclasses
import hashlib
import json
import logging

from pydantic import BaseModel

from kickstream.contracts import Narrative, Recap
from kickstream.domain.types import VARIANTS
from kickstream.narration.budget import Budget
from kickstream.narration.cache import DiskCache
from kickstream.ports.writer import (MomentContext, NarrationError, NarrativeWriter, RecapContext, WrittenRecap,
                                     WrittenText)

log = logging.getLogger(__name__)
MOMENT_COST = 3  # commentator + tactical analyst + localizer
RECAP_COST = 2   # recap writer + localizer


def _plain(value):
    if isinstance(value, BaseModel):
        return value.model_dump()
    if dataclasses.is_dataclass(value):
        return {f.name: _plain(getattr(value, f.name)) for f in dataclasses.fields(value)}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return value


def _cache_key(model: str, kind: str, ctx) -> str:
    # The prompt is a pure function of the context, so hashing the context is hashing the prompt.
    canonical = json.dumps(_plain(ctx), sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(f"{model}\n{kind}\n{canonical}".encode()).hexdigest()


def _encode(written: dict) -> dict:
    return {f"{mode}:{language}": dataclasses.asdict(item) for (mode, language), item in written.items()}


def _decode(kind: str, raw: dict) -> dict:
    written = {}
    for key, item in raw.items():
        mode, language = key.split(":")
        if kind == "moment":
            written[(mode, language)] = WrittenText(item["text"], item["agent"])
        else:
            written[(mode, language)] = WrittenRecap(item["title"], tuple(item["bullets"]), item["text"], item["agent"])
    return written


def _require_complete(written: dict) -> None:
    for variant in VARIANTS:
        item = written.get(variant)
        if item is None:
            raise NarrationError(f"missing variant {variant}")
        parts = [item.text]
        if isinstance(item, WrittenRecap):
            if len(item.bullets) != 3:
                raise NarrationError(f"recap {variant} needs three bullets")
            parts += [item.title, *item.bullets]
        if not all(isinstance(part, str) and part.strip() for part in parts):
            raise NarrationError(f"blank text in variant {variant}")


class NarrationService:
    def __init__(self, fallback: NarrativeWriter, primary: NarrativeWriter | None = None,
                 budget: Budget | None = None, cache: DiskCache | None = None, timeout_s: float = 20.0) -> None:
        self._fallback = fallback
        self._primary = primary
        self._budget = budget
        self._cache = cache
        self._timeout_s = timeout_s

    async def moment(self, ctx: MomentContext) -> list[Narrative]:
        written, source = await self._write("moment", ctx.moment.match_id, ctx, MOMENT_COST, ctx.moment.kind == "goal")
        return self._narratives(ctx, written, source)

    async def scripted_moment(self, ctx: MomentContext) -> list[Narrative]:
        return self._narratives(ctx, await self._fallback.write_moment(ctx), "scripted")

    async def recap(self, ctx: RecapContext) -> list[Recap]:
        written, source = await self._write("recap", ctx.match_id, ctx, RECAP_COST, True)
        return [
            Recap(id=f"{ctx.match_id}-r-{ctx.period}-{mode}-{language}", match_id=ctx.match_id, minute=ctx.minute,
                  period=ctx.period, mode=mode, language=language, title=item.title.strip(),
                  bullets=[bullet.strip() for bullet in item.bullets], text=item.text.strip(), source=source,
                  agent=item.agent, score_home=ctx.stats.home.goals, score_away=ctx.stats.away.goals)
            for (mode, language), item in ((variant, written[variant]) for variant in VARIANTS)
        ]

    def _narratives(self, ctx: MomentContext, written: dict, source: str) -> list[Narrative]:
        moment = ctx.moment
        evidence = [moment.id, *([moment.event_id] if moment.event_id else []), *([ctx.stats.id] if ctx.stats else [])]
        return [
            Narrative(id=f"{moment.id}-{mode}-{language}", match_id=moment.match_id, minute=moment.minute,
                      moment_id=moment.id, mode=mode, language=language, text=written[(mode, language)].text.strip(),
                      source=source, agent=written[(mode, language)].agent, evidence=evidence, team=moment.team,
                      player_id=moment.player_id)
            for mode, language in VARIANTS
        ]

    async def _write(self, kind: str, match_id: str, ctx, cost: int, priority: bool) -> tuple[dict, str]:
        if self._primary is not None:
            key = _cache_key(self._primary.model, kind, ctx)
            cached = self._cache.get(key) if self._cache else None
            if cached is not None:
                try:
                    written = _decode(kind, cached)
                    _require_complete(written)
                    return written, "agent"
                except (KeyError, TypeError, ValueError, NarrationError):
                    log.warning("ignoring unreadable narration cache entry %s", key)
            if self._budget is None or self._budget.try_spend(match_id, cost, priority):
                try:
                    call = self._primary.write_moment(ctx) if kind == "moment" else self._primary.write_recap(ctx)
                    written = await asyncio.wait_for(call, self._timeout_s)
                    _require_complete(written)
                    if self._cache:
                        self._cache.put(key, _encode(written))
                    return written, "agent"
                except Exception as exc:  # noqa: BLE001 - every model failure falls back to scripted text
                    log.warning("agent writer failed for %s in %s (%s); using scripted text", kind, match_id, exc)
        call = self._fallback.write_moment(ctx) if kind == "moment" else self._fallback.write_recap(ctx)
        return await call, "scripted"
```

- [ ] **Step 6: Run the service tests to verify they pass**

Run: `uv run pytest tests/test_narration_service.py -v`
Expected: 17 passed.

- [ ] **Step 7: Write the failing stage tests**

`services/pipeline/tests/test_narration_stage.py`:

```python
import asyncio

from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.adapters.scripted_writer import ScriptedNarrativeWriter
from kickstream.contracts import MatchStatus, Narrative, Recap
from kickstream.domain.teams import AWAY, HOME
from kickstream.narration.service import NarrationService
from kickstream.narration.stage import NarrationStage
from kickstream.ports.bus import INSIGHTS, NARRATIVES, STATUS

from tests.factories import MATCH, FakeWriter, moment, stats, team_stats

STATUS_LIVE = MatchStatus(match_id=MATCH, state="live", minute=0, score_home=0, score_away=0, speed=30,
                          home=HOME, away=AWAY)


async def start(primary=None, max_pending=4):
    bus = InMemoryEventBus()
    out = bus.subscribe(NARRATIVES, maxsize=1000)
    stage = NarrationStage(bus, NarrationService(ScriptedNarrativeWriter(), primary), max_pending=max_pending)
    task = asyncio.create_task(stage.run())
    await bus.publish(STATUS, MATCH, STATUS_LIVE)
    return bus, out, task


async def take(out, count):
    return [(await asyncio.wait_for(anext(aiter(out)), 2)).payload for _ in range(count)]


async def test_a_key_moment_becomes_six_narratives_with_the_player_named():
    bus, out, task = await start()
    await bus.publish(INSIGHTS, MATCH, stats(minute=9))
    await bus.publish(INSIGHTS, MATCH, moment(1, player_id="nbr-9"))
    narratives = await take(out, 6)
    task.cancel()
    assert all(isinstance(n, Narrative) for n in narratives)
    english = next(n for n in narratives if (n.mode, n.language) == ("fan", "en"))
    assert "Luca Marrowby" in english.text
    assert english.evidence == [f"{MATCH}-k1", f"{MATCH}-s9"], "cites the latest stats snapshot"


async def test_a_period_end_snapshot_becomes_six_recaps_over_the_moments_so_far():
    bus, out, task = await start()
    await bus.publish(INSIGHTS, MATCH, moment(1))
    await take(out, 6)
    await bus.publish(INSIGHTS, MATCH, stats(minute=45, period_end="half_time", home=team_stats(goals=1)))
    recaps = await take(out, 6)
    task.cancel()
    assert all(isinstance(r, Recap) and r.period == "half_time" for r in recaps)
    english = next(r for r in recaps if (r.mode, r.language) == ("fan", "en"))
    assert english.score_home == 1 and "1 key moments" in english.text


async def test_ordinary_snapshots_do_not_produce_recaps():
    bus, out, task = await start()
    await bus.publish(INSIGHTS, MATCH, stats(minute=12))
    await bus.publish(INSIGHTS, MATCH, moment(1))
    assert all(isinstance(n, Narrative) for n in await take(out, 6))
    task.cancel()


async def test_when_the_queue_is_full_the_oldest_waiting_moment_is_scripted():
    gate = asyncio.Event()
    bus, out, task = await start(primary=FakeWriter(gate=gate), max_pending=4)
    for n in range(1, 7):
        await bus.publish(INSIGHTS, MATCH, moment(n, minute=n))
        await asyncio.sleep(0.01)
    early = await take(out, 6)
    assert {n.moment_id for n in early} == {f"{MATCH}-k2"}, "k1 is being written; k2 is the oldest waiting"
    assert {n.source for n in early} == {"scripted"}
    gate.set()
    rest = await take(out, 30)
    task.cancel()
    assert {n.moment_id for n in rest} == {f"{MATCH}-k{n}" for n in (1, 3, 4, 5, 6)}
    assert {n.source for n in rest} == {"agent"}


async def test_a_waiting_goal_is_spared_while_a_lesser_moment_can_be_evicted():
    gate = asyncio.Event()
    bus, out, task = await start(primary=FakeWriter(gate=gate), max_pending=2)
    kinds = ["big_chance", "goal", "sustained_pressure", "big_chance"]
    for n, kind in enumerate(kinds, start=1):
        await bus.publish(INSIGHTS, MATCH, moment(n, kind=kind, minute=n))
        await asyncio.sleep(0.01)
    early = await take(out, 6)
    assert {n.moment_id for n in early} == {f"{MATCH}-k3"}, "k1 is being written; k2 is a goal; k3 is evicted"
    gate.set()
    rest = await take(out, 18)
    task.cancel()
    assert {n.source for n in rest if n.moment_id == f"{MATCH}-k2"} == {"agent"}


async def test_a_moment_for_an_unknown_match_is_skipped_without_stopping_the_stage():
    bus, out, task = await start()
    stray = moment(1).model_copy(update={"match_id": "m-9", "id": "m-9-k1"})
    await bus.publish(INSIGHTS, "m-9", stray)
    await bus.publish(INSIGHTS, MATCH, moment(2))
    narratives = await take(out, 6)
    task.cancel()
    assert {n.moment_id for n in narratives} == {f"{MATCH}-k2"}
```

- [ ] **Step 8: Run the stage tests to verify they fail**

Run: `uv run pytest tests/test_narration_stage.py -v`
Expected: collection error, `ModuleNotFoundError: No module named 'kickstream.narration.stage'`.

- [ ] **Step 9: Write the stage**

`services/pipeline/kickstream/narration/stage.py`:

```python
import asyncio
import logging
from collections import deque
from dataclasses import dataclass

from kickstream.contracts import KeyMoment, MatchStatus, StatsSnapshot, TeamSheet
from kickstream.domain.teams import find_player
from kickstream.narration.service import NarrationService
from kickstream.ports.bus import INSIGHTS, NARRATIVES, STATUS, EventBus
from kickstream.ports.writer import MomentContext, RecapContext

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class _Job:
    kind: str  # "moment" or "recap"
    ctx: MomentContext | RecapContext


class NarrationStage:
    """Turns key moments and period ends into narratives, one item at a time.

    Narration is slower than the match. When more than `max_pending` moments are waiting,
    the oldest one is written from templates so the feed stays current. Goals keep their
    place in the queue while any other kind of moment is waiting.
    """

    def __init__(self, bus: EventBus, service: NarrationService, max_pending: int = 4) -> None:
        self._bus = bus
        self._service = service
        self._max_pending = max_pending
        self._messages = bus.subscribe(STATUS, INSIGHTS)
        self._pending: deque[_Job] = deque()
        self._wake = asyncio.Event()
        self._teams: dict[str, tuple[TeamSheet, TeamSheet]] = {}
        self._stats: dict[str, StatsSnapshot] = {}
        self._moments: dict[str, list[KeyMoment]] = {}

    async def run(self) -> None:
        worker = asyncio.create_task(self._work())
        try:
            async for message in self._messages:
                await self._intake(message.match_id, message.payload)
        finally:
            worker.cancel()

    async def _intake(self, match_id: str, payload) -> None:
        if isinstance(payload, MatchStatus):
            self._teams[match_id] = (payload.home, payload.away)
            return
        if match_id not in self._teams:
            log.warning("no team sheets for match %s; skipping %s", match_id, type(payload).__name__)
            return
        home, away = self._teams[match_id]
        if isinstance(payload, KeyMoment):
            self._moments.setdefault(match_id, []).append(payload)
            player = find_player((home, away), payload.player_id)
            ctx = MomentContext(moment=payload, home=home, away=away, player_name=player.name if player else None,
                                stats=self._stats.get(match_id))
            await self._enqueue(_Job("moment", ctx))
        elif isinstance(payload, StatsSnapshot):
            self._stats[match_id] = payload
            if payload.period_end:
                ctx = RecapContext(match_id=match_id, period=payload.period_end, minute=payload.minute, home=home,
                                   away=away, stats=payload, moments=tuple(self._moments.get(match_id, ())))
                await self._enqueue(_Job("recap", ctx))

    async def _enqueue(self, job: _Job) -> None:
        waiting = [pending for pending in self._pending if pending.kind == "moment"]
        if job.kind == "moment" and len(waiting) >= self._max_pending:
            # Evict the oldest waiting moment, sparing goals while anything lesser is waiting.
            evicted = next((pending for pending in waiting if pending.ctx.moment.kind != "goal"), waiting[0])
            self._pending.remove(evicted)
            await self._publish(evicted.ctx.moment.match_id, await self._service.scripted_moment(evicted.ctx))
        self._pending.append(job)
        self._wake.set()

    async def _work(self) -> None:
        while True:
            await self._wake.wait()
            while self._pending:
                job = self._pending.popleft()
                try:
                    if job.kind == "moment":
                        await self._publish(job.ctx.moment.match_id, await self._service.moment(job.ctx))
                    else:
                        await self._publish(job.ctx.match_id, await self._service.recap(job.ctx))
                except Exception:  # noqa: BLE001 - one bad item must not stop narration
                    log.exception("narration failed for a %s", job.kind)
            self._wake.clear()

    async def _publish(self, match_id: str, items: list) -> None:
        for item in items:
            await self._bus.publish(NARRATIVES, match_id, item)
```

- [ ] **Step 10: Run all narration tests to verify they pass**

Run: `uv run pytest tests/test_narration_service.py tests/test_narration_stage.py -v`
Expected: 23 passed.

- [ ] **Step 11: Commit**

```bash
git add services/pipeline/kickstream/narration services/pipeline/tests
git commit -m "feat: add narration service with budget, cache and scripted fallback"
```

---

### Task 8: Agent narrative writer (Microsoft Agent Framework)

**Files:**
- Modify: `services/pipeline/pyproject.toml` (add three dependencies)
- Create: `services/pipeline/kickstream/adapters/agent_writer.py`
- Test: `services/pipeline/tests/fake_llm.py`, `services/pipeline/tests/test_agent_writer.py`

**Interfaces:**
- Consumes: `ports.writer.*`; `domain.labels.fact_text`; `domain.types.MODES`; `narration.service.NarrationService` (in one test only); `tests.factories.moment_ctx, recap_ctx`.
- Produces:
  - `adapters.agent_writer.AgentNarrativeWriter(base_url: str, model: str, api_key: str)` implementing `NarrativeWriter`, with attribute `model`. `write_moment` runs the Commentator and Tactical Analyst concurrently, then the Localizer: three model calls. `write_recap` runs the Recap Writer, then the Localizer: two model calls. English variants carry the agent that wrote them (`commentator`, `tactical_analyst`, `recap_writer`); Spanish and Hindi variants carry `localizer`. Raises `NarrationError` when model output cannot be read into the expected shape.
  - `adapters.agent_writer.parse_json(text: str) -> dict`.

API reference, checked on 2026-10-12 against `learn.microsoft.com/agent-framework` (pages "OpenAI" under model providers, and "Sequential" and "Concurrent" under workflow orchestrations): `Agent(client=..., name=..., instructions=...)`, `await agent.run(text)` returning a response with `.text`; `OpenAIChatCompletionClient(model=..., base_url=..., api_key=...)` for any OpenAI-compatible Chat Completions endpoint; `ConcurrentBuilder(participants=[...]).build()`, `await workflow.run(text)`, `.get_outputs()[0].messages`, each message with `.author_name` and `.text`. The docs state one `OpenAIChatCompletionClient` must not serve overlapping calls, so each agent gets its own client.

- [ ] **Step 1: Add the dependencies**

In `services/pipeline/pyproject.toml`, extend `dependencies`:

```toml
dependencies = [
  "fastapi==0.143.0",
  "uvicorn==0.54.0",
  "pydantic==2.14.1",
  "sse-starlette==3.5.0",
  "agent-framework-core==1.21.0",
  "agent-framework-openai>=1.16,<2",
  "agent-framework-orchestrations>=1.3,<2",
]
```

Run: `uv sync`
Expected: resolves and installs without conflict.

Run: `uv run python -c "from agent_framework import Agent; from agent_framework.openai import OpenAIChatCompletionClient; from agent_framework.orchestrations import ConcurrentBuilder; print('ok')"`
Expected: `ok`.

- [ ] **Step 2: Write the fake model endpoint**

`services/pipeline/tests/fake_llm.py`:

```python
"""A local OpenAI-compatible Chat Completions endpoint for tests. No test calls a live model."""

import json
import socket
import threading
import time

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

ROLES = ("commentator", "tactical_analyst", "recap_writer", "localizer")
RECAP_JSON = json.dumps({
    "fan": {"title": "Fan title", "bullets": ["f1", "f2", "f3"], "text": "Fan recap."},
    "analyst": {"title": "Analyst title", "bullets": ["a1", "a2", "a3"], "text": "Analyst recap."},
})


def _text(content) -> str:
    if isinstance(content, str):
        return content
    return "".join(part.get("text", "") for part in content or [] if isinstance(part, dict))


def _tag(value, tag: str):
    if isinstance(value, str):
        return f"{tag}:{value}"
    if isinstance(value, list):
        return [_tag(item, tag) for item in value]
    return {key: _tag(item, tag) for key, item in value.items()}


class FakeLLM:
    def __init__(self) -> None:
        self.calls: list[dict] = []     # {"role": ..., "user": ...} per request
        self.replies: dict[str, str] = {}  # role -> canned reply overriding the default
        self.app = Starlette(routes=[Route("/v1/chat/completions", self._complete, methods=["POST"])])
        self._server = None
        self._thread = None
        self.base_url = ""

    def reset(self) -> None:
        self.calls.clear()
        self.replies.clear()

    def _reply(self, role: str, user: str) -> str:
        if role in self.replies:
            return self.replies[role]
        if role == "commentator":
            return "Fan line."
        if role == "tactical_analyst":
            return "Analyst line."
        if role == "recap_writer":
            return RECAP_JSON
        english = json.loads(user)
        return json.dumps({"es": _tag(english, "es"), "hi": _tag(english, "hi")}, ensure_ascii=False)

    async def _complete(self, request: Request):
        body = await request.json()
        messages = body["messages"]
        blob = " ".join(_text(m.get("content")) for m in messages)
        role = next((r for r in ROLES if f"[role:{r}]" in blob), "unknown")
        user = next((_text(m.get("content")) for m in reversed(messages) if m.get("role") == "user"), "")
        self.calls.append({"role": role, "user": user})
        reply = self._reply(role, user)
        if body.get("stream"):
            return StreamingResponse(self._chunks(reply), media_type="text/event-stream")
        return JSONResponse({
            "id": "chatcmpl-fake", "object": "chat.completion", "created": 0, "model": body.get("model", "fake"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        })

    @staticmethod
    async def _chunks(reply: str):
        def chunk(delta, finish=None):
            payload = {"id": "chatcmpl-fake", "object": "chat.completion.chunk", "created": 0, "model": "fake",
                       "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            return f"data: {json.dumps(payload)}\n\n"

        yield chunk({"role": "assistant", "content": reply})
        yield chunk({}, "stop")
        yield "data: [DONE]\n\n"

    def start(self) -> None:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        self.base_url = f"http://127.0.0.1:{port}/v1"
        self._server = uvicorn.Server(uvicorn.Config(self.app, host="127.0.0.1", port=port, log_level="warning"))
        self._thread = threading.Thread(target=self._server.run, daemon=True)
        self._thread.start()
        while not self._server.started:
            time.sleep(0.01)

    def stop(self) -> None:
        self._server.should_exit = True
        self._thread.join(timeout=5)
```

- [ ] **Step 3: Write the failing tests**

`services/pipeline/tests/test_agent_writer.py`:

```python
import json

import pytest

from kickstream.adapters.agent_writer import AgentNarrativeWriter, parse_json
from kickstream.adapters.scripted_writer import ScriptedNarrativeWriter
from kickstream.domain.types import VARIANTS
from kickstream.narration.service import NarrationService
from kickstream.ports.writer import NarrationError

from tests.fake_llm import FakeLLM
from tests.factories import moment_ctx, recap_ctx


@pytest.fixture(scope="module")
def server():
    fake = FakeLLM()
    fake.start()
    yield fake
    fake.stop()


@pytest.fixture
def llm(server):
    server.reset()
    return server


def writer(llm):
    return AgentNarrativeWriter(base_url=llm.base_url, model="fake-model", api_key="test-key")


async def test_moment_is_written_by_two_agents_then_localized(llm):
    written = await writer(llm).write_moment(moment_ctx(kind="goal", minute=23))
    assert set(written) == set(VARIANTS)
    assert (written[("fan", "en")].text, written[("fan", "en")].agent) == ("Fan line.", "commentator")
    assert (written[("analyst", "en")].text, written[("analyst", "en")].agent) == ("Analyst line.", "tactical_analyst")
    assert (written[("fan", "es")].text, written[("fan", "es")].agent) == ("es:Fan line.", "localizer")
    assert written[("analyst", "hi")].text == "hi:Analyst line."
    assert sorted(call["role"] for call in llm.calls) == ["commentator", "localizer", "tactical_analyst"]


async def test_moment_prompt_carries_only_the_facts_of_the_moment(llm):
    await writer(llm).write_moment(moment_ctx(kind="goal", minute=23))
    prompt = next(call["user"] for call in llm.calls if call["role"] == "commentator")
    for expected in ("Northbridge FC", "Harbour City", "Luca Marrowby", "Minute: 23", "goal", "expected goals 0.42"):
        assert expected in prompt
    localized = json.loads(next(call["user"] for call in llm.calls if call["role"] == "localizer"))
    assert localized == {"fan": "Fan line.", "analyst": "Analyst line."}


async def test_fenced_json_with_surrounding_prose_is_still_read(llm):
    body = json.dumps({"es": {"fan": "uno", "analyst": "dos"}, "hi": {"fan": "एक", "analyst": "दो"}}, ensure_ascii=False)
    llm.replies["localizer"] = f"Here is the translation:\n```json\n{body}\n```\nLet me know if you need more."
    written = await writer(llm).write_moment(moment_ctx())
    assert written[("fan", "es")].text == "uno" and written[("analyst", "hi")].text == "दो"


@pytest.mark.parametrize("reply", [
    "I cannot translate that.",
    '{"es": {"fan": "uno", "analyst": "dos"}}',
    '{"es": {"fan": "uno"}, "hi": {"fan": "एक", "analyst": "दो"}}',
    '{"es": "uno", "hi": "एक"}',
    '{"es": {"fan": "uno", "analyst": "dos"}, "hi": {"fan": "एक", "analyst": "दो"',
], ids=["prose", "missing-language", "missing-mode", "wrong-shape", "truncated"])
async def test_unusable_localizer_output_raises_narration_error(llm, reply):
    llm.replies["localizer"] = reply
    with pytest.raises(NarrationError):
        await writer(llm).write_moment(moment_ctx())


async def test_an_empty_agent_reply_raises_narration_error(llm):
    llm.replies["commentator"] = "   "
    with pytest.raises(NarrationError):
        await writer(llm).write_moment(moment_ctx())


async def test_recap_is_written_once_then_localized(llm):
    written = await writer(llm).write_recap(recap_ctx(period="full_time", minute=90))
    assert set(written) == set(VARIANTS)
    english = written[("analyst", "en")]
    assert (english.title, english.bullets, english.text, english.agent) == (
        "Analyst title", ("a1", "a2", "a3"), "Analyst recap.", "recap_writer")
    spanish = written[("fan", "es")]
    assert (spanish.title, spanish.bullets, spanish.agent) == ("es:Fan title", ("es:f1", "es:f2", "es:f3"), "localizer")
    assert [call["role"] for call in llm.calls] == ["recap_writer", "localizer"]
    prompt = llm.calls[0]["user"]
    assert "full time" in prompt and "Northbridge FC 2-1 Harbour City" in prompt and "big chance" in prompt


async def test_recap_writer_prose_raises_narration_error(llm):
    llm.replies["recap_writer"] = "What a match that was!"
    with pytest.raises(NarrationError):
        await writer(llm).write_recap(recap_ctx())


async def test_service_falls_back_to_scripted_when_the_agents_misbehave(llm):
    llm.replies["localizer"] = '{"es": {"fan": "uno", "analyst": ""}, "hi": {"fan": "एक", "analyst": "दो"}}'
    narratives = await NarrationService(ScriptedNarrativeWriter(), writer(llm)).moment(moment_ctx(kind="goal"))
    assert {n.source for n in narratives} == {"scripted"}
    assert next(n for n in narratives if (n.mode, n.language) == ("fan", "en")).text.startswith("GOAL!")


async def test_service_falls_back_when_the_endpoint_is_unreachable():
    dead = AgentNarrativeWriter(base_url="http://127.0.0.1:9/v1", model="fake-model", api_key="test-key")
    narratives = await NarrationService(ScriptedNarrativeWriter(), dead, timeout_s=3).moment(moment_ctx())
    assert {n.source for n in narratives} == {"scripted"}


def test_parse_json_reads_plain_fenced_and_wrapped_objects():
    assert parse_json('{"a": 1}') == {"a": 1}
    assert parse_json('```json\n{"a": {"b": "c"}}\n```') == {"a": {"b": "c"}}
    assert parse_json('Sure. {"a": "x}y"} Done.') == {"a": "x}y"}


@pytest.mark.parametrize("text", ["", "no json here", "[1, 2]", '{"a": ', "} {"])
def test_parse_json_rejects_anything_that_is_not_an_object(text):
    with pytest.raises(NarrationError):
        parse_json(text)
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `uv run pytest tests/test_agent_writer.py -v`
Expected: collection error, `ModuleNotFoundError: No module named 'kickstream.adapters.agent_writer'`.

- [ ] **Step 5: Write the agent writer**

`services/pipeline/kickstream/adapters/agent_writer.py`:

```python
"""Narratives written by a team of Microsoft Agent Framework agents.

Commentator and Tactical Analyst work on a key moment concurrently; the Localizer then
translates both. The Recap Writer produces both recap modes; the Localizer translates them.
The model endpoint is any OpenAI-compatible Chat Completions endpoint.
"""

import json

from agent_framework import Agent
from agent_framework.openai import OpenAIChatCompletionClient
from agent_framework.orchestrations import ConcurrentBuilder

from kickstream.domain.labels import fact_text
from kickstream.domain.types import MODES, Variant
from kickstream.ports.writer import MomentContext, NarrationError, RecapContext, WrittenRecap, WrittenText

COMMENTATOR = "commentator"
ANALYST = "tactical_analyst"
RECAP_WRITER = "recap_writer"
LOCALIZER = "localizer"
_WRITER_FOR_MODE = {"fan": COMMENTATOR, "analyst": ANALYST}

_INSTRUCTIONS = {
    COMMENTATOR: (
        "[role:commentator] You are a live football commentator speaking to fans. Write one or two short, vivid "
        "sentences in English about the key moment the user describes. Use only the facts given; do not invent "
        "names, numbers or events. Reply with the sentences only."),
    ANALYST: (
        "[role:tactical_analyst] You are a football tactical analyst. In two or three sentences in English, explain "
        "what changed and why this moment matters, citing the numbers given. Use only the facts given; do not "
        "invent names, numbers or events. Reply with the sentences only."),
    RECAP_WRITER: (
        "[role:recap_writer] You write football match recaps from the summary the user gives. Use only the facts "
        "given. Reply with JSON only, in exactly this shape: "
        '{"fan": {"title": "...", "bullets": ["...", "...", "..."], "text": "..."}, '
        '"analyst": {"title": "...", "bullets": ["...", "...", "..."], "text": "..."}}. '
        "The fan version is short and vivid. The analyst version explains the numbers. Write in English."),
    LOCALIZER: (
        "[role:localizer] You translate football text. The user sends a JSON object. Translate every string value "
        "into Spanish and into Hindi. Keep player names, club names, numbers and the JSON structure unchanged. "
        'Reply with JSON only, in exactly this shape: {"es": <the object in Spanish>, "hi": <the object in Hindi>}.'),
}


def parse_json(text: str) -> dict:
    """Read one JSON object from model output, tolerating code fences and surrounding prose."""
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise NarrationError("no JSON object in model output")
    try:
        value = json.loads(text[start:end + 1])
    except ValueError as exc:
        raise NarrationError(f"invalid JSON in model output: {exc}") from exc
    if not isinstance(value, dict):
        raise NarrationError("model output is not a JSON object")
    return value


def _stats_line(ctx: MomentContext | RecapContext) -> str:
    home, away = ctx.stats.home, ctx.stats.away
    return (f"shots {home.shots}-{away.shots}, shots on target {home.shots_on_target}-{away.shots_on_target}, "
            f"possession {home.possession}%-{away.possession}%, expected goals {home.xg}-{away.xg} "
            f"({ctx.home.name} first)")


def moment_prompt(ctx: MomentContext) -> str:
    moment = ctx.moment
    team = (ctx.home if moment.team == "home" else ctx.away).name
    lines = [
        f"Match: {ctx.home.name} vs {ctx.away.name}",
        f"Minute: {moment.minute}",
        f"Key moment: {moment.kind.replace('_', ' ')}",
        f"Team: {team}",
        f"Player: {ctx.player_name or 'not applicable'}",
        f"Score: {ctx.home.name} {moment.score_home}-{moment.score_away} {ctx.away.name}",
        f"Numbers that triggered this moment: {fact_text(moment.facts, 'en')}",
    ]
    if ctx.stats is not None:
        lines.append(f"Match so far: {_stats_line(ctx)}")
    return "\n".join(lines)


def recap_prompt(ctx: RecapContext) -> str:
    home, away = ctx.stats.home, ctx.stats.away
    lines = [
        f"Recap for: {ctx.period.replace('_', ' ')}",
        f"Score: {ctx.home.name} {home.goals}-{away.goals} {ctx.away.name}",
        f"Match numbers: {_stats_line(ctx)}",
        "Key moments:",
    ]
    for moment in ctx.moments:
        team = (ctx.home if moment.team == "home" else ctx.away).name
        lines.append(f"- {moment.minute}' {moment.kind.replace('_', ' ')} for {team} ({fact_text(moment.facts, 'en')})")
    return "\n".join(lines)


class AgentNarrativeWriter:
    def __init__(self, base_url: str, model: str, api_key: str) -> None:
        self.model = model
        self._base_url = base_url
        self._api_key = api_key

    def _agent(self, name: str) -> Agent:
        # One client per agent: the Chat Completions client must not serve overlapping calls.
        client = OpenAIChatCompletionClient(model=self.model, base_url=self._base_url, api_key=self._api_key)
        return Agent(client=client, name=name, instructions=_INSTRUCTIONS[name])

    async def write_moment(self, ctx: MomentContext) -> dict[Variant, WrittenText]:
        workflow = ConcurrentBuilder(participants=[self._agent(COMMENTATOR), self._agent(ANALYST)]).build()
        result = await workflow.run(moment_prompt(ctx))
        outputs = result.get_outputs()
        if not outputs:
            raise NarrationError("the commentary workflow produced no output")
        by_author = {message.author_name: (message.text or "").strip() for message in outputs[0].messages}
        english = {mode: by_author.get(author, "") for mode, author in _WRITER_FOR_MODE.items()}
        if not all(english.values()):
            raise NarrationError("an agent returned no text")
        translated = await self._localize(english)

        written: dict[Variant, WrittenText] = {}
        for mode in MODES:
            written[(mode, "en")] = WrittenText(english[mode], _WRITER_FOR_MODE[mode])
            for language in ("es", "hi"):
                text = translated[language].get(mode)
                if not isinstance(text, str):
                    raise NarrationError(f"localizer omitted {mode} in {language}")
                written[(mode, language)] = WrittenText(text, LOCALIZER)
        return written

    async def write_recap(self, ctx: RecapContext) -> dict[Variant, WrittenRecap]:
        response = await self._agent(RECAP_WRITER).run(recap_prompt(ctx))
        english = parse_json(response.text or "")
        translated = await self._localize(english)

        written: dict[Variant, WrittenRecap] = {}
        for mode in MODES:
            written[(mode, "en")] = self._recap(english.get(mode), RECAP_WRITER)
            for language in ("es", "hi"):
                written[(mode, language)] = self._recap(translated[language].get(mode), LOCALIZER)
        return written

    @staticmethod
    def _recap(raw, agent: str) -> WrittenRecap:
        try:
            title, bullets, text = raw["title"], raw["bullets"], raw["text"]
            if not (isinstance(title, str) and isinstance(text, str) and isinstance(bullets, list)
                    and len(bullets) == 3 and all(isinstance(bullet, str) for bullet in bullets)):
                raise TypeError("wrong field types")
        except (KeyError, TypeError) as exc:
            raise NarrationError(f"recap from {agent} has the wrong shape: {exc}") from exc
        return WrittenRecap(title, (bullets[0], bullets[1], bullets[2]), text, agent)

    async def _localize(self, english: dict) -> dict:
        response = await self._agent(LOCALIZER).run(json.dumps(english, ensure_ascii=False))
        translated = parse_json(response.text or "")
        for language in ("es", "hi"):
            if not isinstance(translated.get(language), dict):
                raise NarrationError(f"localizer omitted {language}")
        return translated
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `uv run pytest tests/test_agent_writer.py -v`
Expected: 19 passed.

If a test fails inside `agent_framework` rather than in Kickstream code, the installed version differs from the reference above. Open the two doc pages named at the top of this task, correct the call in `agent_writer.py`, and leave the tests unchanged: they describe the behavior that must hold.

- [ ] **Step 7: Commit**

```bash
git add services/pipeline/pyproject.toml services/pipeline/uv.lock services/pipeline/kickstream/adapters/agent_writer.py services/pipeline/tests
git commit -m "feat: add Agent Framework narrative writer with four agents"
```

---

### Task 9: Overlay engine (Render)

**Files:**
- Create: `services/pipeline/kickstream/overlay/__init__.py` (empty), `build.py`, `stage.py`
- Test: `services/pipeline/tests/test_overlay.py`

**Interfaces:**
- Consumes: contracts `Overlay, Narrative, Recap, KeyMoment, StatsSnapshot, PressureSnapshot, MatchStatus`; `domain.labels.FACT_LABELS, KIND_LABELS`; `domain.types.LANGUAGES`; `ports.bus.STATUS, INSIGHTS, NARRATIVES, OVERLAYS, EventBus`.
- Produces:
  - `overlay.build.lower_third(overlay_id: str, narrative: Narrative, moment: KeyMoment, team_name: str) -> Overlay`
  - `overlay.build.stat_card(overlay_id: str, snapshot: StatsSnapshot, language: Language) -> Overlay`
  - `overlay.build.pressure_map(overlay_id: str, snapshot: PressureSnapshot) -> Overlay`
  - `overlay.build.recap_card(overlay_id: str, recap: Recap) -> Overlay`
  - Every builder returns an `Overlay` that has been re-validated against the schema model.
  - `overlay.stage.OverlayStage(bus: EventBus, stat_card_every_min: int = 5)` with `async run() -> None`. Subscribes to `STATUS`, `INSIGHTS`, `NARRATIVES` in its constructor; publishes on `OVERLAYS`. Overlay IDs are `{match_id}-o{n}`. Lower thirds and recap cards are built from Fan-mode items only, one per language. Stat cards are emitted in all three languages when `minute % stat_card_every_min == 0` or at a period end. Pressure maps have `language=None`.

- [ ] **Step 1: Write the failing tests**

`services/pipeline/tests/test_overlay.py`:

```python
import asyncio

from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.contracts import (LowerThirdData, MatchStatus, Narrative, Overlay, PressureMapData, PressureSnapshot,
                                  Recap, RecapCardData, StatCardData)
from kickstream.domain.teams import AWAY, HOME
from kickstream.overlay.build import lower_third, pressure_map, recap_card, stat_card
from kickstream.overlay.stage import OverlayStage
from kickstream.ports.bus import INSIGHTS, NARRATIVES, OVERLAYS, STATUS

from tests.factories import MATCH, moment, stats, team_stats


def narrative(mode="fan", language="en", n=1) -> Narrative:
    return Narrative(id=f"{MATCH}-k{n}-{mode}-{language}", match_id=MATCH, minute=10, moment_id=f"{MATCH}-k{n}",
                     mode=mode, language=language, text="GOAL! What a strike.", source="scripted", agent="scripted",
                     evidence=[f"{MATCH}-k{n}"], team="home", player_id="nbr-9")


def recap(mode="fan", language="en", period="half_time") -> Recap:
    return Recap(id=f"{MATCH}-r-{period}-{mode}-{language}", match_id=MATCH, minute=45, period=period, mode=mode,
                 language=language, title="Half-time: Northbridge FC 2-1 Harbour City", bullets=["a", "b", "c"],
                 text="t", source="scripted", agent="scripted", score_home=2, score_away=1)


def heat(minute=10) -> PressureSnapshot:
    return PressureSnapshot(id=f"{MATCH}-p{minute}", match_id=MATCH, minute=minute, cols=6, rows=4,
                            home=[1.0] * 24, away=[0.5] * 24)


def test_lower_third_pairs_a_localized_headline_with_the_narrative():
    overlay = lower_third("o1", narrative(language="es"), moment(1, kind="goal"), "Northbridge FC")
    assert (overlay.kind, overlay.language, overlay.minute) == ("lower_third", "es", 10)
    assert overlay.data == LowerThirdData(headline="GOL", subline="GOAL! What a strike.", team="Northbridge FC", minute=10)
    assert overlay.sources == [f"{MATCH}-k1-fan-es", f"{MATCH}-k1"]
    assert overlay.duration_ms > 0


def test_stat_card_has_four_localized_rows():
    snapshot = stats(minute=15, home=team_stats(possession=61.5, shots=7, shots_on_target=3, xg=1.24),
                     away=team_stats(possession=38.5, shots=2, shots_on_target=1, xg=0.3))
    english, hindi = stat_card("o1", snapshot, "en"), stat_card("o2", snapshot, "hi")
    assert isinstance(english.data, StatCardData)
    assert [(r.label, r.home, r.away) for r in english.data.stat_rows] == [
        ("Possession %", 61.5, 38.5), ("Shots", 7, 2), ("Shots on target", 3, 1), ("Expected goals", 1.24, 0.3)]
    assert hindi.language == "hi" and hindi.data.stat_rows[1].label == "शॉट"
    assert english.sources == [snapshot.id]


def test_pressure_map_copies_the_grid_and_has_no_language():
    overlay = pressure_map("o1", heat())
    assert overlay.language is None
    assert overlay.data == PressureMapData(cols=6, rows=4, home=[1.0] * 24, away=[0.5] * 24)


def test_recap_card_carries_title_score_and_bullets():
    overlay = recap_card("o1", recap())
    assert overlay.data == RecapCardData(title="Half-time: Northbridge FC 2-1 Harbour City", score="2-1", bullets=["a", "b", "c"])
    assert overlay.language == "en" and overlay.sources == [f"{MATCH}-r-half_time-fan-en"]


def test_every_overlay_survives_a_json_round_trip():
    snapshot = stats(minute=15)
    for overlay in (lower_third("o1", narrative(), moment(1), "Northbridge FC"), stat_card("o2", snapshot, "en"),
                    pressure_map("o3", heat()), recap_card("o4", recap())):
        assert Overlay.model_validate_json(overlay.model_dump_json()) == overlay


async def collect(publish, expected):
    bus = InMemoryEventBus()
    out = bus.subscribe(OVERLAYS, maxsize=1000)
    task = asyncio.create_task(OverlayStage(bus).run())
    await bus.publish(STATUS, MATCH, MatchStatus(match_id=MATCH, state="live", minute=0, score_home=0, score_away=0,
                                                 speed=30, home=HOME, away=AWAY))
    await publish(bus)
    overlays = [(await asyncio.wait_for(anext(aiter(out)), 2)).payload for _ in range(expected)]
    await asyncio.sleep(0.05)
    task.cancel()
    assert out.queue.empty(), "the stage emitted more overlays than expected"
    return overlays


async def test_stage_builds_lower_thirds_from_fan_narratives_only():
    async def publish(bus):
        await bus.publish(INSIGHTS, MATCH, moment(1, kind="red_card", team="away"))
        await bus.publish(NARRATIVES, MATCH, narrative("analyst", "en"))
        await bus.publish(NARRATIVES, MATCH, narrative("fan", "en"))
        await bus.publish(NARRATIVES, MATCH, narrative("fan", "hi"))

    english, hindi = await collect(publish, 2)
    assert (english.id, hindi.id) == (f"{MATCH}-o1", f"{MATCH}-o2")
    assert (english.data.headline, english.data.team) == ("RED CARD", "Harbour City")
    assert hindi.data.headline == "रेड कार्ड"


async def test_stage_skips_a_narrative_whose_moment_it_never_saw():
    async def publish(bus):
        await bus.publish(NARRATIVES, MATCH, narrative("fan", "en", n=7))
        await bus.publish(INSIGHTS, MATCH, heat(3))

    [only] = await collect(publish, 1)
    assert only.kind == "pressure_map"


async def test_stage_emits_stat_cards_every_five_minutes_and_at_period_ends():
    async def publish(bus):
        for minute in (4, 5, 6):
            await bus.publish(INSIGHTS, MATCH, stats(minute=minute))
        await bus.publish(INSIGHTS, MATCH, stats(minute=47, period_end="half_time"))

    overlays = await collect(publish, 6)
    assert [(o.kind, o.minute, o.language) for o in overlays] == [
        ("stat_card", 5, "en"), ("stat_card", 5, "es"), ("stat_card", 5, "hi"),
        ("stat_card", 47, "en"), ("stat_card", 47, "es"), ("stat_card", 47, "hi")]


async def test_stage_emits_recap_cards_for_fan_recaps_only():
    async def publish(bus):
        await bus.publish(NARRATIVES, MATCH, recap("analyst", "en"))
        await bus.publish(NARRATIVES, MATCH, recap("fan", "es"))

    [card] = await collect(publish, 1)
    assert (card.kind, card.language) == ("recap_card", "es")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_overlay.py -v`
Expected: collection error, `ModuleNotFoundError: No module named 'kickstream.overlay'`.

- [ ] **Step 3: Write the builders**

`services/pipeline/kickstream/overlay/build.py`:

```python
"""Build broadcast overlay documents. Every overlay is validated before it leaves this module."""

from kickstream.contracts import (KeyMoment, LowerThirdData, Narrative, Overlay, PressureMapData, PressureSnapshot,
                                  Recap, RecapCardData, StatCardData, StatRow, StatsSnapshot)
from kickstream.domain.labels import FACT_LABELS, KIND_LABELS
from kickstream.domain.types import Language

_DURATION_MS = {"lower_third": 6000, "stat_card": 8000, "pressure_map": 8000, "recap_card": 15000}
_STAT_ROWS = ("possession", "shots", "shots_on_target", "xg")


def _overlay(overlay_id: str, match_id: str, minute: int, kind: str, language: Language | None,
             sources: list[str], data) -> Overlay:
    overlay = Overlay(id=overlay_id, match_id=match_id, minute=minute, kind=kind, language=language,
                      duration_ms=_DURATION_MS[kind], sources=sources, data=data)
    return Overlay.model_validate(overlay.model_dump())


def _title_case(label: str) -> str:
    return label[:1].upper() + label[1:]


def lower_third(overlay_id: str, narrative: Narrative, moment: KeyMoment, team_name: str) -> Overlay:
    data = LowerThirdData(headline=KIND_LABELS[narrative.language][moment.kind], subline=narrative.text,
                          team=team_name, minute=narrative.minute)
    return _overlay(overlay_id, narrative.match_id, narrative.minute, "lower_third", narrative.language,
                    [narrative.id, moment.id], data)


def stat_card(overlay_id: str, snapshot: StatsSnapshot, language: Language) -> Overlay:
    labels = FACT_LABELS[language]
    rows = [StatRow(label=_title_case(labels[name]), home=getattr(snapshot.home, name), away=getattr(snapshot.away, name))
            for name in _STAT_ROWS]
    return _overlay(overlay_id, snapshot.match_id, snapshot.minute, "stat_card", language, [snapshot.id],
                    StatCardData(stat_rows=rows))


def pressure_map(overlay_id: str, snapshot: PressureSnapshot) -> Overlay:
    data = PressureMapData(cols=snapshot.cols, rows=snapshot.rows, home=snapshot.home, away=snapshot.away)
    return _overlay(overlay_id, snapshot.match_id, snapshot.minute, "pressure_map", None, [snapshot.id], data)


def recap_card(overlay_id: str, recap: Recap) -> Overlay:
    data = RecapCardData(title=recap.title, score=f"{recap.score_home}-{recap.score_away}", bullets=recap.bullets)
    return _overlay(overlay_id, recap.match_id, recap.minute, "recap_card", recap.language, [recap.id], data)
```

- [ ] **Step 4: Write the stage**

`services/pipeline/kickstream/overlay/stage.py`:

```python
import logging

from kickstream.contracts import (KeyMoment, MatchStatus, Narrative, Overlay, PressureSnapshot, Recap,
                                  StatsSnapshot)
from kickstream.domain.types import LANGUAGES
from kickstream.overlay.build import lower_third, pressure_map, recap_card, stat_card
from kickstream.ports.bus import INSIGHTS, NARRATIVES, OVERLAYS, STATUS, EventBus

log = logging.getLogger(__name__)


class OverlayStage:
    def __init__(self, bus: EventBus, stat_card_every_min: int = 5) -> None:
        self._bus = bus
        self._every = stat_card_every_min
        self._messages = bus.subscribe(STATUS, INSIGHTS, NARRATIVES)
        self._count: dict[str, int] = {}
        self._moments: dict[str, KeyMoment] = {}
        self._team_names: dict[str, dict[str, str]] = {}

    def _next_id(self, match_id: str) -> str:
        self._count[match_id] = self._count.get(match_id, 0) + 1
        return f"{match_id}-o{self._count[match_id]}"

    def _build(self, match_id: str, payload) -> list[Overlay]:
        if isinstance(payload, MatchStatus):
            self._team_names[match_id] = {"home": payload.home.name, "away": payload.away.name}
        elif isinstance(payload, KeyMoment):
            self._moments[payload.id] = payload
        elif isinstance(payload, StatsSnapshot):
            if payload.period_end or payload.minute % self._every == 0:
                return [stat_card(self._next_id(match_id), payload, language) for language in LANGUAGES]
        elif isinstance(payload, PressureSnapshot):
            return [pressure_map(self._next_id(match_id), payload)]
        elif isinstance(payload, Narrative) and payload.mode == "fan":
            moment = self._moments.get(payload.moment_id)
            if moment is None:
                log.warning("no key moment %s for narrative %s; skipping lower third", payload.moment_id, payload.id)
                return []
            team = self._team_names.get(match_id, {}).get(moment.team, moment.team)
            return [lower_third(self._next_id(match_id), payload, moment, team)]
        elif isinstance(payload, Recap) and payload.mode == "fan":
            return [recap_card(self._next_id(match_id), payload)]
        return []

    async def run(self) -> None:
        async for message in self._messages:
            for overlay in self._build(message.match_id, message.payload):
                await self._bus.publish(OVERLAYS, message.match_id, overlay)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_overlay.py -v`
Expected: 9 passed.

- [ ] **Step 6: Commit**

```bash
git add services/pipeline/kickstream/overlay services/pipeline/tests/test_overlay.py
git commit -m "feat: add overlay engine producing validated broadcast JSON"
```

---

### Task 10: Gateway core (Personalize): recorder, filter and stream

**Files:**
- Create: `services/pipeline/kickstream/gateway/__init__.py` (empty), `recorder.py`, `personalize.py`, `stream.py`
- Test: `services/pipeline/tests/test_gateway.py`

**Interfaces:**
- Consumes: all contracts; `ports.bus`, `ports.store`, `ports.broadcaster`.
- Produces:
  - `gateway.recorder.Recorder(bus: EventBus, store: MatchStore, broadcaster: Broadcaster)` with `record(match_id: str, payload: BaseModel) -> LogItem | None` and `async run() -> None`. Subscribes to all five topics in its constructor. Maps each payload class to its envelope type, appends it to the store with its variant fields (`language`, `mode`, `team_id`, `player_id`) and broadcasts it. `team_id` is the team sheet ID for the payload's `team` side.
  - `gateway.personalize.to_envelope(item: LogItem, profile: ViewerProfile) -> Envelope | None`. Returns `None` for an item in another language or mode. `highlighted` is true only for `key_moment` and `narrative` items that match the viewer's club or player.
  - `gateway.stream.stream_items(store: MatchStore, broadcaster: Broadcaster, match_id: str, profile: ViewerProfile, after_id: int = 0) -> AsyncIterator[Envelope]`. Replays the log after `after_id`, then continues live with no duplicate and no gap. Ends when the viewer's feed is closed for falling behind.

- [ ] **Step 1: Write the failing tests**

`services/pipeline/tests/test_gateway.py`:

```python
import asyncio

from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.adapters.memory_store import InMemoryMatchStore
from kickstream.adapters.sse_broadcaster import InProcessBroadcaster
from kickstream.contracts import MatchStatus, Narrative, ViewerProfile
from kickstream.domain.teams import AWAY, HOME
from kickstream.gateway.personalize import to_envelope
from kickstream.gateway.recorder import Recorder
from kickstream.gateway.stream import stream_items
from kickstream.ports.bus import EVENTS, INSIGHTS, NARRATIVES, STATUS

from tests.factories import MATCH, event, moment, stats

STATUS_LIVE = MatchStatus(match_id=MATCH, state="live", minute=0, score_home=0, score_away=0, speed=30,
                          home=HOME, away=AWAY)
FAN_EN = ViewerProfile(mode="fan", language="en")


def narrative(mode="fan", language="en", team="home", player_id="nbr-9", n=1) -> Narrative:
    return Narrative(id=f"{MATCH}-k{n}-{mode}-{language}", match_id=MATCH, minute=10, moment_id=f"{MATCH}-k{n}",
                     mode=mode, language=language, text="text", source="scripted", agent="scripted",
                     evidence=[], team=team, player_id=player_id)


def wired():
    bus, store, broadcaster = InMemoryEventBus(), InMemoryMatchStore(), InProcessBroadcaster()
    return bus, store, broadcaster, Recorder(bus, store, broadcaster)


def test_recorder_types_items_and_keeps_variant_fields():
    _, store, _, recorder = wired()
    recorder.record(MATCH, STATUS_LIVE)
    recorder.record(MATCH, event(1, "pass", "away", player_id="hbc-7", completed=True))
    recorder.record(MATCH, stats(minute=3))
    recorder.record(MATCH, moment(1, team="away", player_id="hbc-9"))
    item = recorder.record(MATCH, narrative("analyst", "hi", team="away", player_id="hbc-9"))

    assert [i.type for i in store.read(MATCH)] == ["match_status", "match_event", "stats", "key_moment", "narrative"]
    assert [i.id for i in store.read(MATCH)] == [1, 2, 3, 4, 5]
    assert (item.language, item.mode, item.team_id, item.player_id, item.minute) == ("hi", "analyst", "hbc", "hbc-9", 10)
    assert store.read(MATCH)[1].team_id == "hbc"
    assert store.read(MATCH)[2].language is None and store.read(MATCH)[2].team_id is None


def test_recorder_ignores_payloads_it_does_not_know():
    _, store, _, recorder = wired()
    assert recorder.record(MATCH, FAN_EN) is None
    assert store.read(MATCH) == []


async def test_recorder_run_records_every_topic_and_broadcasts():
    bus, store, broadcaster, recorder = wired()
    feed = broadcaster.subscribe(MATCH)
    task = asyncio.create_task(recorder.run())
    await bus.publish(STATUS, MATCH, STATUS_LIVE)
    await bus.publish(EVENTS, MATCH, event(1, "kickoff", "home", player_id="nbr-8"))
    await bus.publish(INSIGHTS, MATCH, moment(1))
    await bus.publish(NARRATIVES, MATCH, narrative())
    received = [await asyncio.wait_for(anext(aiter(feed)), 1) for _ in range(4)]
    task.cancel()
    assert [i.type for i in received] == ["match_status", "match_event", "key_moment", "narrative"]
    assert received == store.read(MATCH)


def items():
    _, store, _, recorder = wired()
    recorder.record(MATCH, STATUS_LIVE)
    recorder.record(MATCH, event(1, "pass", "home", player_id="nbr-9", completed=True))
    recorder.record(MATCH, moment(1, team="home", player_id="nbr-9"))
    for mode in ("fan", "analyst"):
        for language in ("en", "es", "hi"):
            recorder.record(MATCH, narrative(mode, language))
    recorder.record(MATCH, narrative("fan", "en", team="away", player_id="hbc-9", n=2))
    return store.read(MATCH)


def test_only_the_viewers_variant_of_a_narrative_is_delivered():
    profile = ViewerProfile(mode="analyst", language="es")
    delivered = [e for e in (to_envelope(i, profile) for i in items()) if e is not None]
    narratives = [e for e in delivered if e.type == "narrative"]
    assert [(e.payload["mode"], e.payload["language"]) for e in narratives] == [("analyst", "es")]
    assert [e.type for e in delivered] == ["match_status", "match_event", "key_moment", "narrative"]
    assert [e.id for e in delivered] == sorted(e.id for e in delivered)
    assert delivered[0].payload["home"]["name"] == "Northbridge FC"


def test_favorites_highlight_key_moments_and_narratives_only():
    def highlighted(profile):
        return [(e.type, e.highlighted) for e in (to_envelope(i, profile) for i in items()) if e is not None]

    plain = [("match_status", False), ("match_event", False), ("key_moment", False), ("narrative", False), ("narrative", False)]
    assert highlighted(FAN_EN) == plain
    by_club = highlighted(ViewerProfile(mode="fan", language="en", club="nbr"))
    assert by_club == [("match_status", False), ("match_event", False), ("key_moment", True), ("narrative", True), ("narrative", False)]
    assert highlighted(ViewerProfile(mode="fan", language="en", player="hbc-9"))[-1] == ("narrative", True)
    assert highlighted(ViewerProfile(mode="fan", language="en", club="hbc", player="nbr-9"))[2:] == [
        ("key_moment", True), ("narrative", True), ("narrative", True)]


def test_a_favorite_that_is_not_in_this_match_highlights_nothing():
    stale = ViewerProfile(mode="fan", language="en", club="old-club", player="old-club-10")
    delivered = [e for e in (to_envelope(i, stale) for i in items()) if e is not None]
    assert len(delivered) == 5 and not any(e.highlighted for e in delivered)


async def test_stream_replays_then_continues_live_without_gaps_or_duplicates():
    _, store, broadcaster, recorder = wired()
    recorder.record(MATCH, STATUS_LIVE)
    recorder.record(MATCH, event(1, "kickoff", "home", player_id="nbr-8"))
    stream = stream_items(store, broadcaster, MATCH, FAN_EN)
    first, second = await anext(stream), await anext(stream)
    recorder.record(MATCH, narrative("fan", "es"))
    recorder.record(MATCH, narrative("fan", "en"))
    third = await asyncio.wait_for(anext(stream), 1)
    await stream.aclose()
    assert [first.id, second.id, third.id] == [1, 2, 4]
    assert third.payload["language"] == "en"


async def test_stream_resumes_after_a_given_id():
    _, store, broadcaster, recorder = wired()
    recorder.record(MATCH, STATUS_LIVE)
    for seq in (1, 2, 3):
        recorder.record(MATCH, event(seq, "pass", "home", player_id="nbr-8", completed=True))
    stream = stream_items(store, broadcaster, MATCH, FAN_EN, after_id=2)
    assert [(await anext(stream)).id, (await anext(stream)).id] == [3, 4]
    await stream.aclose()

    beyond = stream_items(store, broadcaster, MATCH, FAN_EN, after_id=99)
    pending = asyncio.create_task(anext(beyond))
    await asyncio.sleep(0.01)
    assert not pending.done(), "nothing to replay; waits for live items"
    pending.cancel()


async def test_a_viewer_that_falls_behind_is_ended_and_can_resume_with_nothing_lost():
    _, store, broadcaster, recorder = wired()
    recorder.record(MATCH, STATUS_LIVE)
    stream = stream_items(store, broadcaster, MATCH, FAN_EN)
    seen = [(await anext(stream)).id]
    for seq in range(1, 601):
        recorder.record(MATCH, event(seq, "pass", "home", player_id="nbr-8", completed=True))
    seen += [envelope.id async for envelope in stream]
    assert seen == [1], "the feed overflowed before the viewer read from it, so the stream ended"

    resumed = stream_items(store, broadcaster, MATCH, FAN_EN, after_id=seen[-1])
    seen += [(await anext(resumed)).id for _ in range(600)]
    await resumed.aclose()
    assert seen == list(range(1, 602))


async def test_closing_a_stream_releases_its_feed():
    _, store, broadcaster, recorder = wired()
    recorder.record(MATCH, STATUS_LIVE)
    stream = stream_items(store, broadcaster, MATCH, FAN_EN)
    await anext(stream)
    await stream.aclose()
    assert broadcaster._feeds[MATCH] == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_gateway.py -v`
Expected: collection error, `ModuleNotFoundError: No module named 'kickstream.gateway'`.

- [ ] **Step 3: Write the recorder**

`services/pipeline/kickstream/gateway/recorder.py`:

```python
import logging

from pydantic import BaseModel

from kickstream.contracts import (KeyMoment, MatchEvent, MatchStatus, Narrative, Overlay, PressureSnapshot, Recap,
                                  StatsSnapshot)
from kickstream.ports.broadcaster import Broadcaster
from kickstream.ports.bus import EVENTS, INSIGHTS, NARRATIVES, OVERLAYS, STATUS, EventBus
from kickstream.ports.store import LogItem, MatchStore

log = logging.getLogger(__name__)

_TYPES: dict[type, str] = {
    MatchStatus: "match_status", MatchEvent: "match_event", StatsSnapshot: "stats", PressureSnapshot: "pressure",
    KeyMoment: "key_moment", Narrative: "narrative", Recap: "recap", Overlay: "overlay",
}


class Recorder:
    """Writes everything the pipeline publishes into the match log and fans it out."""

    def __init__(self, bus: EventBus, store: MatchStore, broadcaster: Broadcaster) -> None:
        self._store = store
        self._broadcaster = broadcaster
        self._messages = bus.subscribe(STATUS, EVENTS, INSIGHTS, NARRATIVES, OVERLAYS)
        self._team_ids: dict[str, dict[str, str]] = {}

    def record(self, match_id: str, payload: BaseModel) -> LogItem | None:
        item_type = _TYPES.get(type(payload))
        if item_type is None:
            log.warning("not recording unknown payload type %s", type(payload).__name__)
            return None
        if isinstance(payload, MatchStatus):
            self._team_ids[match_id] = {"home": payload.home.id, "away": payload.away.id}
        side = getattr(payload, "team", None)
        item = self._store.append(
            match_id, item_type, payload.minute, payload,
            language=getattr(payload, "language", None), mode=getattr(payload, "mode", None),
            team_id=self._team_ids.get(match_id, {}).get(side), player_id=getattr(payload, "player_id", None))
        self._broadcaster.publish(item)
        return item

    async def run(self) -> None:
        async for message in self._messages:
            self.record(message.match_id, message.payload)
```

- [ ] **Step 4: Write the personalizer and the stream**

`services/pipeline/kickstream/gateway/personalize.py`:

```python
from kickstream.contracts import Envelope, ViewerProfile
from kickstream.ports.store import LogItem

_HIGHLIGHTABLE = {"key_moment", "narrative"}


def to_envelope(item: LogItem, profile: ViewerProfile) -> Envelope | None:
    """Shape one log item for one viewer, or drop it if it is another viewer's variant."""
    if item.language is not None and item.language != profile.language:
        return None
    if item.mode is not None and item.mode != profile.mode:
        return None
    favorite = (profile.club is not None and item.team_id == profile.club) or (
        profile.player is not None and item.player_id == profile.player)
    return Envelope(id=item.id, type=item.type, match_id=item.match_id, minute=item.minute,
                    highlighted=item.type in _HIGHLIGHTABLE and favorite, payload=item.payload.model_dump(mode="json"))
```

`services/pipeline/kickstream/gateway/stream.py`:

```python
from collections.abc import AsyncIterator

from kickstream.contracts import Envelope, ViewerProfile
from kickstream.gateway.personalize import to_envelope
from kickstream.ports.broadcaster import Broadcaster
from kickstream.ports.store import MatchStore


async def stream_items(store: MatchStore, broadcaster: Broadcaster, match_id: str, profile: ViewerProfile,
                       after_id: int = 0) -> AsyncIterator[Envelope]:
    """Replay the match log after `after_id`, then follow it live.

    The live feed is opened before the replay is read, so an item published in between is
    seen twice rather than missed; the ID check drops the second copy.
    """
    feed = broadcaster.subscribe(match_id)
    try:
        last = after_id
        for item in store.read(match_id, after_id):
            last = item.id
            envelope = to_envelope(item, profile)
            if envelope is not None:
                yield envelope
        async for item in feed:
            if item.id <= last:
                continue
            last = item.id
            envelope = to_envelope(item, profile)
            if envelope is not None:
                yield envelope
    finally:
        feed.close()
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_gateway.py -v`
Expected: 10 passed.

- [ ] **Step 6: Commit**

```bash
git add services/pipeline/kickstream/gateway services/pipeline/tests/test_gateway.py
git commit -m "feat: add match log recorder, per-viewer filter and resumable stream"
```

---

### Task 11: Match control, HTTP API and composition root

**Files:**
- Create: `services/pipeline/kickstream/control.py`, `services/pipeline/kickstream/gateway/api.py`, `services/pipeline/kickstream/app.py`
- Test: `services/pipeline/tests/test_control.py`, `services/pipeline/tests/test_api.py`, `services/pipeline/tests/test_pipeline.py`, `services/pipeline/tests/test_architecture.py`

**Interfaces:**
- Consumes: everything built so far.
- Produces:
  - `control.MatchController(bus: EventBus, clock_factory: Callable[[float], Clock], home: TeamSheet, away: TeamSheet)` with `async start(seed: int, speed: float) -> str` (IDs `m-1`, `m-2`, …; ends the running match first), `async stop() -> None`, `async wait() -> None`, `current: str | None` (the last match started), `exists(match_id: str) -> bool`. Stopping a match that has not finished publishes its last `MatchStatus` again with `state="abandoned"`.
  - `gateway.api.build_router(*, store, broadcaster, teams: tuple[TeamSheet, TeamSheet], start_match: Callable[[int, float], Awaitable[str]], current_match: Callable[[], str | None], match_exists: Callable[[str], bool]) -> APIRouter` and `gateway.api.parse_last_event_id(value: str | None) -> int`.
  - `app.Settings(llm_base_url, llm_model, llm_api_key, llm_max_calls=60, llm_reserve=15, llm_min_gap_s=2.0, cache_dir=Path(".cache/narration"))` with `Settings.from_env(env=os.environ)` and property `llm_configured`.
  - `app.build_pipeline(settings: Settings, *, clock_factory=RealClock, writer: NarrativeWriter | None = None) -> Pipeline`; `Pipeline` has `bus, store, broadcaster, controller`, `start() -> None` and `async stop() -> None`.
  - `app.create_app(settings: Settings | None = None, *, clock_factory=RealClock, writer=None) -> FastAPI`. Run with `uvicorn kickstream.app:create_app --factory`.

HTTP surface:

| Method and path | Success | Errors |
|---|---|---|
| `GET /api/teams` | 200 `{"home": TeamSheet, "away": TeamSheet}` | |
| `POST /api/matches` body `{"seed"?: int 0..2147483647, "speed"?: number 1..600}` | 201 `{"match_id": "m-1"}` | 422 for out-of-range or unknown fields |
| `GET /api/matches/current` | 200 `{"match_id": "m-1"}` | 404 before any match |
| `GET /api/matches/{id}/stream?mode=&lang=&club=&player=` | 200 `text/event-stream`; each event has `id:` and `data:` (an `Envelope` as JSON) | 404 unknown match; 422 bad `mode` or `lang` |
| `GET /api/matches/{id}/overlays/latest?lang=` | 200 `{kind: Overlay}` for the latest overlay of each kind | 404 unknown match; 422 bad `lang` |

- [ ] **Step 1: Write the failing controller tests**

`services/pipeline/tests/test_control.py`:

```python
import asyncio

from kickstream.adapters.clocks import InstantClock
from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.control import MatchController
from kickstream.domain.teams import AWAY, HOME
from kickstream.ports.bus import STATUS


class StuckClock:
    """Lets the first status out, then never advances."""

    async def sleep(self, match_seconds):
        if match_seconds > 0:
            await asyncio.Event().wait()


def controller(clock_type):
    bus = InMemoryEventBus()
    statuses = bus.subscribe(STATUS, maxsize=5000)
    bus.subscribe("events", maxsize=5000)
    return MatchController(bus, lambda speed: clock_type(), HOME, AWAY), statuses


def drain(subscription):
    out = []
    while not subscription.queue.empty():
        out.append(subscription.queue.get_nowait().payload)
    return out


async def test_matches_get_sequential_ids_and_the_latest_is_current():
    control, _ = controller(InstantClock)
    assert control.current is None and not control.exists("m-1")
    first = await control.start(11, 30)
    assert (first, control.current) == ("m-1", "m-1") and control.exists("m-1")
    second = await control.start(12, 30)
    assert (second, control.current) == ("m-2", "m-2")
    assert control.exists("m-1") and control.exists("m-2") and not control.exists("m-3")
    await control.stop()


async def test_replacing_a_running_match_tells_its_viewers_it_was_abandoned():
    control, statuses = controller(StuckClock)
    await control.start(11, 30)
    await asyncio.sleep(0.05)
    await control.start(11, 30)
    await asyncio.sleep(0.05)
    seen = [(s.match_id, s.state) for s in drain(statuses)]
    assert seen == [("m-1", "live"), ("m-1", "abandoned"), ("m-2", "live")]
    await control.stop()


async def test_the_new_match_is_current_by_the_time_viewers_hear_of_the_abandonment():
    control, statuses = controller(StuckClock)
    await control.start(11, 30)
    await asyncio.sleep(0.05)
    current_when_heard = []
    original = control._bus.publish

    async def spy(topic, match_id, payload):
        if getattr(payload, "state", None) == "abandoned":
            current_when_heard.append(control.current)
        await original(topic, match_id, payload)

    control._bus.publish = spy
    await control.start(11, 30)
    assert current_when_heard == ["m-2"]
    await control.stop()


async def test_a_finished_match_is_not_marked_abandoned():
    control, statuses = controller(InstantClock)
    await control.start(11, 30)
    await asyncio.wait_for(control.wait(), 20)
    await control.start(11, 30)
    await asyncio.wait_for(control.wait(), 20)
    states = [(s.match_id, s.state) for s in drain(statuses)]
    assert ("m-1", "finished") in states and ("m-1", "abandoned") not in states
    await control.stop()


async def test_stop_is_safe_to_call_with_nothing_running():
    control, _ = controller(InstantClock)
    await control.stop()
    await control.wait()
```

- [ ] **Step 2: Run the controller tests to verify they fail**

Run: `uv run pytest tests/test_control.py -v`
Expected: collection error, `ModuleNotFoundError: No module named 'kickstream.control'`.

- [ ] **Step 3: Write the controller**

`services/pipeline/kickstream/control.py`:

```python
"""Starts and replaces the running match. Part of the composition layer, not a stage."""

import asyncio
import contextlib
from collections.abc import Callable

from kickstream.contracts import MatchStatus, TeamSheet
from kickstream.ports.bus import STATUS, EventBus
from kickstream.ports.clock import Clock
from kickstream.simulator.generate import generate
from kickstream.simulator.stage import Simulator


class MatchController:
    def __init__(self, bus: EventBus, clock_factory: Callable[[float], Clock], home: TeamSheet,
                 away: TeamSheet) -> None:
        self._bus = bus
        self._clock_factory = clock_factory
        self._home = home
        self._away = away
        self._started: list[str] = []
        self._simulator: Simulator | None = None
        self._task: asyncio.Task | None = None

    @property
    def current(self) -> str | None:
        return self._started[-1] if self._started else None

    def exists(self, match_id: str) -> bool:
        return match_id in self._started

    async def start(self, seed: int, speed: float) -> str:
        interrupted = await self._cancel_running()
        match_id = f"m-{len(self._started) + 1}"
        events = generate(match_id, seed, self._home, self._away)
        self._simulator = Simulator(self._bus, self._clock_factory(speed))
        self._task = asyncio.create_task(self._simulator.play(match_id, events, self._home, self._away, speed))
        self._started.append(match_id)
        # Announce the abandonment only once the new match is current, so a viewer who
        # reacts by asking for the current match is sent to the new one.
        await self._announce_abandoned(interrupted)
        return match_id

    async def stop(self) -> None:
        await self._announce_abandoned(await self._cancel_running())

    async def _cancel_running(self) -> MatchStatus | None:
        """Cancel the running match. Returns its last status if it was cut short."""
        task, simulator = self._task, self._simulator
        self._task = self._simulator = None
        if task is None or task.done():
            return None
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        status = simulator.status
        return status if status is not None and status.state != "finished" else None

    async def _announce_abandoned(self, status: MatchStatus | None) -> None:
        if status is not None:
            await self._bus.publish(STATUS, status.match_id, status.model_copy(update={"state": "abandoned"}))

    async def wait(self) -> None:
        if self._task is not None:
            await self._task
```

- [ ] **Step 4: Run the controller tests to verify they pass**

Run: `uv run pytest tests/test_control.py -v`
Expected: 5 passed.

- [ ] **Step 5: Write the failing API, pipeline and architecture tests**

`services/pipeline/tests/test_api.py`:

```python
import time

import pytest
from fastapi.testclient import TestClient

from kickstream.adapters.clocks import InstantClock
from kickstream.app import Settings, create_app
from kickstream.gateway.api import parse_last_event_id


@pytest.fixture
def client(tmp_path):
    settings = Settings(None, None, None, cache_dir=tmp_path)
    with TestClient(create_app(settings, clock_factory=lambda speed: InstantClock())) as test_client:
        yield test_client


def test_teams_lists_both_fictional_clubs(client):
    body = client.get("/api/teams").json()
    assert (body["home"]["name"], body["away"]["name"]) == ("Northbridge FC", "Harbour City")
    assert len(body["home"]["players"]) == 14


def test_current_match_is_404_until_one_starts_then_names_the_latest(client):
    assert client.get("/api/matches/current").status_code == 404
    first = client.post("/api/matches")
    assert first.status_code == 201 and first.json() == {"match_id": "m-1"}
    assert client.get("/api/matches/current").json() == {"match_id": "m-1"}
    assert client.post("/api/matches", json={"seed": 3, "speed": 600}).json() == {"match_id": "m-2"}
    assert client.get("/api/matches/current").json() == {"match_id": "m-2"}


@pytest.mark.parametrize("body", [
    {"speed": 0}, {"speed": -5}, {"speed": 600.5}, {"speed": 1e9}, {"speed": "fast"},
    {"seed": -1}, {"seed": "abc"}, {"seed": 2**31}, {"seed": 1.5}, {"pace": 30},
], ids=str)
def test_out_of_range_start_requests_are_rejected_and_start_nothing(client, body):
    response = client.post("/api/matches", json=body)
    assert response.status_code == 422
    assert client.get("/api/matches/current").status_code == 404


def test_stream_for_an_unknown_match_is_404(client):
    assert client.get("/api/matches/m-99/stream").status_code == 404


@pytest.mark.parametrize("query", ["mode=coach", "lang=fr", "mode=", "lang=EN"])
def test_stream_rejects_unknown_modes_and_languages(client, query):
    client.post("/api/matches")
    assert client.get(f"/api/matches/m-1/stream?{query}").status_code == 422


@pytest.mark.parametrize("value, expected", [
    (None, 0), ("", 0), ("17", 17), ("abc", 0), ("-4", 0), ("3.5", 0), ("  9 ", 0), ("9" * 40, 0),
])
def test_a_garbage_last_event_id_means_replay_from_the_start(value, expected):
    assert parse_last_event_id(value) == expected


def _latest_overlays(client, match_id, lang="en"):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        body = client.get(f"/api/matches/{match_id}/overlays/latest?lang={lang}").json()
        if body.get("recap_card", {}).get("data", {}).get("title", "").startswith(("Full-time", "Final")):
            return body
        time.sleep(0.1)
    raise AssertionError("the match did not reach its full-time recap card")


def test_latest_overlays_expose_one_overlay_per_kind_in_the_requested_language(client):
    match_id = client.post("/api/matches").json()["match_id"]
    english = _latest_overlays(client, match_id)
    assert set(english) == {"lower_third", "stat_card", "pressure_map", "recap_card"}
    assert english["recap_card"]["data"]["title"].startswith("Full-time:")
    assert english["stat_card"]["data"]["stat_rows"][1]["label"] == "Shots"
    spanish = _latest_overlays(client, match_id, "es")
    assert spanish["recap_card"]["data"]["title"].startswith("Final:")
    assert spanish["pressure_map"] == english["pressure_map"]


def test_latest_overlays_errors(client):
    assert client.get("/api/matches/m-99/overlays/latest").status_code == 404
    client.post("/api/matches")
    assert client.get("/api/matches/m-1/overlays/latest?lang=de").status_code == 422
```

`services/pipeline/tests/test_pipeline.py`:

```python
import asyncio
from collections import Counter

from kickstream.adapters.clocks import InstantClock
from kickstream.app import Settings, build_pipeline
from kickstream.contracts import Overlay, ViewerProfile
from kickstream.domain.demo import DEMO_SEED
from kickstream.domain.types import VARIANTS
from kickstream.gateway.personalize import to_envelope

from tests.factories import FakeWriter


async def _play(tmp_path, writer=None):
    pipeline = build_pipeline(Settings(None, None, None, cache_dir=tmp_path),
                              clock_factory=lambda speed: InstantClock(), writer=writer)
    pipeline.start()
    match_id = await pipeline.controller.start(DEMO_SEED, 600)
    await asyncio.wait_for(pipeline.controller.wait(), 30)
    for _ in range(300):
        cards = [i for i in pipeline.store.read(match_id) if i.type == "overlay" and i.payload.kind == "recap_card"]
        if len(cards) == 6:
            break
        await asyncio.sleep(0.1)
    else:
        raise AssertionError("pipeline did not drain")
    log = pipeline.store.read(match_id)
    await pipeline.stop()
    return log


async def test_one_match_flows_through_all_five_stages(tmp_path):
    log = await _play(tmp_path)
    by_type = Counter(item.type for item in log)
    assert [item.id for item in log] == list(range(1, len(log) + 1))
    assert set(by_type) == {"match_status", "match_event", "stats", "pressure", "key_moment", "narrative", "recap", "overlay"}

    moments = [item.payload for item in log if item.type == "key_moment"]
    narratives = [item.payload for item in log if item.type == "narrative"]
    assert 10 <= len(moments) <= 20
    for moment in moments:
        variants = {(n.mode, n.language) for n in narratives if n.moment_id == moment.id}
        assert variants == set(VARIANTS), f"{moment.id} is missing a variant"
    assert {n.source for n in narratives} == {"scripted"}

    recaps = [item.payload for item in log if item.type == "recap"]
    assert Counter(r.period for r in recaps) == {"half_time": 6, "full_time": 6}

    overlays = [item.payload for item in log if item.type == "overlay"]
    assert {o.kind for o in overlays} == {"lower_third", "stat_card", "pressure_map", "recap_card"}
    for overlay in overlays:
        assert Overlay.model_validate_json(overlay.model_dump_json()) == overlay

    goals = Counter(item.payload.team for item in log if item.type == "match_event" and item.payload.type == "goal")
    final = [item.payload for item in log if item.type == "match_status"][-1]
    assert (final.state, final.score_home, final.score_away) == ("finished", goals["home"], goals["away"])
    full_time = next(r for r in recaps if r.period == "full_time")
    assert (full_time.score_home, full_time.score_away) == (final.score_home, final.score_away)


async def test_each_viewer_sees_exactly_one_narrative_per_key_moment(tmp_path):
    log = await _play(tmp_path)
    moment_ids = [item.payload.id for item in log if item.type == "key_moment"]
    for mode, language in VARIANTS:
        profile = ViewerProfile(mode=mode, language=language)
        seen = [e for e in (to_envelope(item, profile) for item in log) if e is not None and e.type == "narrative"]
        assert [e.payload["moment_id"] for e in seen] == moment_ids
        assert {(e.payload["mode"], e.payload["language"]) for e in seen} == {(mode, language)}


async def test_with_a_writer_configured_goals_and_recaps_are_agent_written(tmp_path):
    log = await _play(tmp_path, writer=FakeWriter())
    narratives = [item.payload for item in log if item.type == "narrative"]
    goal_ids = {item.payload.id for item in log if item.type == "key_moment" and item.payload.kind == "goal"}
    assert goal_ids and {n.source for n in narratives if n.moment_id in goal_ids} == {"agent"}
    assert {item.payload.source for item in log if item.type == "recap"} == {"agent"}
    assert any(tmp_path.iterdir()), "agent output is cached on disk"
```

`services/pipeline/tests/test_architecture.py`:

```python
import ast
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1] / "kickstream"
STAGES = {"simulator", "analytics", "narration", "overlay", "gateway"}
SHARED = {"contracts", "domain", "ports"}


def _kickstream_imports(path: Path) -> set[str]:
    found = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("kickstream."):
            found.add(node.module.split(".")[1])
        elif isinstance(node, ast.Import):
            found.update(alias.name.split(".")[1] for alias in node.names if alias.name.startswith("kickstream."))
    return found


def test_a_stage_imports_only_itself_and_the_shared_packages():
    for stage in STAGES:
        files = list((PACKAGE / stage).rglob("*.py"))
        assert files, f"stage {stage} has no modules"
        for path in files:
            unexpected = _kickstream_imports(path) - SHARED - {stage}
            assert not unexpected, f"{path.relative_to(PACKAGE)} imports {sorted(unexpected)}"


def test_concrete_adapters_are_named_only_in_the_composition_root():
    for path in PACKAGE.rglob("*.py"):
        if path.parent.name == "adapters" or path.name == "app.py":
            continue
        assert "adapters" not in _kickstream_imports(path), f"{path.relative_to(PACKAGE)} imports an adapter"


def test_shared_packages_do_not_depend_on_stages_or_adapters():
    for shared in ("domain", "ports"):
        for path in (PACKAGE / shared).rglob("*.py"):
            unexpected = _kickstream_imports(path) - SHARED
            assert not unexpected, f"{path.relative_to(PACKAGE)} imports {sorted(unexpected)}"
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `uv run pytest tests/test_api.py tests/test_pipeline.py tests/test_architecture.py -v`
Expected: `test_architecture.py` passes (3 passed); the other two modules fail at collection with `ModuleNotFoundError: No module named 'kickstream.app'`.

- [ ] **Step 7: Write the HTTP API**

`services/pipeline/kickstream/gateway/api.py`:

```python
from collections.abc import Awaitable, Callable
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sse_starlette.sse import EventSourceResponse

from kickstream.contracts import TeamSheet, ViewerProfile
from kickstream.domain.demo import DEMO_SEED
from kickstream.domain.types import Language, Mode
from kickstream.gateway.stream import stream_items
from kickstream.ports.broadcaster import Broadcaster
from kickstream.ports.store import MatchStore

MAX_SPEED = 600.0
_MAX_ID_DIGITS = 18


class StartMatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    seed: int = Field(default=DEMO_SEED, ge=0, le=2**31 - 1)
    speed: float = Field(default=30.0, ge=1.0, le=MAX_SPEED)


def parse_last_event_id(value: str | None) -> int:
    """A missing or malformed Last-Event-ID means: replay from the start."""
    if value and value.isascii() and value.isdigit() and len(value) <= _MAX_ID_DIGITS:
        return int(value)
    return 0


def build_router(*, store: MatchStore, broadcaster: Broadcaster, teams: tuple[TeamSheet, TeamSheet],
                 start_match: Callable[[int, float], Awaitable[str]], current_match: Callable[[], str | None],
                 match_exists: Callable[[str], bool]) -> APIRouter:
    router = APIRouter(prefix="/api")

    def require(match_id: str) -> None:
        if not match_exists(match_id):
            raise HTTPException(status_code=404, detail=f"unknown match {match_id}")

    @router.get("/teams")
    def get_teams() -> dict[str, TeamSheet]:
        return {"home": teams[0], "away": teams[1]}

    @router.post("/matches", status_code=201)
    async def post_match(body: StartMatch | None = None) -> dict[str, str]:
        request = body or StartMatch()
        return {"match_id": await start_match(request.seed, request.speed)}

    @router.get("/matches/current")
    def get_current() -> dict[str, str]:
        match_id = current_match()
        if match_id is None:
            raise HTTPException(status_code=404, detail="no match has been started")
        return {"match_id": match_id}

    @router.get("/matches/{match_id}/stream")
    async def get_stream(match_id: str, mode: Mode = "fan", lang: Language = "en", club: str | None = None,
                         player: str | None = None,
                         last_event_id: Annotated[str | None, Header()] = None) -> EventSourceResponse:
        require(match_id)
        profile = ViewerProfile(mode=mode, language=lang, club=club or None, player=player or None)

        async def events():
            async for envelope in stream_items(store, broadcaster, match_id, profile, parse_last_event_id(last_event_id)):
                yield {"id": str(envelope.id), "data": envelope.model_dump_json()}

        return EventSourceResponse(events())

    @router.get("/matches/{match_id}/overlays/latest")
    def get_latest_overlays(match_id: str, lang: Language = "en") -> dict[str, dict]:
        require(match_id)
        latest: dict[str, dict] = {}
        for item in store.read(match_id):
            if item.type == "overlay" and item.language in (None, lang):
                latest[item.payload.kind] = item.payload.model_dump(mode="json")
        return latest

    return router
```

`strict=True` on `StartMatch` is what rejects `"speed": "fast"`, `"seed": "abc"` and `"seed": 1.5` instead of coercing them. JSON integers are still accepted for `speed`.

- [ ] **Step 8: Write the composition root**

`services/pipeline/kickstream/app.py`:

```python
"""Composition root. The only module that names concrete adapters."""

import asyncio
import os
from collections.abc import Callable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI

from kickstream.adapters.agent_writer import AgentNarrativeWriter
from kickstream.adapters.clocks import RealClock
from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.adapters.memory_store import InMemoryMatchStore
from kickstream.adapters.scripted_writer import ScriptedNarrativeWriter
from kickstream.adapters.sse_broadcaster import InProcessBroadcaster
from kickstream.analytics.stage import AnalyticsStage
from kickstream.control import MatchController
from kickstream.domain.teams import AWAY, HOME
from kickstream.gateway.api import build_router
from kickstream.gateway.recorder import Recorder
from kickstream.narration.budget import Budget
from kickstream.narration.cache import DiskCache
from kickstream.narration.service import NarrationService
from kickstream.narration.stage import NarrationStage
from kickstream.overlay.stage import OverlayStage
from kickstream.ports.clock import Clock
from kickstream.ports.writer import NarrativeWriter


@dataclass(frozen=True)
class Settings:
    llm_base_url: str | None
    llm_model: str | None
    llm_api_key: str | None
    llm_max_calls: int = 60     # per match; a key moment costs 3 calls, a recap 2
    llm_reserve: int = 15       # kept back for goals and recaps
    llm_min_gap_s: float = 2.0  # between non-priority model calls
    cache_dir: Path = Path(".cache/narration")

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "Settings":
        return cls(
            llm_base_url=env.get("KICKSTREAM_LLM_BASE_URL") or None,
            llm_model=env.get("KICKSTREAM_LLM_MODEL") or None,
            llm_api_key=env.get("KICKSTREAM_LLM_API_KEY") or None,
            llm_max_calls=int(env.get("KICKSTREAM_LLM_MAX_CALLS", "60")),
            cache_dir=Path(env.get("KICKSTREAM_CACHE_DIR", ".cache/narration")),
        )

    @property
    def llm_configured(self) -> bool:
        return bool(self.llm_base_url and self.llm_model and self.llm_api_key)


@dataclass
class Pipeline:
    bus: InMemoryEventBus
    store: InMemoryMatchStore
    broadcaster: InProcessBroadcaster
    controller: MatchController
    stages: list
    tasks: list[asyncio.Task] = field(default_factory=list)

    def start(self) -> None:
        self.tasks = [asyncio.create_task(stage.run()) for stage in self.stages]

    async def stop(self) -> None:
        await self.controller.stop()
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.tasks = []


def build_pipeline(settings: Settings, *, clock_factory: Callable[[float], Clock] = RealClock,
                   writer: NarrativeWriter | None = None) -> Pipeline:
    bus, store, broadcaster = InMemoryEventBus(), InMemoryMatchStore(), InProcessBroadcaster()
    primary = writer
    if primary is None and settings.llm_configured:
        primary = AgentNarrativeWriter(settings.llm_base_url, settings.llm_model, settings.llm_api_key)
    service = NarrationService(
        ScriptedNarrativeWriter(), primary,
        budget=Budget(settings.llm_max_calls, settings.llm_reserve, settings.llm_min_gap_s),
        cache=DiskCache(settings.cache_dir) if primary is not None else None)
    # Every stage subscribes in its constructor, so nothing published after this point is missed.
    stages = [AnalyticsStage(bus), NarrationStage(bus, service), OverlayStage(bus), Recorder(bus, store, broadcaster)]
    return Pipeline(bus, store, broadcaster, MatchController(bus, clock_factory, HOME, AWAY), stages)


def create_app(settings: Settings | None = None, *, clock_factory: Callable[[float], Clock] = RealClock,
               writer: NarrativeWriter | None = None) -> FastAPI:
    pipeline = build_pipeline(settings or Settings.from_env(), clock_factory=clock_factory, writer=writer)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        pipeline.start()
        yield
        await pipeline.stop()

    app = FastAPI(title="Kickstream", lifespan=lifespan)
    app.state.pipeline = pipeline
    app.include_router(build_router(
        store=pipeline.store, broadcaster=pipeline.broadcaster, teams=(HOME, AWAY),
        start_match=pipeline.controller.start, current_match=lambda: pipeline.controller.current,
        match_exists=pipeline.controller.exists))
    return app
```

- [ ] **Step 9: Run the whole Python suite**

Run: `uv run pytest -v`
Expected: every test passes. `test_pipeline.py` takes a few seconds because it plays three full matches.

In `test_with_a_writer_configured_goals_and_recaps_are_agent_written`, non-goal moments may be scripted: with an instant clock the 2-second gap between non-priority model calls is rarely met. That is the budget working, and the test asserts only goals and recaps.

- [ ] **Step 10: Run the server by hand**

Run: `uv run uvicorn kickstream.app:create_app --factory --port 8000`

In a second terminal:

```bash
curl -s -X POST localhost:8000/api/matches -H "content-type: application/json" -d '{"speed": 600}'
curl -sN "localhost:8000/api/matches/m-1/stream?mode=analyst&lang=es" | head -40
```

Expected: `{"match_id":"m-1"}`, then `id:` / `data:` lines whose data are envelopes; narrative envelopes are Spanish analyst text. Stop the server with Ctrl+C.

- [ ] **Step 11: Lint and commit**

Run: `uv run ruff check . && uv run ruff format --check .`
Expected: no findings. Fix any that appear (`uv run ruff format .` for formatting).

```bash
git add services/pipeline
git commit -m "feat: add match control, HTTP API and pipeline composition root"
```

---

### Task 12: Web scaffold, generated TypeScript contracts, i18n and preferences

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml` (repo root)
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`
- Create: `apps/web/scripts/gen-contracts.mjs`, `apps/web/scripts/gen-contracts.d.mts`
- Create (generated): `apps/web/src/contracts.ts`
- Create: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/theme.ts`, `apps/web/src/i18n.ts`, `apps/web/src/prefs.ts`, `apps/web/src/api.ts`, `apps/web/src/test/setup.ts`
- Test: `apps/web/src/contracts.test.ts`, `apps/web/src/i18n.test.ts`, `apps/web/src/prefs.test.ts`, `apps/web/src/api.test.ts`

**Interfaces:**
- Consumes: `packages/contracts/kickstream.schema.json`; the HTTP surface from Task 11.
- Produces:
  - `src/contracts.ts`: TypeScript interfaces with the same names as the schema definitions (`MatchEvent`, `Narrative`, `Overlay`, `Envelope`, `ViewerProfile`, `TeamSheet`, …).
  - `src/i18n.ts`: `type Language = "en" | "es" | "hi"`, `type Mode = "fan" | "analyst"`, `LANGUAGES`, `MODES`, `LANGUAGE_NAMES`, `type StringKey`, `t(language: Language, key: StringKey): string`.
  - `src/prefs.ts`: `DEFAULT_PROFILE`, `loadProfile(storage?) : ViewerProfile`, `saveProfile(profile, storage?) : void`.
  - `src/api.ts`: `type Teams = { home: TeamSheet; away: TeamSheet }`, `fetchTeams(): Promise<Teams>`, `fetchCurrentMatch(): Promise<string | null>`, `startMatch(speed: number): Promise<string>`, `streamUrl(matchId: string, profile: ViewerProfile): string`, `speedFromLocation(search: string): number`.
  - `src/theme.ts`: `useSystemTheme(): Theme`.

- [ ] **Step 1: Write the workspace and package files**

`package.json` (repo root):

```json
{
  "name": "kickstream",
  "private": true,
  "packageManager": "pnpm@10.32.1",
  "scripts": {
    "dev:api": "uv run --project services/pipeline uvicorn kickstream.app:create_app --factory --port 8000",
    "dev:web": "pnpm --filter @kickstream/web dev",
    "test:api": "uv run --project services/pipeline pytest services/pipeline/tests",
    "test:web": "pnpm --filter @kickstream/web test"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
```

`apps/web/package.json`:

```json
{
  "name": "@kickstream/web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "gen:contracts": "node scripts/gen-contracts.mjs",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@fluentui/react-components": "9.74.9",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "zustand": "5.0.15"
  },
  "devDependencies": {
    "@playwright/test": "1.64.0",
    "@testing-library/react": "16.3.3",
    "@types/node": "^24",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "@vitejs/plugin-react": "6.1.2",
    "jsdom": "30.1.2",
    "json-schema-to-typescript": "16.0.0",
    "typescript": "7.0.2",
    "vite": "8.3.4",
    "vitest": "5.0.4"
  }
}
```

`apps/web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "types": ["vitest/globals", "node"]
  },
  "include": ["src", "scripts", "e2e", "vite.config.ts", "playwright.config.ts"]
}
```

`apps/web/vite.config.ts`:

```ts
/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8000" } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Kickstream</title>
    <style>
      html, body, #root { height: 100%; margin: 0; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/test/setup.ts`:

```ts
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// jsdom does not implement these browser APIs that Fluent UI components call.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
```

Run (from the repo root): `pnpm install`
Expected: dependencies install with no peer-dependency errors.

- [ ] **Step 2: Write the contract generator and generate the types**

`apps/web/scripts/gen-contracts.mjs`:

```js
// Generates src/contracts.ts from the shared JSON Schema. Run: pnpm gen:contracts
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compileFromFile } from "json-schema-to-typescript";

const schema = fileURLToPath(new URL("../../../packages/contracts/kickstream.schema.json", import.meta.url));
export const target = fileURLToPath(new URL("../src/contracts.ts", import.meta.url));

export async function render() {
  return compileFromFile(schema, {
    unreachableDefinitions: true,
    bannerComment:
      "/* Generated from packages/contracts/kickstream.schema.json. Do not edit. Run `pnpm gen:contracts`. */",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(target, await render());
}
```

`apps/web/scripts/gen-contracts.d.mts`:

```ts
export const target: string;
export function render(): Promise<string>;
```

Run: `pnpm gen:contracts`
Expected: `src/contracts.ts` exists and contains `export interface MatchEvent {`, `export interface Envelope {` and `mode: "fan" | "analyst";`.

- [ ] **Step 3: Write the failing tests**

`apps/web/src/contracts.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { render, target } from "../scripts/gen-contracts.mjs";
import type { Envelope, Narrative, Overlay } from "./contracts";

const normalized = (text: string) => text.replace(/\r\n/g, "\n");

test("generated contracts are current", async () => {
  expect(normalized(await readFile(target, "utf8"))).toBe(normalized(await render()));
});

test("generated types match what the gateway sends", () => {
  const narrative: Narrative = {
    id: "m-1-k1-fan-en", match_id: "m-1", minute: 10, moment_id: "m-1-k1", mode: "fan", language: "en",
    text: "GOAL!", source: "scripted", agent: "scripted", evidence: ["m-1-k1"], team: "home", player_id: null,
  };
  const overlay: Overlay = {
    id: "m-1-o1", match_id: "m-1", minute: 10, kind: "pressure_map", language: null, duration_ms: 8000,
    sources: [], data: { cols: 6, rows: 4, home: [], away: [] },
  };
  const envelope: Envelope = { id: 1, type: "narrative", match_id: "m-1", minute: 10, highlighted: false, payload: { ...narrative } };
  expect([narrative.mode, overlay.kind, envelope.type]).toEqual(["fan", "pressure_map", "narrative"]);
});
```

`apps/web/src/i18n.test.ts`:

```ts
import { LANGUAGES, LANGUAGE_NAMES, STRINGS, t } from "./i18n";

test("every language defines every string, with no blanks", () => {
  const keys = Object.keys(STRINGS.en).sort();
  for (const language of LANGUAGES) {
    expect(Object.keys(STRINGS[language]).sort()).toEqual(keys);
    for (const value of Object.values(STRINGS[language])) expect(value.trim()).not.toBe("");
  }
});

test("t returns the string for the language", () => {
  expect(t("en", "start")).toBe("Start match");
  expect(t("es", "start")).toBe("Iniciar partido");
  expect(t("hi", "analyst")).toBe("विश्लेषक");
  expect(LANGUAGE_NAMES.es).toBe("Español");
});
```

`apps/web/src/prefs.test.ts`:

```ts
import { DEFAULT_PROFILE, loadProfile, saveProfile } from "./prefs";

const KEY = "kickstream.profile";

test("a saved profile is read back", () => {
  saveProfile({ mode: "analyst", language: "hi", club: "nbr", player: "nbr-9" });
  expect(loadProfile()).toEqual({ mode: "analyst", language: "hi", club: "nbr", player: "nbr-9" });
});

test("nothing saved gives the defaults", () => {
  expect(loadProfile()).toEqual(DEFAULT_PROFILE);
  expect(DEFAULT_PROFILE).toEqual({ mode: "fan", language: "en", club: null, player: null });
});

test.each([
  ["invalid JSON", "{not json"],
  ["a non-object", '"fan"'],
  ["null", "null"],
  ["an array", "[1,2]"],
])("%s gives the defaults", (_, raw) => {
  localStorage.setItem(KEY, raw);
  expect(loadProfile()).toEqual(DEFAULT_PROFILE);
});

test("unknown or mistyped fields fall back one by one", () => {
  localStorage.setItem(KEY, JSON.stringify({ mode: "coach", language: "fr", club: 7, player: "" }));
  expect(loadProfile()).toEqual(DEFAULT_PROFILE);
  localStorage.setItem(KEY, JSON.stringify({ mode: "analyst", language: "de", club: "nbr" }));
  expect(loadProfile()).toEqual({ mode: "analyst", language: "en", club: "nbr", player: null });
});

test("storage that throws is tolerated on read and write", () => {
  const broken = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("quota"); },
  };
  expect(loadProfile(broken)).toEqual(DEFAULT_PROFILE);
  expect(() => saveProfile(DEFAULT_PROFILE, broken)).not.toThrow();
});
```

`apps/web/src/api.test.ts`:

```ts
import { fetchCurrentMatch, speedFromLocation, startMatch, streamUrl } from "./api";

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

test("streamUrl carries the profile and omits unset favorites", () => {
  expect(streamUrl("m-1", { mode: "fan", language: "en", club: null, player: null }))
    .toBe("/api/matches/m-1/stream?mode=fan&lang=en");
  expect(streamUrl("m 2", { mode: "analyst", language: "hi", club: "nbr", player: "nbr-9" }))
    .toBe("/api/matches/m%202/stream?mode=analyst&lang=hi&club=nbr&player=nbr-9");
});

test.each([
  ["", 30], ["?speed=600", 600], ["?speed=1", 1], ["?speed=0", 30], ["?speed=9999", 30],
  ["?speed=fast", 30], ["?speed=-3", 30], ["?other=1", 30],
])("speedFromLocation(%j) is %d", (search, expected) => {
  expect(speedFromLocation(search)).toBe(expected);
});

test("fetchCurrentMatch returns the id, or null when no match has started", async () => {
  vi.stubGlobal("fetch", respond(200, { match_id: "m-3" }));
  expect(await fetchCurrentMatch()).toBe("m-3");
  vi.stubGlobal("fetch", respond(404, { detail: "no match has been started" }));
  expect(await fetchCurrentMatch()).toBeNull();
});

test("startMatch posts the speed and returns the new id", async () => {
  const fetchMock = respond(201, { match_id: "m-4" });
  vi.stubGlobal("fetch", fetchMock);
  expect(await startMatch(600)).toBe("m-4");
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/matches");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body as string)).toEqual({ speed: 600 });
});

test("a failed request rejects with the status", async () => {
  vi.stubGlobal("fetch", respond(500, {}));
  await expect(startMatch(30)).rejects.toThrow("500");
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm test`
Expected: `contracts.test.ts` passes; the other three fail to resolve `./i18n`, `./prefs` and `./api`.

- [ ] **Step 5: Write i18n, preferences, API client and theme**

`apps/web/src/i18n.ts`:

```ts
export type Language = "en" | "es" | "hi";
export type Mode = "fan" | "analyst";

export const LANGUAGES: readonly Language[] = ["en", "es", "hi"];
export const MODES: readonly Mode[] = ["fan", "analyst"];
export const LANGUAGE_NAMES: Record<Language, string> = { en: "English", es: "Español", hi: "हिन्दी" };

const en = {
  appTitle: "Kickstream",
  start: "Start match",
  restart: "Restart match",
  mode: "Viewing mode",
  fan: "Fan",
  analyst: "Analyst",
  language: "Language",
  preferences: "Preferences",
  favoriteClub: "Favorite club",
  favoritePlayer: "Favorite player",
  none: "None",
  close: "Close",
  matchTab: "Match",
  overlayTab: "Overlay",
  noMatch: "No match is running. Start one to begin.",
  idle: "Idle",
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  pitch: "Pitch",
  pressureMap: "Pressure map",
  stats: "Match stats",
  possession: "Possession %",
  shots: "Shots",
  shotsOnTarget: "Shots on target",
  xg: "Expected goals",
  passAccuracy: "Pass accuracy %",
  momentum: "Momentum",
  timeline: "Key moments",
  feed: "Live narrative",
  feedEmpty: "Narratives appear here as key moments happen.",
  scripted: "Scripted",
  highlighted: "Highlighted for you",
  pipeline: "How this was made",
  pipelineEmpty: "Select a narrative to see which stage and agent produced it.",
  evidence: "Evidence",
  halfTime: "Half-time recap",
  fullTime: "Full-time recap",
  copy: "Copy JSON",
  copied: "Copied",
  overlayEmpty: "Overlays appear here once the match starts.",
  kind_goal: "Goal",
  kind_red_card: "Red card",
  kind_big_chance: "Big chance",
  kind_momentum_swing: "Momentum shift",
  kind_sustained_pressure: "Sustained pressure",
  overlay_lower_third: "Lower third",
  overlay_stat_card: "Stat card",
  overlay_pressure_map: "Pressure map",
  overlay_recap_card: "Recap card",
  stageIngest: "Ingest",
  stageInterpret: "Interpret",
  stageExplain: "Explain",
  stageRender: "Render",
  stagePersonalize: "Personalize",
};

export type StringKey = keyof typeof en;

const es: Record<StringKey, string> = {
  appTitle: "Kickstream",
  start: "Iniciar partido",
  restart: "Reiniciar partido",
  mode: "Modo de visualización",
  fan: "Aficionado",
  analyst: "Analista",
  language: "Idioma",
  preferences: "Preferencias",
  favoriteClub: "Club favorito",
  favoritePlayer: "Jugador favorito",
  none: "Ninguno",
  close: "Cerrar",
  matchTab: "Partido",
  overlayTab: "Gráficos",
  noMatch: "No hay ningún partido en curso. Inicia uno para empezar.",
  idle: "Inactivo",
  connecting: "Conectando",
  live: "En directo",
  reconnecting: "Reconectando",
  pitch: "Campo",
  pressureMap: "Mapa de presión",
  stats: "Estadísticas",
  possession: "Posesión %",
  shots: "Remates",
  shotsOnTarget: "Remates a puerta",
  xg: "Goles esperados",
  passAccuracy: "Precisión de pase %",
  momentum: "Impulso",
  timeline: "Momentos clave",
  feed: "Narración en directo",
  feedEmpty: "Las narraciones aparecen aquí cuando ocurren momentos clave.",
  scripted: "Plantilla",
  highlighted: "Destacado para ti",
  pipeline: "Cómo se generó",
  pipelineEmpty: "Selecciona una narración para ver qué etapa y qué agente la generó.",
  evidence: "Evidencia",
  halfTime: "Resumen del descanso",
  fullTime: "Resumen final",
  copy: "Copiar JSON",
  copied: "Copiado",
  overlayEmpty: "Los gráficos aparecen aquí cuando empieza el partido.",
  kind_goal: "Gol",
  kind_red_card: "Tarjeta roja",
  kind_big_chance: "Gran ocasión",
  kind_momentum_swing: "Cambio de impulso",
  kind_sustained_pressure: "Presión sostenida",
  overlay_lower_third: "Faldón",
  overlay_stat_card: "Tarjeta de estadísticas",
  overlay_pressure_map: "Mapa de presión",
  overlay_recap_card: "Tarjeta de resumen",
  stageIngest: "Ingesta",
  stageInterpret: "Interpretación",
  stageExplain: "Explicación",
  stageRender: "Renderizado",
  stagePersonalize: "Personalización",
};

const hi: Record<StringKey, string> = {
  appTitle: "Kickstream",
  start: "मैच शुरू करें",
  restart: "मैच फिर शुरू करें",
  mode: "देखने का मोड",
  fan: "फ़ैन",
  analyst: "विश्लेषक",
  language: "भाषा",
  preferences: "पसंद",
  favoriteClub: "पसंदीदा क्लब",
  favoritePlayer: "पसंदीदा खिलाड़ी",
  none: "कोई नहीं",
  close: "बंद करें",
  matchTab: "मैच",
  overlayTab: "ओवरले",
  noMatch: "कोई मैच नहीं चल रहा है। शुरू करने के लिए एक मैच शुरू करें।",
  idle: "निष्क्रिय",
  connecting: "कनेक्ट हो रहा है",
  live: "लाइव",
  reconnecting: "फिर से कनेक्ट हो रहा है",
  pitch: "मैदान",
  pressureMap: "दबाव मानचित्र",
  stats: "मैच आँकड़े",
  possession: "कब्ज़ा %",
  shots: "शॉट",
  shotsOnTarget: "निशाने पर शॉट",
  xg: "अपेक्षित गोल",
  passAccuracy: "पास सटीकता %",
  momentum: "गति",
  timeline: "अहम पल",
  feed: "लाइव कमेंट्री",
  feedEmpty: "अहम पल होते ही कमेंट्री यहाँ दिखेगी।",
  scripted: "स्क्रिप्टेड",
  highlighted: "आपके लिए हाइलाइट",
  pipeline: "यह कैसे बना",
  pipelineEmpty: "किस चरण और एजेंट ने इसे बनाया, यह देखने के लिए कोई कमेंट्री चुनें।",
  evidence: "साक्ष्य",
  halfTime: "हाफ टाइम सारांश",
  fullTime: "फुल टाइम सारांश",
  copy: "JSON कॉपी करें",
  copied: "कॉपी हो गया",
  overlayEmpty: "मैच शुरू होते ही ओवरले यहाँ दिखेंगे।",
  kind_goal: "गोल",
  kind_red_card: "रेड कार्ड",
  kind_big_chance: "बड़ा मौका",
  kind_momentum_swing: "रुख बदला",
  kind_sustained_pressure: "लगातार दबाव",
  overlay_lower_third: "लोअर थर्ड",
  overlay_stat_card: "आँकड़ा कार्ड",
  overlay_pressure_map: "दबाव मानचित्र",
  overlay_recap_card: "सारांश कार्ड",
  stageIngest: "इनजेस्ट",
  stageInterpret: "व्याख्या",
  stageExplain: "समझाना",
  stageRender: "रेंडर",
  stagePersonalize: "वैयक्तिकरण",
};

export const STRINGS: Record<Language, Record<StringKey, string>> = { en, es, hi };

export function t(language: Language, key: StringKey): string {
  return STRINGS[language][key];
}
```

`apps/web/src/prefs.ts`:

```ts
import type { ViewerProfile } from "./contracts";
import { LANGUAGES, MODES } from "./i18n";

const KEY = "kickstream.profile";

export const DEFAULT_PROFILE: ViewerProfile = { mode: "fan", language: "en", club: null, player: null };

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Reads saved preferences. Anything missing, mistyped or unsupported falls back to its default. */
export function loadProfile(storage: Pick<Storage, "getItem"> = localStorage): ViewerProfile {
  try {
    const raw: unknown = JSON.parse(storage.getItem(KEY) ?? "null");
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_PROFILE;
    const saved = raw as Record<string, unknown>;
    return {
      mode: MODES.find((mode) => mode === saved.mode) ?? DEFAULT_PROFILE.mode,
      language: LANGUAGES.find((language) => language === saved.language) ?? DEFAULT_PROFILE.language,
      club: text(saved.club),
      player: text(saved.player),
    };
  } catch {
    return DEFAULT_PROFILE;
  }
}

export function saveProfile(profile: ViewerProfile, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(KEY, JSON.stringify(profile));
  } catch {
    // Preferences are a convenience; a full or blocked store must not break the app.
  }
}
```

`apps/web/src/api.ts`:

```ts
import type { TeamSheet, ViewerProfile } from "./contracts";

export interface Teams {
  home: TeamSheet;
  away: TeamSheet;
}

const DEFAULT_SPEED = 30;
const MAX_SPEED = 600;

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`request failed with status ${response.status}`);
  return (await response.json()) as T;
}

export async function fetchTeams(): Promise<Teams> {
  return json<Teams>(await fetch("/api/teams"));
}

/** The running (or most recent) match, or null when none has been started. */
export async function fetchCurrentMatch(): Promise<string | null> {
  const response = await fetch("/api/matches/current");
  if (response.status === 404) return null;
  return (await json<{ match_id: string }>(response)).match_id;
}

export async function startMatch(speed: number): Promise<string> {
  const response = await fetch("/api/matches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ speed }),
  });
  return (await json<{ match_id: string }>(response)).match_id;
}

export function streamUrl(matchId: string, profile: ViewerProfile): string {
  const query = new URLSearchParams({ mode: profile.mode, lang: profile.language });
  if (profile.club) query.set("club", profile.club);
  if (profile.player) query.set("player", profile.player);
  return `/api/matches/${encodeURIComponent(matchId)}/stream?${query}`;
}

/** Playback speed from `?speed=`, used by the end-to-end test. Out-of-range values give the default. */
export function speedFromLocation(search: string): number {
  const speed = Number(new URLSearchParams(search).get("speed"));
  return Number.isFinite(speed) && speed >= 1 && speed <= MAX_SPEED ? speed : DEFAULT_SPEED;
}
```

`apps/web/src/theme.ts`:

```ts
import { type Theme, webDarkTheme, webLightTheme } from "@fluentui/react-components";
import { useEffect, useState } from "react";

const QUERY = "(prefers-color-scheme: dark)";

/** Follows the operating system's light or dark setting. */
export function useSystemTheme(): Theme {
  const [dark, setDark] = useState(() => window.matchMedia(QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(QUERY);
    const onChange = (event: MediaQueryListEvent) => setDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return dark ? webDarkTheme : webLightTheme;
}
```

- [ ] **Step 6: Write the application shell**

`apps/web/src/App.tsx` (Task 15 replaces this shell with the full dashboard):

```tsx
import { Text } from "@fluentui/react-components";

export function App() {
  return (
    <main>
      <Text as="h1" size={600} weight="semibold">
        Kickstream
      </Text>
    </main>
  );
}
```

`apps/web/src/main.tsx`:

```tsx
import { FluentProvider } from "@fluentui/react-components";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { useSystemTheme } from "./theme";

function Root() {
  return (
    <FluentProvider theme={useSystemTheme()} style={{ minHeight: "100%" }}>
      <App />
    </FluentProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
```

- [ ] **Step 7: Run the tests and the type check**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass; no type errors.

Run: `pnpm dev`, open `http://127.0.0.1:5173`.
Expected: a page titled "Kickstream" in the Fluent typeface, dark when the system is in dark mode. Stop with Ctrl+C.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml apps/web
git commit -m "feat: scaffold Fluent UI web app with generated contract types"
```

---

### Task 13: Stream store and stream client

**Files:**
- Create: `apps/web/src/stream/store.ts`, `apps/web/src/stream/client.ts`, `apps/web/src/test/fixtures.ts`
- Test: `apps/web/src/stream/store.test.ts`, `apps/web/src/stream/client.test.ts`

**Interfaces:**
- Consumes: `src/contracts.ts`.
- Produces:
  - `stream/store.ts`:
    - `type Connection = "idle" | "connecting" | "live" | "reconnecting" | "no_match"`
    - `interface FeedNarrative extends Narrative { highlighted: boolean }`, `interface FeedMoment extends KeyMoment { highlighted: boolean }`
    - `interface MatchData { lastId: number; status: MatchStatus | null; events: MatchEvent[]; stats: StatsSnapshot | null; pressure: PressureSnapshot | null; moments: FeedMoment[]; narratives: FeedNarrative[]; recaps: Recap[]; overlays: Overlay[] }`. `narratives` is newest first; `events` keeps the last 40; `overlays` keeps the last 300.
    - `EMPTY: MatchData`, `reduce(data: MatchData, envelope: Envelope): MatchData` (pure; ignores an envelope whose `id` is not greater than `lastId`), `latestOverlays(overlays: Overlay[]): Partial<Record<Overlay["kind"], Overlay>>`.
    - `useMatch`: a zustand store `{ data, connection, selectedId, apply(envelope), reset(), setConnection(connection), select(momentId | null) }`. `selectedId` is a key-moment ID.
  - `stream/client.ts`: `connect(url: string, handlers: { onEnvelope(envelope: Envelope): void; onConnection(connection: Connection): void }, EventSourceImpl?: new (url: string) => EventSource): () => void`. Returns a function that closes the connection.
  - `test/fixtures.ts`: `status()`, `matchEvent()`, `stats()`, `pressure()`, `moment()`, `narrative()`, `recap()`, `overlay()` builders taking partial overrides; `envelope(id, type, payload, highlighted?)`; `class FakeEventSource` with static `instances`, static `last`, and instance methods `open()`, `emit(envelope)`, `emitRaw(data)`, `fail(readyState)`.

- [ ] **Step 1: Write the fixtures**

`apps/web/src/test/fixtures.ts`:

```ts
import type {
  Envelope, KeyMoment, MatchEvent, MatchStatus, Narrative, Overlay, PressureSnapshot, Recap, StatsSnapshot,
  TeamSheet, TeamStats,
} from "../contracts";

export const HOME: TeamSheet = {
  id: "nbr", name: "Northbridge FC", short_name: "NBR", color: "#0F6CBD",
  players: [
    { id: "nbr-1", name: "Tobin Ashgrove", number: 1, position: "GK" },
    { id: "nbr-9", name: "Luca Marrowby", number: 9, position: "FW" },
  ],
};
export const AWAY: TeamSheet = {
  id: "hbc", name: "Harbour City", short_name: "HBC", color: "#C50F1F",
  players: [
    { id: "hbc-1", name: "Osric Pendlebury", number: 1, position: "GK" },
    { id: "hbc-9", name: "Evander Quillfeather", number: 9, position: "FW" },
  ],
};

export const status = (over: Partial<MatchStatus> = {}): MatchStatus => ({
  match_id: "m-1", state: "live", minute: 0, score_home: 0, score_away: 0, speed: 30, home: HOME, away: AWAY, ...over,
});

export const matchEvent = (over: Partial<MatchEvent> = {}): MatchEvent => ({
  id: "m-1-e1", match_id: "m-1", seq: 1, minute: 3, second: 0, type: "pass", team: "home", player_id: "nbr-9",
  x: 60, y: 40, outcome: null, completed: true, player_in_id: null, ...over,
});

const teamStats = (over: Partial<TeamStats> = {}): TeamStats => ({
  goals: 0, possession: 50, shots: 0, shots_on_target: 0, passes: 0, pass_accuracy: 0, fouls: 0, yellow_cards: 0,
  red_cards: 0, xg: 0, ...over,
});

export const stats = (home: Partial<TeamStats> = {}, away: Partial<TeamStats> = {}, momentum = 0): StatsSnapshot => ({
  id: "m-1-s1", match_id: "m-1", minute: 10, home: teamStats(home), away: teamStats(away), momentum, period_end: null,
});

export const pressure = (over: Partial<PressureSnapshot> = {}): PressureSnapshot => ({
  id: "m-1-p1", match_id: "m-1", minute: 10, cols: 6, rows: 4, home: Array(24).fill(0), away: Array(24).fill(0), ...over,
});

export const moment = (over: Partial<KeyMoment> = {}): KeyMoment => ({
  id: "m-1-k1", match_id: "m-1", minute: 23, kind: "goal", team: "home", player_id: "nbr-9", event_id: "m-1-e40",
  score_home: 1, score_away: 0, facts: [{ label: "xg", value: 0.42 }], ...over,
});

export const narrative = (over: Partial<Narrative> = {}): Narrative => ({
  id: "m-1-k1-fan-en", match_id: "m-1", minute: 23, moment_id: "m-1-k1", mode: "fan", language: "en",
  text: "GOAL! Luca Marrowby scores for Northbridge FC in minute 23. It's 1-0!", source: "scripted", agent: "scripted",
  evidence: ["m-1-k1", "m-1-e40", "m-1-s23"], team: "home", player_id: "nbr-9", ...over,
});

export const recap = (over: Partial<Recap> = {}): Recap => ({
  id: "m-1-r-half_time-fan-en", match_id: "m-1", minute: 45, period: "half_time", mode: "fan", language: "en",
  title: "Half-time: Northbridge FC 1-0 Harbour City", bullets: ["Northbridge FC lead 1-0.", "Shots 5-2.", "xG 0.9-0.2."],
  text: "Northbridge FC lead 1-0. 4 key moments so far.", source: "scripted", agent: "scripted", score_home: 1,
  score_away: 0, ...over,
});

export const overlay = (over: Partial<Overlay> = {}): Overlay => ({
  id: "m-1-o1", match_id: "m-1", minute: 23, kind: "lower_third", language: "en", duration_ms: 6000,
  sources: ["m-1-k1-fan-en", "m-1-k1"],
  data: { headline: "GOAL", subline: "GOAL! Luca Marrowby scores.", team: "Northbridge FC", minute: 23 }, ...over,
});

export const envelope = (id: number, type: Envelope["type"], payload: object, highlighted = false): Envelope => ({
  id, type, match_id: "m-1", minute: 0, highlighted, payload: payload as Envelope["payload"],
});

/** A scriptable stand-in for the browser EventSource. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static get last(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }

  readyState = 0;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  emit(item: Envelope) {
    this.emitRaw(JSON.stringify(item));
  }

  emitRaw(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }

  fail(readyState: 0 | 2) {
    this.readyState = readyState;
    this.onerror?.(new Event("error"));
  }
}

export const FakeEventSourceCtor = FakeEventSource as unknown as new (url: string) => EventSource;
```

- [ ] **Step 2: Write the failing tests**

`apps/web/src/stream/store.test.ts`:

```ts
import {
  envelope, matchEvent, moment, narrative, overlay, pressure, recap, stats, status,
} from "../test/fixtures";
import { EMPTY, latestOverlays, reduce, useMatch } from "./store";

const apply = (...envelopes: ReturnType<typeof envelope>[]) => envelopes.reduce(reduce, EMPTY);

test("each envelope type lands in its slice", () => {
  const data = apply(
    envelope(1, "match_status", status({ score_home: 1 })),
    envelope(2, "match_event", matchEvent()),
    envelope(3, "stats", stats({ shots: 4 })),
    envelope(4, "pressure", pressure()),
    envelope(5, "key_moment", moment(), true),
    envelope(6, "narrative", narrative(), true),
    envelope(7, "recap", recap()),
    envelope(8, "overlay", overlay()),
  );
  expect(data.lastId).toBe(8);
  expect(data.status?.score_home).toBe(1);
  expect(data.events).toHaveLength(1);
  expect(data.stats?.home.shots).toBe(4);
  expect(data.pressure?.cols).toBe(6);
  expect(data.moments).toEqual([{ ...moment(), highlighted: true }]);
  expect(data.narratives).toEqual([{ ...narrative(), highlighted: true }]);
  expect(data.recaps).toHaveLength(1);
  expect(data.overlays).toHaveLength(1);
});

test("narratives are newest first and moments oldest first", () => {
  const data = apply(
    envelope(1, "key_moment", moment({ id: "k1" })),
    envelope(2, "key_moment", moment({ id: "k2" })),
    envelope(3, "narrative", narrative({ id: "n1" })),
    envelope(4, "narrative", narrative({ id: "n2" })),
  );
  expect(data.moments.map((m) => m.id)).toEqual(["k1", "k2"]);
  expect(data.narratives.map((n) => n.id)).toEqual(["n2", "n1"]);
});

test("a repeated or older envelope is ignored", () => {
  const once = apply(envelope(5, "narrative", narrative()));
  expect(reduce(once, envelope(5, "narrative", narrative()))).toBe(once);
  expect(reduce(once, envelope(3, "narrative", narrative({ id: "older" })))).toBe(once);
});

test("an unknown envelope type advances the id and changes nothing else", () => {
  const data = reduce(EMPTY, { ...envelope(4, "stats", {}), type: "weather" as never });
  expect(data).toEqual({ ...EMPTY, lastId: 4 });
});

test("only the most recent events and overlays are kept", () => {
  let data = EMPTY;
  for (let id = 1; id <= 400; id++) data = reduce(data, envelope(id, "match_event", matchEvent({ seq: id })));
  expect(data.events).toHaveLength(40);
  expect(data.events[39].seq).toBe(400);
  for (let id = 401; id <= 800; id++) data = reduce(data, envelope(id, "overlay", overlay({ id: `o${id}` })));
  expect(data.overlays).toHaveLength(300);
  expect(data.overlays[299].id).toBe("o800");
});

test("latestOverlays keeps the newest overlay of each kind", () => {
  const latest = latestOverlays([
    overlay({ id: "a", kind: "lower_third" }),
    overlay({ id: "b", kind: "stat_card" }),
    overlay({ id: "c", kind: "lower_third" }),
  ]);
  expect(latest.lower_third?.id).toBe("c");
  expect(latest.stat_card?.id).toBe("b");
  expect(latest.recap_card).toBeUndefined();
});

test("the store applies envelopes, selects and resets", () => {
  const store = useMatch.getState();
  store.apply(envelope(1, "narrative", narrative()));
  store.select("m-1-k1");
  store.setConnection("live");
  expect(useMatch.getState().data.narratives).toHaveLength(1);
  expect(useMatch.getState().selectedId).toBe("m-1-k1");
  store.reset();
  expect(useMatch.getState()).toMatchObject({ data: EMPTY, selectedId: null, connection: "connecting" });
});
```

`apps/web/src/stream/client.test.ts`:

```ts
import { envelope, FakeEventSource, FakeEventSourceCtor, narrative } from "../test/fixtures";
import { connect } from "./client";
import type { Connection } from "./store";

function setup() {
  FakeEventSource.instances = [];
  const connections: Connection[] = [];
  const received: unknown[] = [];
  const close = connect(
    "/api/matches/m-1/stream?mode=fan&lang=en",
    { onEnvelope: (item) => received.push(item), onConnection: (state) => connections.push(state) },
    FakeEventSourceCtor,
  );
  return { source: FakeEventSource.last, connections, received, close };
}

test("it opens the given url and reports connecting then live", () => {
  const { source, connections } = setup();
  expect(source.url).toBe("/api/matches/m-1/stream?mode=fan&lang=en");
  source.open();
  expect(connections).toEqual(["connecting", "live"]);
});

test("it passes parsed envelopes on", () => {
  const { source, received } = setup();
  const item = envelope(7, "narrative", narrative());
  source.emit(item);
  expect(received).toEqual([item]);
});

test.each([
  ["malformed JSON", "{oops"],
  ["a non-object", "42"],
  ["null", "null"],
  ["an object without an id", JSON.stringify({ type: "narrative", payload: {} })],
  ["an object without a type", JSON.stringify({ id: 3, payload: {} })],
])("it skips %s without failing", (_, data) => {
  const { source, received } = setup();
  source.emitRaw(data);
  source.emit(envelope(8, "narrative", narrative()));
  expect(received).toHaveLength(1);
});

test("a dropped connection the browser will retry is reported as reconnecting", () => {
  const { source, connections } = setup();
  source.open();
  source.fail(0);
  source.open();
  expect(connections).toEqual(["connecting", "live", "reconnecting", "live"]);
});

test("a connection the server refused is reported as no_match", () => {
  const { source, connections } = setup();
  source.fail(2);
  expect(connections).toEqual(["connecting", "no_match"]);
});

test("the returned function closes the connection", () => {
  const { source, close } = setup();
  close();
  expect(source.closed).toBe(true);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test src/stream`
Expected: both files fail to resolve `./store` and `./client`.

- [ ] **Step 4: Write the store**

`apps/web/src/stream/store.ts`:

```ts
import { create } from "zustand";
import type {
  Envelope, KeyMoment, MatchEvent, MatchStatus, Narrative, Overlay, PressureSnapshot, Recap, StatsSnapshot,
} from "../contracts";

export type Connection = "idle" | "connecting" | "live" | "reconnecting" | "no_match";

export interface FeedNarrative extends Narrative {
  highlighted: boolean;
}
export interface FeedMoment extends KeyMoment {
  highlighted: boolean;
}

export interface MatchData {
  lastId: number;
  status: MatchStatus | null;
  events: MatchEvent[];
  stats: StatsSnapshot | null;
  pressure: PressureSnapshot | null;
  moments: FeedMoment[];
  narratives: FeedNarrative[];
  recaps: Recap[];
  overlays: Overlay[];
}

const MAX_EVENTS = 40;
const MAX_OVERLAYS = 300;

export const EMPTY: MatchData = {
  lastId: 0, status: null, events: [], stats: null, pressure: null, moments: [], narratives: [], recaps: [], overlays: [],
};

/** Folds one stream envelope into the match data. Pure; replays and duplicates are ignored by id. */
export function reduce(data: MatchData, envelope: Envelope): MatchData {
  if (envelope.id <= data.lastId) return data;
  const next = { ...data, lastId: envelope.id };
  const payload = envelope.payload as unknown;
  const { highlighted } = envelope;
  switch (envelope.type) {
    case "match_status":
      return { ...next, status: payload as MatchStatus };
    case "match_event":
      return { ...next, events: [...data.events, payload as MatchEvent].slice(-MAX_EVENTS) };
    case "stats":
      return { ...next, stats: payload as StatsSnapshot };
    case "pressure":
      return { ...next, pressure: payload as PressureSnapshot };
    case "key_moment":
      return { ...next, moments: [...data.moments, { ...(payload as KeyMoment), highlighted }] };
    case "narrative":
      return { ...next, narratives: [{ ...(payload as Narrative), highlighted }, ...data.narratives] };
    case "recap":
      return { ...next, recaps: [...data.recaps, payload as Recap] };
    case "overlay":
      return { ...next, overlays: [...data.overlays, payload as Overlay].slice(-MAX_OVERLAYS) };
    default:
      return next;
  }
}

export function latestOverlays(overlays: Overlay[]): Partial<Record<Overlay["kind"], Overlay>> {
  const latest: Partial<Record<Overlay["kind"], Overlay>> = {};
  for (const overlay of overlays) latest[overlay.kind] = overlay;
  return latest;
}

interface MatchStore {
  data: MatchData;
  connection: Connection;
  selectedId: string | null;
  apply(envelope: Envelope): void;
  reset(): void;
  setConnection(connection: Connection): void;
  select(momentId: string | null): void;
}

export const useMatch = create<MatchStore>((set) => ({
  data: EMPTY,
  connection: "idle",
  selectedId: null,
  apply: (envelope) => set((state) => ({ data: reduce(state.data, envelope) })),
  reset: () => set({ data: EMPTY, selectedId: null, connection: "connecting" }),
  setConnection: (connection) => set({ connection }),
  select: (selectedId) => set({ selectedId }),
}));
```

- [ ] **Step 5: Write the stream client**

`apps/web/src/stream/client.ts`:

```ts
import type { Envelope } from "../contracts";
import type { Connection } from "./store";

export interface StreamHandlers {
  onEnvelope(envelope: Envelope): void;
  onConnection(connection: Connection): void;
}

const CLOSED = 2;

function isEnvelope(value: unknown): value is Envelope {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "number" && typeof candidate.type === "string";
}

/**
 * Opens the one stream connection for a viewer. The browser reconnects a dropped connection
 * by itself and sends Last-Event-ID, so the server replays only what was missed. A connection
 * the server refuses (unknown match) is left closed and reported as "no_match".
 */
export function connect(
  url: string,
  handlers: StreamHandlers,
  EventSourceImpl: new (url: string) => EventSource = EventSource,
): () => void {
  handlers.onConnection("connecting");
  const source = new EventSourceImpl(url);
  source.onopen = () => handlers.onConnection("live");
  source.onmessage = (message) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch {
      return;
    }
    if (isEnvelope(parsed)) handlers.onEnvelope(parsed);
  };
  source.onerror = () => handlers.onConnection(source.readyState === CLOSED ? "no_match" : "reconnecting");
  return () => source.close();
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test src/stream && pnpm typecheck`
Expected: 7 store tests and 10 client tests pass; no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/stream apps/web/src/test/fixtures.ts
git commit -m "feat: add match stream store and single EventSource client"
```

---

### Task 14: Match view components

**Files:**
- Create: `apps/web/src/test/render.tsx`
- Create: `apps/web/src/components/Header.tsx`, `Pitch.tsx`, `StatsPanel.tsx`, `Timeline.tsx`, `NarrativeFeed.tsx`
- Test: `apps/web/src/components/Header.test.tsx`, `Pitch.test.tsx`, `StatsPanel.test.tsx`, `Timeline.test.tsx`, `NarrativeFeed.test.tsx`

**Interfaces:**
- Consumes: `src/contracts.ts`, `src/i18n.ts`, `stream/store.ts` types, `test/fixtures.ts`.
- Produces (all components are props-only; none reads the store or fetches):
  - `Header({ status: MatchStatus | null, connection: Connection, profile: ViewerProfile, onModeChange(mode: Mode), onLanguageChange(language: Language), onOpenPreferences(), onStart() })`
  - `Pitch({ events: MatchEvent[], pressure: PressureSnapshot | null, status: MatchStatus | null, showPressure: boolean, language: Language })` and `heatCells(pressure: PressureSnapshot): HeatCell[]`
  - `StatsPanel({ stats: StatsSnapshot | null, status: MatchStatus | null, language: Language })`
  - `Timeline({ moments: FeedMoment[], recaps: Recap[], selectedId: string | null, language: Language, onSelect(momentId: string), onOpenRecap(recap: Recap) })`
  - `NarrativeFeed({ narratives: FeedNarrative[], selectedId: string | null, language: Language, onSelect(momentId: string) })`
  - `test/render.tsx`: `renderUi(ui: ReactElement)` renders inside a `FluentProvider`.

- [ ] **Step 1: Write the render helper**

`apps/web/src/test/render.tsx`:

```tsx
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";

export function renderUi(ui: ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}
```

- [ ] **Step 2: Write the failing tests**

`apps/web/src/components/Header.test.tsx`:

```tsx
import { fireEvent, screen } from "@testing-library/react";
import type { ViewerProfile } from "../contracts";
import { status } from "../test/fixtures";
import { renderUi } from "../test/render";
import { Header } from "./Header";

const profile: ViewerProfile = { mode: "fan", language: "en", club: null, player: null };

function setup(over: Partial<Parameters<typeof Header>[0]> = {}) {
  const handlers = { onModeChange: vi.fn(), onLanguageChange: vi.fn(), onOpenPreferences: vi.fn(), onStart: vi.fn() };
  renderUi(<Header status={status({ minute: 37, score_home: 2, score_away: 1 })} connection="live" profile={profile} {...handlers} {...over} />);
  return handlers;
}

test("shows both teams, the score, the minute and the connection state", () => {
  setup();
  expect(screen.getByText("Northbridge FC")).toBeTruthy();
  expect(screen.getByText("Harbour City")).toBeTruthy();
  expect(screen.getByTestId("score").textContent).toBe("2 - 1");
  expect(screen.getByText("37'")).toBeTruthy();
  expect(screen.getByText("Live")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Restart match" })).toBeTruthy();
});

test("with no match it invites the viewer to start one", () => {
  const handlers = setup({ status: null, connection: "idle" });
  expect(screen.getByText("No match is running. Start one to begin.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Start match" }));
  expect(handlers.onStart).toHaveBeenCalledOnce();
});

test("switching mode and language reports the new value", () => {
  const handlers = setup();
  fireEvent.click(screen.getByRole("tab", { name: "Analyst" }));
  expect(handlers.onModeChange).toHaveBeenCalledWith("analyst");
  fireEvent.change(screen.getByLabelText("Language"), { target: { value: "hi" } });
  expect(handlers.onLanguageChange).toHaveBeenCalledWith("hi");
});

test("the preferences button opens preferences", () => {
  const handlers = setup();
  fireEvent.click(screen.getByRole("button", { name: "Preferences" }));
  expect(handlers.onOpenPreferences).toHaveBeenCalledOnce();
});

test("interface text follows the viewer's language", () => {
  setup({ profile: { ...profile, language: "es" } });
  expect(screen.getByRole("button", { name: "Reiniciar partido" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Analista" })).toBeTruthy();
  expect(screen.getByText("En directo")).toBeTruthy();
});
```

`apps/web/src/components/Pitch.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import { matchEvent, pressure, status } from "../test/fixtures";
import { renderUi } from "../test/render";
import { heatCells, Pitch } from "./Pitch";

const grid = (values: Record<number, number>) => Array.from({ length: 24 }, (_, index) => values[index] ?? 0);

test("heatCells shows the net pressure of the stronger side per zone", () => {
  const cells = heatCells(pressure({ home: grid({ 5: 8, 7: 2 }), away: grid({ 0: 4, 7: 2 }) }));
  expect(cells.map((cell) => [cell.index, cell.side])).toEqual([[0, "away"], [5, "home"]]);
  const [away, home] = cells;
  expect(home.opacity).toBeGreaterThan(away.opacity);
  expect(home.opacity).toBeLessThanOrEqual(0.6);
  expect(home.x).toBeCloseTo((5 * 100) / 6);
  expect(home.y).toBe(0);
});

test("draws a marker for each recent team event, capped at twelve", () => {
  const events = Array.from({ length: 20 }, (_, index) => matchEvent({ id: `e${index}`, seq: index }));
  events.push(matchEvent({ id: "ht", type: "half_time", team: null }));
  renderUi(<Pitch events={events} pressure={null} status={status()} showPressure language="en" />);
  expect(screen.getAllByTestId("marker")).toHaveLength(12);
  expect(screen.getByRole("img", { name: "Pitch" })).toBeTruthy();
});

test("the pressure layer can be switched off", () => {
  const heat = pressure({ home: grid({ 5: 8 }) });
  const { rerender } = renderUi(<Pitch events={[]} pressure={heat} status={status()} showPressure language="en" />);
  expect(screen.getAllByTestId("heat")).toHaveLength(1);
  rerender(<Pitch events={[]} pressure={heat} status={status()} showPressure={false} language="en" />);
  expect(screen.queryAllByTestId("heat")).toHaveLength(0);
});
```

`apps/web/src/components/StatsPanel.test.tsx`:

```tsx
import { screen, within } from "@testing-library/react";
import { stats, status } from "../test/fixtures";
import { renderUi } from "../test/render";
import { StatsPanel } from "./StatsPanel";

test("compares home and away for each stat", () => {
  const snapshot = stats({ shots: 7, possession: 61.5, xg: 1.24 }, { shots: 2, possession: 38.5, xg: 0.3 }, 0.4);
  renderUi(<StatsPanel stats={snapshot} status={status()} language="en" />);
  const shots = screen.getByTestId("stat-shots");
  expect(within(shots).getByText("Shots")).toBeTruthy();
  expect(within(shots).getByText("7")).toBeTruthy();
  expect(within(shots).getByText("2")).toBeTruthy();
  expect(within(screen.getByTestId("stat-possession")).getByText("61.5")).toBeTruthy();
  expect(screen.getByRole("meter", { name: "Momentum" }).getAttribute("aria-valuenow")).toBe("0.4");
});

test("before the first snapshot it shows placeholders", () => {
  renderUi(<StatsPanel stats={null} status={null} language="es" />);
  expect(screen.getByText("Estadísticas")).toBeTruthy();
  expect(within(screen.getByTestId("stat-shots")).getAllByText("–")).toHaveLength(2);
});
```

`apps/web/src/components/Timeline.test.tsx`:

```tsx
import { fireEvent, screen } from "@testing-library/react";
import { moment, recap } from "../test/fixtures";
import { renderUi } from "../test/render";
import { Timeline } from "./Timeline";

const moments = [
  { ...moment({ id: "k1", minute: 12, kind: "big_chance" }), highlighted: false },
  { ...moment({ id: "k2", minute: 23, kind: "goal" }), highlighted: true },
];

function setup(selectedId: string | null = null) {
  const handlers = { onSelect: vi.fn(), onOpenRecap: vi.fn() };
  renderUi(<Timeline moments={moments} recaps={[recap()]} selectedId={selectedId} language="en" {...handlers} />);
  return handlers;
}

test("each key moment is a labelled button placed by its minute", () => {
  setup();
  const goal = screen.getByRole("button", { name: "23' Goal" });
  expect(goal.style.left).toBe(`${(23 / 90) * 100}%`);
  expect(goal.getAttribute("data-highlighted")).toBe("true");
  expect(screen.getByRole("button", { name: "12' Big chance" })).toBeTruthy();
});

test("selecting a moment reports its id and marks it pressed", () => {
  const handlers = setup("k2");
  fireEvent.click(screen.getByRole("button", { name: "12' Big chance" }));
  expect(handlers.onSelect).toHaveBeenCalledWith("k1");
  expect(screen.getByRole("button", { name: "23' Goal" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "12' Big chance" }).getAttribute("aria-pressed")).toBe("false");
});

test("a recap marker reopens that recap", () => {
  const handlers = setup();
  fireEvent.click(screen.getByRole("button", { name: "Half-time recap" }));
  expect(handlers.onOpenRecap).toHaveBeenCalledWith(recap());
});
```

`apps/web/src/components/NarrativeFeed.test.tsx`:

```tsx
import { fireEvent, screen } from "@testing-library/react";
import { narrative } from "../test/fixtures";
import { renderUi } from "../test/render";
import { NarrativeFeed } from "./NarrativeFeed";

const feed = [
  { ...narrative({ id: "n2", moment_id: "k2", minute: 40, text: "So close!", source: "agent", agent: "commentator" }), highlighted: false },
  { ...narrative({ id: "n1", moment_id: "k1", minute: 23 }), highlighted: true },
];

test("with no narratives it explains what will appear", () => {
  renderUi(<NarrativeFeed narratives={[]} selectedId={null} language="en" onSelect={vi.fn()} />);
  expect(screen.getByText("Narratives appear here as key moments happen.")).toBeTruthy();
});

test("lists narratives in the order given with their minute", () => {
  renderUi(<NarrativeFeed narratives={feed} selectedId={null} language="en" onSelect={vi.fn()} />);
  const items = screen.getAllByRole("listitem");
  expect(items.map((item) => item.textContent)).toEqual([
    expect.stringContaining("So close!"), expect.stringContaining("GOAL!"),
  ]);
  expect(items[0].textContent).toContain("40'");
});

test("badges mark scripted and highlighted narratives only", () => {
  renderUi(<NarrativeFeed narratives={feed} selectedId={null} language="en" onSelect={vi.fn()} />);
  const [agentWritten, scripted] = screen.getAllByRole("listitem");
  expect(scripted.textContent).toContain("Scripted");
  expect(scripted.textContent).toContain("Highlighted for you");
  expect(agentWritten.textContent).not.toContain("Scripted");
  expect(agentWritten.textContent).not.toContain("Highlighted for you");
});

test("clicking a narrative selects its key moment", () => {
  const onSelect = vi.fn();
  renderUi(<NarrativeFeed narratives={feed} selectedId="k1" language="en" onSelect={onSelect} />);
  fireEvent.click(screen.getByRole("button", { name: /So close!/ }));
  expect(onSelect).toHaveBeenCalledWith("k2");
  expect(screen.getByRole("button", { name: /GOAL!/ }).getAttribute("aria-pressed")).toBe("true");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test src/components`
Expected: all five files fail to resolve their component module.

- [ ] **Step 4: Write the header**

`apps/web/src/components/Header.tsx`:

```tsx
import { Badge, Button, makeStyles, Select, Tab, TabList, Text, tokens } from "@fluentui/react-components";
import type { MatchStatus, ViewerProfile } from "../contracts";
import { LANGUAGE_NAMES, LANGUAGES, type Language, type Mode, type StringKey, t } from "../i18n";
import type { Connection } from "../stream/store";

const useStyles = makeStyles({
  root: {
    display: "flex", alignItems: "center", flexWrap: "wrap", gap: tokens.spacingHorizontalL,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXL}`,
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  scoreboard: { display: "flex", alignItems: "center", justifyContent: "center", gap: tokens.spacingHorizontalM, flexGrow: 1 },
  controls: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
});

const CONNECTION: Record<Connection, { label: StringKey; color: "success" | "warning" | "informative" | "subtle" }> = {
  idle: { label: "idle", color: "subtle" },
  no_match: { label: "idle", color: "subtle" },
  connecting: { label: "connecting", color: "informative" },
  live: { label: "live", color: "success" },
  reconnecting: { label: "reconnecting", color: "warning" },
};

interface HeaderProps {
  status: MatchStatus | null;
  connection: Connection;
  profile: ViewerProfile;
  onModeChange(mode: Mode): void;
  onLanguageChange(language: Language): void;
  onOpenPreferences(): void;
  onStart(): void;
}

export function Header({ status, connection, profile, onModeChange, onLanguageChange, onOpenPreferences, onStart }: HeaderProps) {
  const styles = useStyles();
  const language = profile.language;
  const state = CONNECTION[connection];
  return (
    <header className={styles.root}>
      <Text as="h1" size={500} weight="semibold">
        {t(language, "appTitle")}
      </Text>
      <div className={styles.scoreboard}>
        {status ? (
          <>
            <Text weight="semibold">{status.home.name}</Text>
            <Text size={700} weight="bold" data-testid="score">
              {status.score_home} - {status.score_away}
            </Text>
            <Text weight="semibold">{status.away.name}</Text>
            <Badge appearance="outline">{status.minute}'</Badge>
          </>
        ) : (
          <Text>{t(language, "noMatch")}</Text>
        )}
        <Badge color={state.color}>{t(language, state.label)}</Badge>
      </div>
      <div className={styles.controls}>
        <TabList
          size="small"
          aria-label={t(language, "mode")}
          selectedValue={profile.mode}
          onTabSelect={(_, data) => onModeChange(data.value as Mode)}
        >
          <Tab value="fan">{t(language, "fan")}</Tab>
          <Tab value="analyst">{t(language, "analyst")}</Tab>
        </TabList>
        <Select
          aria-label={t(language, "language")}
          value={language}
          onChange={(_, data) => onLanguageChange(data.value as Language)}
        >
          {LANGUAGES.map((option) => (
            <option key={option} value={option}>
              {LANGUAGE_NAMES[option]}
            </option>
          ))}
        </Select>
        <Button onClick={onOpenPreferences}>{t(language, "preferences")}</Button>
        <Button appearance="primary" onClick={onStart}>
          {t(language, status ? "restart" : "start")}
        </Button>
      </div>
    </header>
  );
}
```

- [ ] **Step 5: Write the pitch**

`apps/web/src/components/Pitch.tsx`:

```tsx
import { makeStyles, tokens } from "@fluentui/react-components";
import type { MatchEvent, MatchStatus, PressureSnapshot } from "../contracts";
import { type Language, t } from "../i18n";

const WIDTH = 100;
const HEIGHT = 64;
const MAX_MARKERS = 12;
const MAX_HEAT_OPACITY = 0.6;
const DEFAULT_COLORS = { home: "#0F6CBD", away: "#C50F1F" };

const useStyles = makeStyles({
  root: { width: "100%", display: "block", borderRadius: tokens.borderRadiusMedium },
});

export interface HeatCell {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  side: "home" | "away";
  opacity: number;
}

/** One cell per zone where a side has the upper hand, shaded by how large the difference is. */
export function heatCells(pressure: PressureSnapshot): HeatCell[] {
  const net = pressure.home.map((home, index) => home - (pressure.away[index] ?? 0));
  const peak = Math.max(1, ...net.map(Math.abs));
  const width = WIDTH / pressure.cols;
  const height = HEIGHT / pressure.rows;
  return net.flatMap((value, index) =>
    value === 0
      ? []
      : [{
          index,
          x: (index % pressure.cols) * width,
          y: Math.floor(index / pressure.cols) * height,
          width,
          height,
          side: value > 0 ? ("home" as const) : ("away" as const),
          opacity: (Math.abs(value) / peak) * MAX_HEAT_OPACITY,
        }],
  );
}

interface PitchProps {
  events: MatchEvent[];
  pressure: PressureSnapshot | null;
  status: MatchStatus | null;
  showPressure: boolean;
  language: Language;
}

export function Pitch({ events, pressure, status, showPressure, language }: PitchProps) {
  const styles = useStyles();
  const colors = status ? { home: status.home.color, away: status.away.color } : DEFAULT_COLORS;
  const markers = events.filter((event) => event.team).slice(-MAX_MARKERS);
  const cells = showPressure && pressure ? heatCells(pressure) : [];
  return (
    <svg className={styles.root} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={t(language, "pitch")}>
      <rect width={WIDTH} height={HEIGHT} fill="#2E7D32" />
      <g fill="none" stroke="#FFFFFF" strokeWidth={0.4} opacity={0.75}>
        <rect x={1} y={1} width={WIDTH - 2} height={HEIGHT - 2} />
        <line x1={WIDTH / 2} y1={1} x2={WIDTH / 2} y2={HEIGHT - 1} />
        <circle cx={WIDTH / 2} cy={HEIGHT / 2} r={8} />
        <rect x={1} y={HEIGHT / 2 - 14} width={15} height={28} />
        <rect x={WIDTH - 16} y={HEIGHT / 2 - 14} width={15} height={28} />
      </g>
      {cells.map((cell) => (
        <rect key={cell.index} data-testid="heat" x={cell.x} y={cell.y} width={cell.width} height={cell.height}
          fill={colors[cell.side]} opacity={cell.opacity} />
      ))}
      {markers.map((event, index) => (
        <circle key={event.id} data-testid="marker" cx={event.x} cy={(event.y / 100) * HEIGHT}
          r={event.type === "goal" ? 2.2 : 1.2} fill={colors[event.team as "home" | "away"]} stroke="#FFFFFF"
          strokeWidth={0.3} opacity={0.35 + (0.65 * (index + 1)) / markers.length}>
          <title>{event.type}</title>
        </circle>
      ))}
    </svg>
  );
}
```

- [ ] **Step 6: Write the stats panel**

`apps/web/src/components/StatsPanel.tsx`:

```tsx
import { makeStyles, Text, tokens } from "@fluentui/react-components";
import type { MatchStatus, StatsSnapshot, TeamStats } from "../contracts";
import { type Language, type StringKey, t } from "../i18n";

const ROWS: { field: keyof TeamStats; label: StringKey; id: string }[] = [
  { field: "possession", label: "possession", id: "possession" },
  { field: "shots", label: "shots", id: "shots" },
  { field: "shots_on_target", label: "shotsOnTarget", id: "shots-on-target" },
  { field: "xg", label: "xg", id: "xg" },
  { field: "pass_accuracy", label: "passAccuracy", id: "pass-accuracy" },
];
const PLACEHOLDER = "–";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  row: { display: "grid", gridTemplateColumns: "3rem 1fr 3rem", alignItems: "center", gap: tokens.spacingHorizontalS },
  away: { textAlign: "right" },
  middle: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXXS },
  label: { textAlign: "center", color: tokens.colorNeutralForeground2 },
  bar: { display: "flex", height: "6px", borderRadius: tokens.borderRadiusCircular, overflow: "hidden", backgroundColor: tokens.colorNeutralBackground4 },
  meter: { position: "relative", height: "8px", borderRadius: tokens.borderRadiusCircular, backgroundColor: tokens.colorNeutralBackground4 },
  needle: { position: "absolute", top: "-3px", width: "4px", height: "14px", borderRadius: tokens.borderRadiusSmall, backgroundColor: tokens.colorNeutralForeground1 },
});

interface StatsPanelProps {
  stats: StatsSnapshot | null;
  status: MatchStatus | null;
  language: Language;
}

export function StatsPanel({ stats, status, language }: StatsPanelProps) {
  const styles = useStyles();
  const homeColor = status?.home.color ?? tokens.colorBrandBackground;
  const awayColor = status?.away.color ?? tokens.colorPaletteRedBackground3;
  const momentum = stats?.momentum ?? 0;
  return (
    <section className={styles.root} aria-label={t(language, "stats")}>
      <Text as="h2" weight="semibold">
        {t(language, "stats")}
      </Text>
      {ROWS.map(({ field, label, id }) => {
        const home = stats?.home[field];
        const away = stats?.away[field];
        const total = (home ?? 0) + (away ?? 0);
        const share = total === 0 ? 50 : ((home ?? 0) / total) * 100;
        return (
          <div key={id} className={styles.row} data-testid={`stat-${id}`}>
            <Text weight="semibold">{home ?? PLACEHOLDER}</Text>
            <div className={styles.middle}>
              <Text size={200} className={styles.label}>
                {t(language, label)}
              </Text>
              <div className={styles.bar}>
                <div style={{ width: `${share}%`, backgroundColor: homeColor }} />
                <div style={{ width: `${100 - share}%`, backgroundColor: awayColor }} />
              </div>
            </div>
            <Text weight="semibold" className={styles.away}>
              {away ?? PLACEHOLDER}
            </Text>
          </div>
        );
      })}
      <Text size={200} className={styles.label}>
        {t(language, "momentum")}
      </Text>
      <div className={styles.meter} role="meter" aria-label={t(language, "momentum")} aria-valuemin={-1}
        aria-valuemax={1} aria-valuenow={momentum}>
        <div className={styles.needle} style={{ left: `calc(${((1 - momentum) / 2) * 100}% - 2px)` }} />
      </div>
    </section>
  );
}
```

The momentum needle sits toward the side that has the momentum: the home side is on the left, matching the scoreboard.

- [ ] **Step 7: Write the timeline**

`apps/web/src/components/Timeline.tsx`:

```tsx
import { makeStyles, mergeClasses, Text, tokens } from "@fluentui/react-components";
import type { Recap } from "../contracts";
import { type Language, type StringKey, t } from "../i18n";
import type { FeedMoment } from "../stream/store";

const MATCH_MINUTES = 90;

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  track: { position: "relative", height: "32px", borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  marker: {
    position: "absolute", top: "6px", width: "20px", height: "20px", marginLeft: "-10px", padding: 0, cursor: "pointer",
    borderRadius: tokens.borderRadiusCircular, border: `${tokens.strokeWidthThick} solid ${tokens.colorNeutralBackground1}`,
    backgroundColor: tokens.colorBrandBackground,
  },
  goal: { backgroundColor: tokens.colorPaletteGreenBackground3 },
  card: { backgroundColor: tokens.colorPaletteRedBackground3 },
  highlighted: { outline: `${tokens.strokeWidthThick} solid ${tokens.colorPaletteYellowBorderActive}` },
  selected: { boxShadow: tokens.shadow8, transform: "scale(1.25)" },
  recap: {
    position: "absolute", top: "4px", height: "24px", marginLeft: "-12px", padding: `0 ${tokens.spacingHorizontalXS}`,
    cursor: "pointer", borderRadius: tokens.borderRadiusSmall, border: "none", fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForegroundOnBrand, backgroundColor: tokens.colorNeutralForeground2,
  },
});

interface TimelineProps {
  moments: FeedMoment[];
  recaps: Recap[];
  selectedId: string | null;
  language: Language;
  onSelect(momentId: string): void;
  onOpenRecap(recap: Recap): void;
}

const position = (minute: number) => `${(Math.min(minute, MATCH_MINUTES) / MATCH_MINUTES) * 100}%`;

export function Timeline({ moments, recaps, selectedId, language, onSelect, onOpenRecap }: TimelineProps) {
  const styles = useStyles();
  return (
    <section className={styles.root} aria-label={t(language, "timeline")}>
      <Text as="h2" weight="semibold">
        {t(language, "timeline")}
      </Text>
      <div className={styles.track}>
        {moments.map((moment) => {
          const label = `${moment.minute}' ${t(language, `kind_${moment.kind}` as StringKey)}`;
          return (
            <button key={moment.id} type="button" aria-label={label} title={label}
              aria-pressed={moment.id === selectedId} data-highlighted={moment.highlighted}
              className={mergeClasses(styles.marker, moment.kind === "goal" && styles.goal,
                moment.kind === "red_card" && styles.card, moment.highlighted && styles.highlighted,
                moment.id === selectedId && styles.selected)}
              style={{ left: position(moment.minute) }} onClick={() => onSelect(moment.id)} />
          );
        })}
        {recaps.map((recap) => {
          const label = t(language, recap.period === "half_time" ? "halfTime" : "fullTime");
          return (
            <button key={recap.id} type="button" aria-label={label} title={label} className={styles.recap}
              style={{ left: position(recap.minute) }} onClick={() => onOpenRecap(recap)}>
              {recap.period === "half_time" ? "HT" : "FT"}
            </button>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 8: Write the narrative feed**

`apps/web/src/components/NarrativeFeed.tsx`:

```tsx
import { Badge, makeStyles, mergeClasses, Text, tokens } from "@fluentui/react-components";
import { useEffect, useRef } from "react";
import { type Language, t } from "../i18n";
import type { FeedNarrative } from "../stream/store";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, minHeight: 0 },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, overflowY: "auto" },
  card: {
    display: "flex", flexDirection: "column", alignItems: "flex-start", gap: tokens.spacingVerticalXS, width: "100%",
    padding: tokens.spacingVerticalM, textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit",
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground1,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderLeft: `${tokens.strokeWidthThickest} solid ${tokens.colorNeutralStroke2}`,
  },
  highlighted: { borderLeftColor: tokens.colorPaletteYellowBorderActive, backgroundColor: tokens.colorPaletteYellowBackground1 },
  selected: { border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke1}`, boxShadow: tokens.shadow4 },
  badges: { display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalXS },
});

interface NarrativeFeedProps {
  narratives: FeedNarrative[];
  selectedId: string | null;
  language: Language;
  onSelect(momentId: string): void;
}

export function NarrativeFeed({ narratives, selectedId, language, onSelect }: NarrativeFeedProps) {
  const styles = useStyles();
  const selected = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    selected.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  return (
    <section className={styles.root} aria-label={t(language, "feed")}>
      <Text as="h2" weight="semibold">
        {t(language, "feed")}
      </Text>
      {narratives.length === 0 ? (
        <Text>{t(language, "feedEmpty")}</Text>
      ) : (
        <ol className={styles.list}>
          {narratives.map((narrative) => {
            const isSelected = narrative.moment_id === selectedId;
            return (
              <li key={narrative.id}>
                <button type="button" ref={isSelected ? selected : undefined} aria-pressed={isSelected}
                  data-highlighted={narrative.highlighted}
                  className={mergeClasses(styles.card, narrative.highlighted && styles.highlighted, isSelected && styles.selected)}
                  onClick={() => onSelect(narrative.moment_id)}>
                  <span className={styles.badges}>
                    <Badge appearance="outline">{narrative.minute}'</Badge>
                    {narrative.source === "scripted" && <Badge appearance="tint" color="subtle">{t(language, "scripted")}</Badge>}
                    {narrative.highlighted && <Badge appearance="tint" color="warning">{t(language, "highlighted")}</Badge>}
                  </span>
                  <Text>{narrative.text}</Text>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm test src/components && pnpm typecheck`
Expected: 17 tests pass across five files; no type errors.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components apps/web/src/test/render.tsx
git commit -m "feat: add header, pitch, stats, timeline and narrative feed components"
```

---

### Task 15: Preferences, recap, overlay and pipeline views, and the assembled dashboard

**Files:**
- Create: `apps/web/src/components/PreferencesDrawer.tsx`, `RecapDialog.tsx`, `OverlayTab.tsx`, `PipelinePanel.tsx`
- Modify: `apps/web/src/App.tsx` (replace the shell from Task 12)
- Test: `apps/web/src/components/PreferencesDrawer.test.tsx`, `RecapDialog.test.tsx`, `OverlayTab.test.tsx`, `PipelinePanel.test.tsx`, `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 12 to 14.
- Produces:
  - `PreferencesDrawer({ open: boolean, profile: ViewerProfile, teams: Teams | null, onChange(profile: ViewerProfile), onClose() })`
  - `RecapDialog({ recap: Recap | null, language: Language, onClose() })`
  - `OverlayTab({ overlays: Overlay[], language: Language })` and `OverlayGraphic({ overlay: Overlay })`
  - `PipelinePanel({ narrative: FeedNarrative | undefined, moment: FeedMoment | undefined, overlay: Overlay | undefined, profile: ViewerProfile })`
  - `App({ eventSource?: new (url: string) => EventSource })`. The prop exists so tests can inject `FakeEventSource`.

- [ ] **Step 1: Write the failing component tests**

`apps/web/src/components/PreferencesDrawer.test.tsx`:

```tsx
import { fireEvent, screen } from "@testing-library/react";
import type { ViewerProfile } from "../contracts";
import { AWAY, HOME } from "../test/fixtures";
import { renderUi } from "../test/render";
import { PreferencesDrawer } from "./PreferencesDrawer";

const profile: ViewerProfile = { mode: "fan", language: "en", club: null, player: null };
const teams = { home: HOME, away: AWAY };

function setup(over: Partial<ViewerProfile> = {}, withTeams: typeof teams | null = teams) {
  const handlers = { onChange: vi.fn(), onClose: vi.fn() };
  renderUi(<PreferencesDrawer open profile={{ ...profile, ...over }} teams={withTeams} {...handlers} />);
  return handlers;
}

const options = (label: string) =>
  Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((option) => option.textContent);

test("offers both clubs and every listed player", () => {
  setup();
  expect(options("Favorite club")).toEqual(["None", "Northbridge FC", "Harbour City"]);
  expect(options("Favorite player")).toEqual(["None", "Tobin Ashgrove", "Luca Marrowby", "Osric Pendlebury", "Evander Quillfeather"]);
});

test("choosing a favorite reports the whole updated profile", () => {
  const handlers = setup();
  fireEvent.change(screen.getByLabelText("Favorite club"), { target: { value: "hbc" } });
  expect(handlers.onChange).toHaveBeenCalledWith({ ...profile, club: "hbc" });
  fireEvent.change(screen.getByLabelText("Favorite player"), { target: { value: "nbr-9" } });
  expect(handlers.onChange).toHaveBeenCalledWith({ ...profile, player: "nbr-9" });
  fireEvent.change(screen.getByLabelText("Language"), { target: { value: "hi" } });
  expect(handlers.onChange).toHaveBeenCalledWith({ ...profile, language: "hi" });
});

test("choosing None clears the favorite", () => {
  const handlers = setup({ club: "nbr" });
  fireEvent.change(screen.getByLabelText("Favorite club"), { target: { value: "" } });
  expect(handlers.onChange).toHaveBeenCalledWith({ ...profile, club: null });
});

test("a saved favorite that is not in this match shows as None", () => {
  setup({ club: "old-club", player: "old-club-10" });
  expect((screen.getByLabelText("Favorite club") as HTMLSelectElement).value).toBe("");
  expect((screen.getByLabelText("Favorite player") as HTMLSelectElement).value).toBe("");
});

test("it works before the team sheets have loaded", () => {
  setup({}, null);
  expect(options("Favorite club")).toEqual(["None"]);
});

test("the close button closes the drawer", () => {
  const handlers = setup();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(handlers.onClose).toHaveBeenCalledOnce();
});
```

`apps/web/src/components/RecapDialog.test.tsx`:

```tsx
import { fireEvent, screen } from "@testing-library/react";
import { recap } from "../test/fixtures";
import { renderUi } from "../test/render";
import { RecapDialog } from "./RecapDialog";

test("is not shown without a recap", () => {
  renderUi(<RecapDialog recap={null} language="en" onClose={vi.fn()} />);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("shows the recap title, summary and three bullets", () => {
  renderUi(<RecapDialog recap={recap()} language="en" onClose={vi.fn()} />);
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("Half-time: Northbridge FC 1-0 Harbour City");
  expect(dialog.textContent).toContain("4 key moments so far.");
  expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "Northbridge FC lead 1-0.", "Shots 5-2.", "xG 0.9-0.2.",
  ]);
});

test("the close button reports the close", () => {
  const onClose = vi.fn();
  renderUi(<RecapDialog recap={recap()} language="es" onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
  expect(onClose).toHaveBeenCalledOnce();
});
```

`apps/web/src/components/OverlayTab.test.tsx`:

```tsx
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { overlay } from "../test/fixtures";
import { renderUi } from "../test/render";
import { OverlayTab } from "./OverlayTab";

const statCard = overlay({
  id: "m-1-o2", kind: "stat_card", sources: ["m-1-s5"],
  data: { stat_rows: [{ label: "Shots", home: 7, away: 2 }, { label: "Expected goals", home: 1.24, away: 0.3 }] },
});
const heat = overlay({
  id: "m-1-o3", kind: "pressure_map", language: null, sources: ["m-1-p5"],
  data: { cols: 6, rows: 4, home: Array(24).fill(1), away: Array(24).fill(0) },
});
const recapCard = overlay({
  id: "m-1-o4", kind: "recap_card", sources: ["m-1-r-half_time-fan-en"],
  data: { title: "Half-time: Northbridge FC 1-0 Harbour City", score: "1-0", bullets: ["a", "b", "c"] },
});

test("with no overlays it explains what will appear", () => {
  renderUi(<OverlayTab overlays={[]} language="en" />);
  expect(screen.getByText("Overlays appear here once the match starts.")).toBeTruthy();
});

test("draws the newest overlay from its JSON and shows that JSON beside it", () => {
  renderUi(<OverlayTab overlays={[overlay({ id: "m-1-o0" }), statCard, overlay()]} language="en" />);
  const graphic = screen.getByTestId("overlay-graphic");
  expect(graphic.textContent).toContain("GOAL");
  expect(graphic.textContent).toContain("GOAL! Luca Marrowby scores.");
  expect(graphic.textContent).toContain("Northbridge FC");
  expect(JSON.parse(screen.getByTestId("overlay-json").textContent ?? "")).toEqual(overlay());
});

test("each kind has a tab and its own graphic", () => {
  renderUi(<OverlayTab overlays={[overlay(), statCard, heat, recapCard]} language="en" />);
  fireEvent.click(screen.getByRole("tab", { name: "Stat card" }));
  expect(screen.getByTestId("overlay-graphic").textContent).toContain("Expected goals");
  expect(screen.getByTestId("overlay-graphic").textContent).toContain("1.24");
  fireEvent.click(screen.getByRole("tab", { name: "Pressure map" }));
  expect(screen.getAllByTestId("pressure-cell")).toHaveLength(24);
  fireEvent.click(screen.getByRole("tab", { name: "Recap card" }));
  expect(screen.getByTestId("overlay-graphic").textContent).toContain("Half-time: Northbridge FC 1-0 Harbour City");
});

test("only kinds that have an overlay get a tab", () => {
  renderUi(<OverlayTab overlays={[statCard]} language="en" />);
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Stat card"]);
  expect(screen.getByTestId("overlay-graphic").textContent).toContain("Shots");
});

test("copy puts the overlay JSON on the clipboard", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  renderUi(<OverlayTab overlays={[overlay()]} language="en" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
  expect(JSON.parse(writeText.mock.calls[0][0] as string)).toEqual(overlay());
});
```

`apps/web/src/components/PipelinePanel.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import type { ViewerProfile } from "../contracts";
import { moment, narrative, overlay } from "../test/fixtures";
import { renderUi } from "../test/render";
import { PipelinePanel } from "./PipelinePanel";

const profile: ViewerProfile = { mode: "fan", language: "en", club: "nbr", player: null };

test("with nothing selected it asks the viewer to select a narrative", () => {
  renderUi(<PipelinePanel narrative={undefined} moment={undefined} overlay={undefined} profile={profile} />);
  expect(screen.getByText("Select a narrative to see which stage and agent produced it.")).toBeTruthy();
});

test("traces a narrative through all five stages", () => {
  renderUi(
    <PipelinePanel
      narrative={{ ...narrative({ source: "agent", agent: "commentator" }), highlighted: true }}
      moment={{ ...moment(), highlighted: true }}
      overlay={overlay()}
      profile={profile}
    />,
  );
  const steps = screen.getAllByTestId("pipeline-step").map((step) => step.textContent);
  expect(steps).toHaveLength(5);
  expect(steps[0]).toContain("Ingest");
  expect(steps[0]).toContain("m-1-e40");
  expect(steps[1]).toContain("Interpret");
  expect(steps[1]).toContain("Goal");
  expect(steps[1]).toContain("xg 0.42");
  expect(steps[2]).toContain("Explain");
  expect(steps[2]).toContain("commentator");
  expect(steps[2]).toContain("agent");
  expect(steps[3]).toContain("Render");
  expect(steps[3]).toContain("m-1-o1");
  expect(steps[4]).toContain("Personalize");
  expect(steps[4]).toContain("fan");
  expect(steps[4]).toContain("Highlighted for you");
  expect(screen.getAllByTestId("evidence").map((item) => item.textContent)).toEqual(["m-1-k1", "m-1-e40", "m-1-s23"]);
});

test("missing links are shown as a dash, not hidden", () => {
  renderUi(
    <PipelinePanel narrative={{ ...narrative(), highlighted: false }} moment={undefined} overlay={undefined}
      profile={{ ...profile, mode: "analyst" }} />,
  );
  const steps = screen.getAllByTestId("pipeline-step").map((step) => step.textContent);
  expect(steps[0]).toContain("–");
  expect(steps[3]).toContain("–");
  expect(steps[4]).not.toContain("Highlighted for you");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/components`
Expected: the four new files fail to resolve their component module; the Task 14 tests still pass.

- [ ] **Step 3: Write the preferences drawer and recap dialog**

`apps/web/src/components/PreferencesDrawer.tsx`:

```tsx
import {
  Button, DrawerBody, DrawerHeader, DrawerHeaderTitle, Field, makeStyles, OverlayDrawer, Select, tokens,
} from "@fluentui/react-components";
import type { Teams } from "../api";
import type { ViewerProfile } from "../contracts";
import { LANGUAGE_NAMES, LANGUAGES, type Language, t } from "../i18n";

const useStyles = makeStyles({
  body: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
});

interface PreferencesDrawerProps {
  open: boolean;
  profile: ViewerProfile;
  teams: Teams | null;
  onChange(profile: ViewerProfile): void;
  onClose(): void;
}

export function PreferencesDrawer({ open, profile, teams, onChange, onClose }: PreferencesDrawerProps) {
  const styles = useStyles();
  const language = profile.language;
  const clubs = teams ? [teams.home, teams.away] : [];
  const players = clubs.flatMap((club) => club.players);
  // A favorite saved for another match is not in these lists; show it as "None".
  const club = clubs.some((option) => option.id === profile.club) ? (profile.club ?? "") : "";
  const player = players.some((option) => option.id === profile.player) ? (profile.player ?? "") : "";

  return (
    <OverlayDrawer open={open} position="end" onOpenChange={(_, data) => !data.open && onClose()}>
      <DrawerHeader>
        <DrawerHeaderTitle action={<Button appearance="subtle" onClick={onClose}>{t(language, "close")}</Button>}>
          {t(language, "preferences")}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody className={styles.body}>
        <Field label={t(language, "favoriteClub")}>
          <Select value={club} onChange={(_, data) => onChange({ ...profile, club: data.value || null })}>
            <option value="">{t(language, "none")}</option>
            {clubs.map((option) => (
              <option key={option.id} value={option.id}>{option.name}</option>
            ))}
          </Select>
        </Field>
        <Field label={t(language, "favoritePlayer")}>
          <Select value={player} onChange={(_, data) => onChange({ ...profile, player: data.value || null })}>
            <option value="">{t(language, "none")}</option>
            {players.map((option) => (
              <option key={option.id} value={option.id}>{option.name}</option>
            ))}
          </Select>
        </Field>
        <Field label={t(language, "language")}>
          <Select value={language} onChange={(_, data) => onChange({ ...profile, language: data.value as Language })}>
            {LANGUAGES.map((option) => (
              <option key={option} value={option}>{LANGUAGE_NAMES[option]}</option>
            ))}
          </Select>
        </Field>
      </DrawerBody>
    </OverlayDrawer>
  );
}
```

`apps/web/src/components/RecapDialog.tsx`:

```tsx
import {
  Badge, Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Text,
} from "@fluentui/react-components";
import type { Recap } from "../contracts";
import { type Language, t } from "../i18n";

interface RecapDialogProps {
  recap: Recap | null;
  language: Language;
  onClose(): void;
}

/** Non-modal, so the match stays usable behind it. */
export function RecapDialog({ recap, language, onClose }: RecapDialogProps) {
  return (
    <Dialog modalType="non-modal" open={recap !== null} onOpenChange={(_, data) => !data.open && onClose()}>
      <DialogSurface>
        {recap && (
          <DialogBody>
            <DialogTitle>{recap.title}</DialogTitle>
            <DialogContent>
              <Text block>{recap.text}</Text>
              <ul>
                {recap.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
              {recap.source === "scripted" && <Badge appearance="tint" color="subtle">{t(language, "scripted")}</Badge>}
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={onClose}>{t(language, "close")}</Button>
            </DialogActions>
          </DialogBody>
        )}
      </DialogSurface>
    </Dialog>
  );
}
```

- [ ] **Step 4: Write the overlay tab and pipeline panel**

`apps/web/src/components/OverlayTab.tsx`:

```tsx
import { Button, makeStyles, Tab, TabList, Text, tokens } from "@fluentui/react-components";
import { useState } from "react";
import type { LowerThirdData, Overlay, PressureMapData, RecapCardData, StatCardData } from "../contracts";
import { type Language, type StringKey, t } from "../i18n";
import { latestOverlays } from "../stream/store";

type Kind = Overlay["kind"];
const KINDS: Kind[] = ["lower_third", "stat_card", "pressure_map", "recap_card"];

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM, padding: tokens.spacingHorizontalXL },
  columns: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: tokens.spacingHorizontalXL, alignItems: "start" },
  stage: { display: "flex", alignItems: "flex-end", minHeight: "220px", padding: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusLarge, backgroundColor: "#1B1B1B" },
  graphic: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, width: "100%", padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusMedium, color: "#FFFFFF", backgroundColor: "rgba(15, 108, 189, 0.92)" },
  table: { width: "100%", borderCollapse: "collapse", textAlign: "center" },
  heat: { display: "grid", gap: "2px", width: "100%", aspectRatio: "100 / 64" },
  json: { margin: 0, padding: tokens.spacingHorizontalM, maxHeight: "360px", overflow: "auto", borderRadius: tokens.borderRadiusMedium, fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, backgroundColor: tokens.colorNeutralBackground3 },
  side: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, alignItems: "flex-start" },
});

/** Draws an overlay from its JSON document and nothing else. */
export function OverlayGraphic({ overlay }: { overlay: Overlay }) {
  const styles = useStyles();
  switch (overlay.kind) {
    case "lower_third": {
      const data = overlay.data as LowerThirdData;
      return (
        <div className={styles.graphic} data-testid="overlay-graphic">
          <Text weight="bold" size={500}>{data.headline}</Text>
          <Text size={200}>{data.team} · {data.minute}'</Text>
          <Text>{data.subline}</Text>
        </div>
      );
    }
    case "stat_card": {
      const data = overlay.data as StatCardData;
      return (
        <div className={styles.graphic} data-testid="overlay-graphic">
          <table className={styles.table}>
            <tbody>
              {data.stat_rows.map((row) => (
                <tr key={row.label}>
                  <td>{row.home}</td>
                  <th scope="row">{row.label}</th>
                  <td>{row.away}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "pressure_map": {
      const data = overlay.data as PressureMapData;
      const peak = Math.max(1, ...data.home, ...data.away);
      return (
        <div className={styles.graphic} data-testid="overlay-graphic">
          <div className={styles.heat} style={{ gridTemplateColumns: `repeat(${data.cols}, 1fr)` }}>
            {data.home.map((home, index) => {
              const net = home - (data.away[index] ?? 0);
              const color = net >= 0 ? "255, 255, 255" : "255, 184, 0";
              return <div key={index} data-testid="pressure-cell" style={{ backgroundColor: `rgba(${color}, ${Math.abs(net) / peak})` }} />;
            })}
          </div>
        </div>
      );
    }
    case "recap_card": {
      const data = overlay.data as RecapCardData;
      return (
        <div className={styles.graphic} data-testid="overlay-graphic">
          <Text weight="bold" size={500}>{data.title}</Text>
          <Text size={700} weight="bold">{data.score}</Text>
          <ul>
            {data.bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
        </div>
      );
    }
  }
}

export function OverlayTab({ overlays, language }: { overlays: Overlay[]; language: Language }) {
  const styles = useStyles();
  const [chosen, setChosen] = useState<Kind | null>(null);
  const [copied, setCopied] = useState(false);
  const latest = latestOverlays(overlays);
  const available = KINDS.filter((kind) => latest[kind]);
  const newest = overlays[overlays.length - 1];

  if (!newest) {
    return (
      <div className={styles.root}>
        <Text>{t(language, "overlayEmpty")}</Text>
      </div>
    );
  }
  // Until the viewer picks a kind, follow whatever was broadcast most recently.
  const kind = chosen && latest[chosen] ? chosen : newest.kind;
  const overlay = latest[kind] as Overlay;
  const json = JSON.stringify(overlay, null, 2);

  const copy = async () => {
    await navigator.clipboard.writeText(json);
    setCopied(true);
  };

  return (
    <div className={styles.root}>
      <TabList selectedValue={kind} onTabSelect={(_, data) => { setChosen(data.value as Kind); setCopied(false); }}>
        {available.map((option) => (
          <Tab key={option} value={option}>{t(language, `overlay_${option}` as StringKey)}</Tab>
        ))}
      </TabList>
      <div className={styles.columns}>
        <div className={styles.stage}>
          <OverlayGraphic overlay={overlay} />
        </div>
        <div className={styles.side}>
          <Button onClick={copy}>{t(language, copied ? "copied" : "copy")}</Button>
          <pre className={styles.json} data-testid="overlay-json">{json}</pre>
        </div>
      </div>
    </div>
  );
}
```

`apps/web/src/components/PipelinePanel.tsx`:

```tsx
import { Badge, makeStyles, Text, tokens } from "@fluentui/react-components";
import type { Overlay, ViewerProfile } from "../contracts";
import { type StringKey, t } from "../i18n";
import type { FeedMoment, FeedNarrative } from "../stream/store";

const MISSING = "–";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  steps: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS },
  step: { display: "grid", gridTemplateColumns: "8rem 1fr", alignItems: "center", gap: tokens.spacingHorizontalS },
  evidence: { margin: 0, paddingLeft: tokens.spacingHorizontalL, fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
});

interface PipelinePanelProps {
  narrative: FeedNarrative | undefined;
  moment: FeedMoment | undefined;
  overlay: Overlay | undefined;
  profile: ViewerProfile;
}

/** Shows which stage and agent produced the selected narrative, and what it cited. */
export function PipelinePanel({ narrative, moment, overlay, profile }: PipelinePanelProps) {
  const styles = useStyles();
  const language = profile.language;

  if (!narrative) {
    return (
      <section className={styles.root} aria-label={t(language, "pipeline")}>
        <Text as="h2" weight="semibold">{t(language, "pipeline")}</Text>
        <Text>{t(language, "pipelineEmpty")}</Text>
      </section>
    );
  }

  const facts = moment?.facts.map((fact) => `${fact.label} ${fact.value}`).join(", ");
  const steps: { stage: StringKey; detail: string }[] = [
    { stage: "stageIngest", detail: moment?.event_id ?? MISSING },
    { stage: "stageInterpret", detail: moment ? `${t(language, `kind_${moment.kind}` as StringKey)} · ${facts}` : MISSING },
    { stage: "stageExplain", detail: `${narrative.agent} · ${narrative.source}` },
    { stage: "stageRender", detail: overlay ? `${overlay.kind} · ${overlay.id}` : MISSING },
    {
      stage: "stagePersonalize",
      detail: [profile.mode, profile.language, narrative.highlighted ? t(language, "highlighted") : null]
        .filter(Boolean).join(" · "),
    },
  ];

  return (
    <section className={styles.root} aria-label={t(language, "pipeline")}>
      <Text as="h2" weight="semibold">{t(language, "pipeline")}</Text>
      <ol className={styles.steps}>
        {steps.map(({ stage, detail }) => (
          <li key={stage} className={styles.step} data-testid="pipeline-step">
            <Badge appearance="tint">{t(language, stage)}</Badge>
            <Text size={200}>{detail}</Text>
          </li>
        ))}
      </ol>
      <Text size={200} weight="semibold">{t(language, "evidence")}</Text>
      <ul className={styles.evidence}>
        {narrative.evidence.map((id) => (
          <li key={id} data-testid="evidence">{id}</li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 5: Run the component tests to verify they pass**

Run: `pnpm test src/components`
Expected: 34 tests pass across nine files.

- [ ] **Step 6: Write the failing dashboard tests**

`apps/web/src/App.test.tsx`:

```tsx
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { useMatch } from "./stream/store";
import {
  AWAY, envelope, FakeEventSource, FakeEventSourceCtor, HOME, moment, narrative, recap, status,
} from "./test/fixtures";
import { renderUi } from "./test/render";

/** Answers the dashboard's HTTP calls. `current` is a queue; its last entry repeats. */
function serve({ current, started = "m-9", failStart = false }: { current: (string | null)[]; started?: string; failStart?: boolean }) {
  const queue = [...current];
  const calls: { url: string; method: string; body: unknown }[] = [];
  const reply = (statusCode: number, body: unknown) =>
    new Response(JSON.stringify(body), { status: statusCode, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === "/api/teams") return reply(200, { home: HOME, away: AWAY });
    if (url === "/api/matches/current") {
      const id = queue.length > 1 ? queue.shift() : queue[0];
      return id ? reply(200, { match_id: id }) : reply(404, { detail: "no match has been started" });
    }
    if (url === "/api/matches") return failStart ? reply(500, {}) : reply(201, { match_id: started });
    return reply(404, {});
  }));
  return calls;
}

const lastUrl = () => FakeEventSource.last?.url;

beforeEach(() => {
  FakeEventSource.instances = [];
  useMatch.setState({ data: useMatch.getInitialState().data, connection: "idle", selectedId: null });
});

async function joined(matchId = "m-1", query = "mode=fan&lang=en") {
  renderUi(<App eventSource={FakeEventSourceCtor} />);
  await waitFor(() => expect(lastUrl()).toBe(`/api/matches/${matchId}/stream?${query}`));
  const source = FakeEventSource.last;
  act(() => {
    source.open();
    source.emit(envelope(1, "match_status", status({ match_id: matchId, score_home: 1 })));
    source.emit(envelope(2, "key_moment", moment()));
    source.emit(envelope(3, "narrative", narrative()));
  });
  return source;
}

test("a viewer who opens the dashboard joins the running match", async () => {
  serve({ current: ["m-1"] });
  await joined();
  expect(screen.getByTestId("score").textContent).toBe("1 - 0");
  expect(screen.getByText(/^GOAL! Luca Marrowby scores/)).toBeTruthy();
  expect(screen.getByText("Live")).toBeTruthy();
  expect(screen.getByRole("button", { name: "23' Goal" })).toBeTruthy();
});

test("with no match running, starting one connects to it", async () => {
  const calls = serve({ current: [null], started: "m-5" });
  renderUi(<App eventSource={FakeEventSourceCtor} />);
  await screen.findByText("No match is running. Start one to begin.");
  expect(FakeEventSource.instances).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Start match" }));
  await waitFor(() => expect(lastUrl()).toBe("/api/matches/m-5/stream?mode=fan&lang=en"));
  expect(calls.find((call) => call.method === "POST")).toEqual({ url: "/api/matches", method: "POST", body: { speed: 30 } });
});

test("a failed start tells the viewer", async () => {
  serve({ current: [null], failStart: true });
  renderUi(<App eventSource={FakeEventSourceCtor} />);
  fireEvent.click(await screen.findByRole("button", { name: "Start match" }));
  expect(await screen.findByText("The match could not be started. Try again.")).toBeTruthy();
});

test("switching mode reconnects for the new variant and clears the old feed", async () => {
  serve({ current: ["m-1"] });
  const first = await joined();
  fireEvent.click(screen.getByRole("tab", { name: "Analyst" }));
  await waitFor(() => expect(lastUrl()).toBe("/api/matches/m-1/stream?mode=analyst&lang=en"));
  expect(first.closed).toBe(true);
  expect(screen.queryByText(/^GOAL! Luca Marrowby scores/)).toBeNull();
  expect(JSON.parse(localStorage.getItem("kickstream.profile") ?? "{}").mode).toBe("analyst");
});

test("saved preferences choose the variant and the interface language", async () => {
  localStorage.setItem("kickstream.profile", JSON.stringify({ mode: "analyst", language: "es", club: "nbr", player: null }));
  serve({ current: ["m-1"] });
  await joined("m-1", "mode=analyst&lang=es&club=nbr");
  expect(screen.getByRole("button", { name: "Reiniciar partido" })).toBeTruthy();
});

test("corrupt saved preferences fall back to the defaults", async () => {
  localStorage.setItem("kickstream.profile", "{not json");
  serve({ current: ["m-1"] });
  await joined();
});

test("when the match is replaced, the viewer is moved to the new one", async () => {
  serve({ current: ["m-1", "m-2"] });
  const first = await joined();
  act(() => first.emit(envelope(4, "match_status", status({ state: "abandoned" }))));
  await waitFor(() => expect(lastUrl()).toBe("/api/matches/m-2/stream?mode=fan&lang=en"));
  expect(first.closed).toBe(true);
  expect(screen.queryByText(/^GOAL! Luca Marrowby scores/)).toBeNull();
});

test("when the server no longer knows the match, the viewer is offered a new one", async () => {
  serve({ current: ["m-1", null] });
  const first = await joined();
  act(() => first.fail(2));
  await screen.findByRole("button", { name: "Start match" });
  expect(screen.getByText("No match is running. Start one to begin.")).toBeTruthy();
});

test("a recap opens by itself and can be reopened from the timeline", async () => {
  serve({ current: ["m-1"] });
  const source = await joined();
  act(() => source.emit(envelope(4, "recap", recap())));
  expect((await screen.findByRole("dialog")).textContent).toContain("Half-time: Northbridge FC 1-0 Harbour City");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Half-time recap" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
});

test("selecting a narrative shows how it was made", async () => {
  serve({ current: ["m-1"] });
  await joined();
  fireEvent.click(screen.getByRole("button", { name: /^23'.*GOAL!/ }));
  const steps = screen.getAllByTestId("pipeline-step").map((step) => step.textContent);
  expect(steps[1]).toContain("Goal");
  expect(steps[2]).toContain("scripted");
});

test("the overlay tab shows broadcast JSON for the match", async () => {
  serve({ current: ["m-1"] });
  const source = await joined();
  fireEvent.click(screen.getByRole("tab", { name: "Overlay" }));
  expect(screen.getByText("Overlays appear here once the match starts.")).toBeTruthy();
  const lowerThird = {
    id: "m-1-o1", match_id: "m-1", minute: 23, kind: "lower_third", language: "en", duration_ms: 6000,
    sources: ["m-1-k1-fan-en", "m-1-k1"], data: { headline: "GOAL", subline: "What a strike.", team: "Northbridge FC", minute: 23 },
  };
  act(() => source.emit(envelope(4, "overlay", lowerThird)));
  expect(screen.getByTestId("overlay-graphic").textContent).toContain("What a strike.");
});
```

- [ ] **Step 7: Run the dashboard tests to verify they fail**

Run: `pnpm test src/App.test.tsx`
Expected: every test fails; the shell renders only a title, so no stream is opened.

- [ ] **Step 8: Add the one new string**

In `apps/web/src/i18n.ts`, add a `startFailed` entry to each of the three language objects, after `noMatch`:

```ts
  // en
  startFailed: "The match could not be started. Try again.",
  // es
  startFailed: "No se pudo iniciar el partido. Inténtalo de nuevo.",
  // hi
  startFailed: "मैच शुरू नहीं हो सका। फिर से कोशिश करें।",
```

- [ ] **Step 9: Write the dashboard**

`apps/web/src/App.tsx`:

```tsx
import { makeStyles, MessageBar, MessageBarBody, Switch, Tab, TabList, tokens } from "@fluentui/react-components";
import { useCallback, useEffect, useState } from "react";
import { fetchCurrentMatch, fetchTeams, speedFromLocation, startMatch, streamUrl, type Teams } from "./api";
import { Header } from "./components/Header";
import { NarrativeFeed } from "./components/NarrativeFeed";
import { OverlayTab } from "./components/OverlayTab";
import { PipelinePanel } from "./components/PipelinePanel";
import { Pitch } from "./components/Pitch";
import { PreferencesDrawer } from "./components/PreferencesDrawer";
import { RecapDialog } from "./components/RecapDialog";
import { StatsPanel } from "./components/StatsPanel";
import { Timeline } from "./components/Timeline";
import type { Recap, ViewerProfile } from "./contracts";
import { t } from "./i18n";
import { loadProfile, saveProfile } from "./prefs";
import { connect } from "./stream/client";
import { useMatch } from "./stream/store";

type View = "match" | "overlay";

const useStyles = makeStyles({
  app: { display: "flex", flexDirection: "column", minHeight: "100vh", backgroundColor: tokens.colorNeutralBackground2 },
  views: { padding: `0 ${tokens.spacingHorizontalXL}` },
  match: {
    display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)", gap: tokens.spacingHorizontalXL,
    padding: tokens.spacingHorizontalXL, alignItems: "start",
    "@media (max-width: 900px)": { gridTemplateColumns: "minmax(0, 1fr)" },
  },
  column: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
  panel: { padding: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow2 },
  feed: { maxHeight: "70vh", display: "flex", flexDirection: "column" },
});

interface AppProps {
  /** Injected by tests; the browser's EventSource is used otherwise. */
  eventSource?: new (url: string) => EventSource;
}

export function App({ eventSource }: AppProps) {
  const styles = useStyles();
  const [profile, setProfile] = useState<ViewerProfile>(loadProfile);
  const [matchId, setMatchId] = useState<string | null>(null);
  const [teams, setTeams] = useState<Teams | null>(null);
  const [view, setView] = useState<View>("match");
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [showPressure, setShowPressure] = useState(true);
  const [openRecap, setOpenRecap] = useState<Recap | null>(null);
  const [startFailed, setStartFailed] = useState(false);

  const data = useMatch((state) => state.data);
  const connection = useMatch((state) => state.connection);
  const selectedId = useMatch((state) => state.selectedId);
  const select = useMatch((state) => state.select);
  const language = profile.language;

  /** Follow whichever match the server considers current, or none. */
  const joinCurrent = useCallback(async () => {
    try {
      const current = await fetchCurrentMatch();
      setMatchId(current);
      if (current === null) useMatch.getState().setConnection("idle");
    } catch {
      useMatch.getState().setConnection("reconnecting");
    }
  }, []);

  useEffect(() => {
    fetchTeams().then(setTeams).catch(() => setTeams(null));
    void joinCurrent();
  }, [joinCurrent]);

  // One stream per (match, profile). Changing either replays the match in the new variant.
  useEffect(() => {
    if (matchId === null) return;
    const { apply, reset, setConnection } = useMatch.getState();
    reset();
    setOpenRecap(null);
    return connect(streamUrl(matchId, profile), { onEnvelope: apply, onConnection: setConnection }, eventSource);
  }, [matchId, profile, eventSource]);

  // A replaced match, or one the server no longer knows: move to the current match.
  const abandoned = data.status?.state === "abandoned";
  useEffect(() => {
    if (abandoned || connection === "no_match") void joinCurrent();
  }, [abandoned, connection, joinCurrent]);

  const latestRecap = data.recaps[data.recaps.length - 1] ?? null;
  useEffect(() => {
    // Keyed on the recap's id: open when a new recap arrives, not on every render of the same one.
    if (latestRecap) setOpenRecap(latestRecap);
  }, [latestRecap?.id]);

  const updateProfile = (next: ViewerProfile) => {
    setProfile(next);
    saveProfile(next);
  };

  const start = async () => {
    setStartFailed(false);
    try {
      setMatchId(await startMatch(speedFromLocation(window.location.search)));
    } catch {
      setStartFailed(true);
    }
  };

  const hasMatch = matchId !== null && connection !== "idle";
  const selectedNarrative = data.narratives.find((narrative) => narrative.moment_id === selectedId);
  const selectedMoment = data.moments.find((moment) => moment.id === selectedId);
  const selectedOverlay = selectedNarrative && data.overlays.find((overlay) => overlay.sources.includes(selectedNarrative.id));

  return (
    <div className={styles.app}>
      <Header
        status={hasMatch ? data.status : null}
        connection={connection}
        profile={profile}
        onModeChange={(mode) => updateProfile({ ...profile, mode })}
        onLanguageChange={(next) => updateProfile({ ...profile, language: next })}
        onOpenPreferences={() => setPreferencesOpen(true)}
        onStart={start}
      />
      {startFailed && (
        <MessageBar intent="error">
          <MessageBarBody>{t(language, "startFailed")}</MessageBarBody>
        </MessageBar>
      )}
      <TabList className={styles.views} selectedValue={view} onTabSelect={(_, tab) => setView(tab.value as View)}>
        <Tab value="match">{t(language, "matchTab")}</Tab>
        <Tab value="overlay">{t(language, "overlayTab")}</Tab>
      </TabList>
      {view === "match" ? (
        <main className={styles.match}>
          <div className={styles.column}>
            <div className={styles.panel}>
              <Switch checked={showPressure} label={t(language, "pressureMap")}
                onChange={(_, state) => setShowPressure(state.checked)} />
              <Pitch events={data.events} pressure={data.pressure} status={data.status} showPressure={showPressure} language={language} />
            </div>
            <div className={styles.panel}>
              <Timeline moments={data.moments} recaps={data.recaps} selectedId={selectedId} language={language}
                onSelect={select} onOpenRecap={setOpenRecap} />
            </div>
            <div className={styles.panel}>
              <StatsPanel stats={data.stats} status={data.status} language={language} />
            </div>
          </div>
          <div className={styles.column}>
            <div className={`${styles.panel} ${styles.feed}`}>
              <NarrativeFeed narratives={data.narratives} selectedId={selectedId} language={language} onSelect={select} />
            </div>
            <div className={styles.panel}>
              <PipelinePanel narrative={selectedNarrative} moment={selectedMoment} overlay={selectedOverlay || undefined} profile={profile} />
            </div>
          </div>
        </main>
      ) : (
        <main>
          <OverlayTab overlays={data.overlays} language={language} />
        </main>
      )}
      <PreferencesDrawer open={preferencesOpen} profile={profile} teams={teams} onChange={updateProfile}
        onClose={() => setPreferencesOpen(false)} />
      <RecapDialog recap={openRecap} language={language} onClose={() => setOpenRecap(null)} />
    </div>
  );
}
```

- [ ] **Step 10: Run every web test and the type check**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass, including `i18n.test.ts` (which confirms `startFailed` exists in all three languages); no type errors.

- [ ] **Step 11: See it running**

In one terminal, from the repo root: `pnpm dev:api`
In another: `pnpm dev:web`, then open `http://127.0.0.1:5173/?speed=120`.

Check by hand:
1. Press **Start match**. Markers appear on the pitch, the clock and stats advance, narratives arrive.
2. Switch **Fan / Analyst**. The feed is replaced by the other variant of the same moments.
3. Change the language to Español, then हिन्दी. Interface labels and narratives change.
4. Open **Preferences**, pick Northbridge FC. Their narratives and timeline markers are highlighted.
5. Click a narrative. "How this was made" lists five stages and the evidence IDs.
6. Open the **Overlay** tab. The graphic and its JSON update as the match plays; **Copy JSON** works.
7. Open the same URL in a second window. It joins the same match and catches up.
8. Press **Restart match** in one window. The other window moves to the new match by itself.
9. Switch the operating system between light and dark mode. The dashboard follows.

- [ ] **Step 12: Commit**

```bash
git add apps/web/src
git commit -m "feat: assemble the Kickstream dashboard"
```

---

### Task 16: End-to-end smoke test and README

**Files:**
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/smoke.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: the running pipeline (`kickstream.app:create_app`) and the web app; the exact scripted phrases guaranteed in Task 6; the `?speed=` parameter from Task 12.
- Produces: `pnpm e2e`, which starts both servers with no model endpoint configured and plays one match.

- [ ] **Step 1: Write the Playwright configuration and the test**

`apps/web/playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

// No model endpoint is configured, so the whole run uses scripted narratives.
const NO_MODEL = { KICKSTREAM_LLM_BASE_URL: "", KICKSTREAM_LLM_MODEL: "", KICKSTREAM_LLM_API_KEY: "" };

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  use: { baseURL: "http://127.0.0.1:5173" },
  webServer: [
    {
      command: "uv run --project ../../services/pipeline uvicorn kickstream.app:create_app --factory --port 8000",
      url: "http://127.0.0.1:8000/api/teams",
      env: NO_MODEL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "pnpm dev --host 127.0.0.1",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
```

`apps/web/e2e/smoke.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("a seeded match plays through every stage to the full-time recap", async ({ page }) => {
  // 600x plays ninety minutes in nine seconds.
  await page.goto("/?speed=600");
  await page.getByRole("button", { name: /^(Start|Restart) match$/ }).click();

  // Ingest -> Interpret -> Explain: a goal becomes a Fan narrative in English.
  await expect(page.getByText(/^GOAL!/).first()).toBeVisible({ timeout: 30_000 });

  // Personalize: Analyst mode replays the same moments in the analyst variant.
  await page.getByRole("tab", { name: "Analyst" }).click();
  await expect(page.getByText(/The goal reflects the balance of play/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^GOAL!/)).toHaveCount(0);

  // Personalize: switching language changes narratives and interface text.
  await page.getByLabel("Language").selectOption("es");
  await expect(page.getByText(/El gol refleja el desarrollo del juego/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Reiniciar partido" })).toBeVisible();

  // Explain: the full-time recap arrives in the viewer's language.
  await expect(page.getByRole("dialog")).toContainText("Final:", { timeout: 60_000 });
  await page.getByRole("button", { name: "Cerrar" }).click();

  // Render: the overlay tab draws the latest overlay from its JSON.
  await page.getByRole("tab", { name: "Gráficos" }).click();
  await expect(page.getByTestId("overlay-graphic")).toBeVisible();
  const overlay = JSON.parse((await page.getByTestId("overlay-json").textContent()) ?? "{}");
  expect(overlay.match_id).toMatch(/^m-\d+$/);
  expect(["lower_third", "stat_card", "pressure_map", "recap_card"]).toContain(overlay.kind);
});
```

- [ ] **Step 2: Run the end-to-end test**

Run (from `apps/web`): `pnpm exec playwright install chromium && pnpm e2e`
Expected: 1 passed. The run takes under a minute after the servers are up.

If the first assertion times out, the demo match has no goal narrative reaching the browser. Check in this order: `curl -s localhost:8000/api/matches/current` returns a match; `curl -sN "localhost:8000/api/matches/<id>/stream" | head` shows envelopes; the browser's network tab shows the `/stream` request staying open through the Vite proxy.

- [ ] **Step 3: Write the README**

Replace `README.md` with:

````markdown
# Kickstream

Kickstream turns a football match event stream into live intelligence, AI narratives, automated recaps and personalized viewing. This repository holds cycle 1: one synthetic match running locally through the full pipeline and watched in a Fluent UI dashboard.

```
simulator ──► analytics ──► narration ──► overlay ──► gateway ──SSE──► web
 Ingest       Interpret     Explain       Render      Personalize
```

## Run it

Requires Python 3.13 with [uv](https://docs.astral.sh/uv/), and Node 24 with [pnpm](https://pnpm.io/).

```bash
pnpm install
(cd services/pipeline && uv sync)

pnpm dev:api     # pipeline on http://127.0.0.1:8000
pnpm dev:web     # dashboard on http://127.0.0.1:5173
```

Open the dashboard and press **Start match**. A 90-minute match plays in about three minutes. Add `?speed=120` to the URL to play it faster (1 to 600).

## AI narratives

With no configuration, narratives come from templates and are marked **Scripted**. To have the agents write them, point Kickstream at any OpenAI-compatible Chat Completions endpoint before starting the pipeline:

| Variable | Meaning |
|---|---|
| `KICKSTREAM_LLM_BASE_URL` | Endpoint base URL, ending in `/v1` |
| `KICKSTREAM_LLM_MODEL` | Model or deployment name |
| `KICKSTREAM_LLM_API_KEY` | API key |
| `KICKSTREAM_LLM_MAX_CALLS` | Model calls allowed per match (default 60) |
| `KICKSTREAM_CACHE_DIR` | Where agent output is cached (default `.cache/narration`) |

Four Microsoft Agent Framework agents do the writing: a Commentator and a Tactical Analyst work on each key moment concurrently, a Recap Writer covers half-time and full-time, and a Localizer translates into Spanish and Hindi. Each item is written once per mode and language and sent to every viewer on that variant, so model cost does not grow with the audience. Output is cached, so replaying the same match costs no model calls. If the model is slow, rate-limited or returns something unusable, that item falls back to a template.

## Layout

| Path | Contents |
|---|---|
| `packages/contracts/` | JSON Schema for every message; the Python and TypeScript types are generated from it |
| `services/pipeline/kickstream/` | The five stages, the ports they depend on, and the adapters behind those ports |
| `services/pipeline/kickstream/app.py` | The composition root: the only place adapters are chosen |
| `apps/web/` | The React and Fluent UI dashboard |
| `docs/superpowers/` | Design spec and implementation plan |

Stages talk only through the event bus and the contracts, and never import one another. Moving to Azure means adding adapters for the four ports (event bus, narrative writer, match store, broadcaster) and choosing them in `app.py`.

## Test it

```bash
pnpm test:api                         # pipeline unit and integration tests
pnpm test:web                         # dashboard unit and component tests
(cd apps/web && pnpm e2e)             # one match, end to end, in a real browser
```

No test calls a live model.

After changing `packages/contracts/kickstream.schema.json`, regenerate both sets of types:

```bash
(cd services/pipeline && uv run python -m kickstream.tools.gen_contracts)
(cd apps/web && pnpm gen:contracts)
```
````

- [ ] **Step 4: Run every check one last time**

```bash
(cd services/pipeline && uv run ruff check . && uv run pytest)
(cd apps/web && pnpm typecheck && pnpm test && pnpm build && pnpm e2e)
```

Expected: no lint findings, all Python tests pass, no type errors, all web tests pass, the production build succeeds, and the end-to-end test passes.

Then confirm the spec's definition of done by hand, using the checklist in Task 15 Step 11, with the pipeline started with no `KICKSTREAM_LLM_*` variables set.

- [ ] **Step 5: Commit**

```bash
git add apps/web/playwright.config.ts apps/web/e2e README.md
git commit -m "test: add end-to-end smoke test and project README"
```

