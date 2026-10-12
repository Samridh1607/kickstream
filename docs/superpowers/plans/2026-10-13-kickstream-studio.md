# Kickstream Studio and Scenes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A streamer composes scenes on a 16:9 canvas at `/studio`, and `/program` shows the active scene live, with banners, a ticker, animated replays and countdowns driven from the server.

**Architecture:** One `Studio` document lives on the server behind a `StudioStore` port. Every rule for changing it is a pure function in `studio/rules.py`; `StudioService` applies a rule, bumps the revision, saves, and pushes the whole document to connected pages over Server-Sent Events. Timers are deadlines inside the document, expired by `tick()` against an injected clock. The web app renders a scene with one `SceneCanvas` component used by both pages; the control page adds drag, resize and panels on top.

**Tech Stack:** As cycle 1: Python 3.13, FastAPI, Pydantic 2, pytest; React 19, TypeScript 7, Fluent UI v9, zustand, Vitest, Playwright. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-12-kickstream-studio-design.md`

## Global Constraints

- All cycle 1 constraints still apply: stages import only `kickstream.contracts`, `kickstream.domain`, `kickstream.ports` and themselves; adapters are named only in `kickstream/app.py`; contracts are generated from `packages/contracts/kickstream.schema.json` and never edited by hand; no test calls a live model.
- `studio` is a stage package. It never imports `gateway`, `simulator`, `analytics`, `narration` or `overlay`.
- The canvas is logical 1920 × 1080. Positions and sizes are whole logical pixels. The grid is 20 pixels. Elements are at least 40 × 40 and stay inside the canvas.
- Limits: 20 scenes, 20 saved templates, 40 elements per scene, scene name 1 to 60 characters, text element 200 characters, banner text 1 to 200 characters, banner duration 3 to 30 seconds (default 8), banner queue 10, ticker 20 messages of up to 120 characters, ticker speed 40 to 400, start countdown up to 24 hours ahead, break 1 to 60 minutes, automatic half-time break 2 minutes, replay 8 seconds covering the 20 match seconds before the moment, images PNG / JPEG / WebP up to 2 MB each and 50 in total.
- Times in the studio document are Unix seconds as numbers. Every document sent to a page carries `server_time`, and pages compute remaining time from the server's clock, not their own.
- The control page (`/studio`) is in English. Everything drawn on the program page follows the studio's program language.
- No new sign-in, no video output, no audio.
- All Python commands run from `services/pipeline`; all web commands run from `apps/web`.
- Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

Inputs the spec does not spell out but a streamer will hit. Each has a pinning test in the task named.

1. **Editing the scene that is live.** The streamer drags an element on the active scene while viewers are watching the program. The program should show the move as soon as the drag ends, and a second control page should not overwrite it with a stale copy when it saves a different scene. (Tasks 2 and 8)
2. **Deleting or changing what a timer points at.** The scene a break should return to is deleted during the break; the streamer switches scenes by hand during a break; a banner's time runs out while the queue is empty. Each should end cleanly on a scene that exists, with nothing left stuck on screen. (Task 2)
3. **The server was down when a deadline passed.** A countdown or break ended, or a banner expired, while the server was stopped. On start it should catch up at once: the break ends, the match starts if automatic start is on, the stale banner is gone. (Task 4)
4. **Uploads that are not what they claim.** A text file renamed `.png`, an SVG, an empty body, a 5 MB photo, an ID with `../` in it. Each should be refused with a clear message or a 404, and nothing outside the image directory should be readable. (Tasks 3 and 5)
5. **A program page opened before anything exists, or left open across a restart.** No match yet, no banner, no countdown; then the server restarts. The page should show the scene with empty elements holding their boxes, and pick up the current document by itself when the server returns. (Tasks 6 and 7)

## File Structure

```
packages/contracts/kickstream.schema.json        + SceneElement, Scene, StudioSettings, Banner, Ticker,
                                                   Countdown, Replay, Studio
services/pipeline/kickstream/
  ports/studio_store.py                          StudioStore: load / save the document
  ports/image_store.py                           ImageStore: save / fetch uploaded images
  adapters/json_studio_store.py                  one JSON file, written atomically
  adapters/dir_image_store.py                    one directory of images
  studio/
    templates.py                                 the five built-in templates and the default studio
    rules.py                                     every rule, as pure functions on the document
    service.py                                   holds the document: apply, save, notify, tick, run
    stage.py                                     bus intake: automatic banners, half-time break
    api.py                                       HTTP surface under /api/studio, and replay events
  app.py                                         wires the studio in
  tests/test_studio_*.py
apps/web/src/
  main.tsx                                       chooses the page from the URL path
  stream/useCurrentMatch.ts                      join / retry / follow logic, extracted from App
  studio/
    api.ts                                       HTTP client for /api/studio
    geometry.ts                                  snap, clamp, move, resize, layers, scale
    useStudio.ts                                 the studio document, live
    format.ts                                    countdown and ticker text
    elements.tsx                                 one view per element type
    SceneCanvas.tsx                              draws a scene; optional drag, resize, keyboard
    ProgramPage.tsx                              /program
    panels.tsx                                   the control page's panels
    StudioPage.tsx                               /studio
  e2e/studio.spec.ts
```

---

### Task 1: Studio contracts

**Files:**
- Modify: `packages/contracts/kickstream.schema.json` (add eight definitions)
- Regenerate: `services/pipeline/kickstream/contracts.py`, `apps/web/src/contracts.ts`
- Test: `services/pipeline/tests/test_studio_contracts.py`

**Interfaces:**
- Consumes: the cycle 1 schema and both generators.
- Produces: Pydantic models and TypeScript interfaces `SceneElement, Scene, StudioSettings, Banner, Ticker, Countdown, Replay, Studio`.
  - `SceneElement`: `id: str`, `type` (one of `scoreboard, pitch, narration, stats, banner, ticker, timeline, recap, replay, countdown, text, image`), `x, y, width, height, layer: int`, `visible: bool`, `props: dict`.
  - `Scene`: `id`, `name` (1 to 60), `template: str | None`, `elements` (at most 40).
  - `StudioSettings`: `mode`, `language`, `auto_banner`, `auto_start`, `auto_half_time_break`.
  - `Banner`: `id`, `text` (1 to 200), `kind` (`goal, card, info, custom`), `duration_s` (3 to 30), `ends_at: float | None`, `source_id: str | None`.
  - `Ticker`: `enabled`, `speed` (40 to 400), `messages` (at most 20, each at most 120), `show_score`, `show_stats`.
  - `Countdown`: `kind` (`start, break`), `ends_at: float`, `label` (at most 60; empty means the default label).
  - `Replay`: `match_id`, `moment_id`, `minute`, `started_at`, `duration_s`.
  - `Studio`: `revision`, `server_time`, `scenes` (1 to 20), `active_scene_id`, `previous_scene_id: str | None`, `templates` (at most 20), `settings`, `banner: Banner | None`, `banner_queue` (at most 10), `ticker`, `countdown: Countdown | None`, `replay: Replay | None`.

- [ ] **Step 1: Write the failing tests**

`services/pipeline/tests/test_studio_contracts.py`:

```python
import pytest
from pydantic import ValidationError


def element(**over):
    fields = {"id": "e1", "type": "text", "x": 0, "y": 0, "width": 400, "height": 100, "layer": 1,
              "visible": True, "props": {"text": "Hello"}}
    return {**fields, **over}


def studio(**over):
    fields = {
        "revision": 1, "server_time": 1000.0,
        "scenes": [{"id": "s1", "name": "Live", "elements": [element()]}],
        "active_scene_id": "s1", "templates": [],
        "settings": {"mode": "fan", "language": "en", "auto_banner": True, "auto_start": True,
                     "auto_half_time_break": False},
        "banner_queue": [],
        "ticker": {"enabled": True, "speed": 120, "messages": [], "show_score": True, "show_stats": True},
    }
    return {**fields, **over}


def test_a_studio_document_round_trips_through_json():
    from kickstream.contracts import Studio

    doc = Studio.model_validate(studio(
        banner={"id": "b1", "text": "GOAL!", "kind": "goal", "duration_s": 8, "ends_at": 1008.0},
        countdown={"kind": "break", "ends_at": 1300.0, "label": ""},
        replay={"match_id": "m-1", "moment_id": "m-1-k1", "minute": 23, "started_at": 1000.0, "duration_s": 8.0}))
    assert Studio.model_validate_json(doc.model_dump_json()) == doc
    assert doc.previous_scene_id is None and doc.scenes[0].template is None
    assert doc.banner.source_id is None


def test_optional_parts_default_to_nothing_on_screen():
    from kickstream.contracts import Studio

    doc = Studio.model_validate(studio())
    assert doc.banner is None and doc.countdown is None and doc.replay is None


@pytest.mark.parametrize("bad", [
    {"scenes": []},
    {"scenes": [{"id": "s1", "name": "", "elements": []}]},
    {"scenes": [{"id": "s1", "name": "x" * 61, "elements": []}]},
    {"scenes": [{"id": "s1", "name": "Live", "elements": [element(type="webcam")]}]},
    {"scenes": [{"id": "s1", "name": "Live", "elements": [element(x=1.5)]}]},
    {"banner": {"id": "b", "text": "", "kind": "goal", "duration_s": 8}},
    {"banner": {"id": "b", "text": "x", "kind": "goal", "duration_s": 2}},
    {"banner": {"id": "b", "text": "x", "kind": "shout", "duration_s": 8}},
    {"ticker": {"enabled": True, "speed": 10, "messages": [], "show_score": True, "show_stats": True}},
    {"ticker": {"enabled": True, "speed": 120, "messages": ["x" * 121], "show_score": True, "show_stats": True}},
    {"countdown": {"kind": "nap", "ends_at": 1.0, "label": ""}},
    {"surprise": 1},
], ids=["no-scenes", "blank-name", "long-name", "unknown-element", "fractional-position", "blank-banner",
        "short-banner", "unknown-banner-kind", "slow-ticker", "long-ticker-message", "unknown-countdown", "extra-field"])
def test_documents_outside_the_limits_are_rejected(bad):
    from kickstream.contracts import Studio

    with pytest.raises(ValidationError):
        Studio.model_validate(studio(**bad))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_studio_contracts.py -q`
Expected: 14 failed with `ImportError: cannot import name 'Studio' from 'kickstream.contracts'`.

- [ ] **Step 3: Add the definitions to the schema**

In `packages/contracts/kickstream.schema.json`, add these eight entries to `$defs`, after `Envelope`:

```json
    "SceneElement": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "type", "x", "y", "width", "height", "layer", "visible", "props"],
      "properties": {
        "id": { "type": "string" },
        "type": { "enum": ["scoreboard", "pitch", "narration", "stats", "banner", "ticker", "timeline", "recap", "replay", "countdown", "text", "image"] },
        "x": { "type": "integer" },
        "y": { "type": "integer" },
        "width": { "type": "integer" },
        "height": { "type": "integer" },
        "layer": { "type": "integer" },
        "visible": { "type": "boolean" },
        "props": { "type": "object" }
      }
    },
    "Scene": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "name", "elements"],
      "properties": {
        "id": { "type": "string" },
        "name": { "type": "string", "minLength": 1, "maxLength": 60 },
        "template": { "type": ["string", "null"], "default": null },
        "elements": { "type": "array", "items": { "$ref": "#/$defs/SceneElement" }, "maxItems": 40 }
      }
    },
    "StudioSettings": {
      "type": "object", "additionalProperties": false,
      "required": ["mode", "language", "auto_banner", "auto_start", "auto_half_time_break"],
      "properties": {
        "mode": { "enum": ["fan", "analyst"] },
        "language": { "enum": ["en", "es", "hi"] },
        "auto_banner": { "type": "boolean" },
        "auto_start": { "type": "boolean" },
        "auto_half_time_break": { "type": "boolean" }
      }
    },
    "Banner": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "text", "kind", "duration_s"],
      "properties": {
        "id": { "type": "string" },
        "text": { "type": "string", "minLength": 1, "maxLength": 200 },
        "kind": { "enum": ["goal", "card", "info", "custom"] },
        "duration_s": { "type": "integer", "minimum": 3, "maximum": 30 },
        "ends_at": { "type": ["number", "null"], "default": null },
        "source_id": { "type": ["string", "null"], "default": null }
      }
    },
    "Ticker": {
      "type": "object", "additionalProperties": false,
      "required": ["enabled", "speed", "messages", "show_score", "show_stats"],
      "properties": {
        "enabled": { "type": "boolean" },
        "speed": { "type": "integer", "minimum": 40, "maximum": 400 },
        "messages": { "type": "array", "items": { "type": "string", "maxLength": 120 }, "maxItems": 20 },
        "show_score": { "type": "boolean" },
        "show_stats": { "type": "boolean" }
      }
    },
    "Countdown": {
      "type": "object", "additionalProperties": false,
      "required": ["kind", "ends_at", "label"],
      "properties": {
        "kind": { "enum": ["start", "break"] },
        "ends_at": { "type": "number" },
        "label": { "type": "string", "maxLength": 60 }
      }
    },
    "Replay": {
      "type": "object", "additionalProperties": false,
      "required": ["match_id", "moment_id", "minute", "started_at", "duration_s"],
      "properties": {
        "match_id": { "type": "string" },
        "moment_id": { "type": "string" },
        "minute": { "type": "integer" },
        "started_at": { "type": "number" },
        "duration_s": { "type": "number" }
      }
    },
    "Studio": {
      "type": "object", "additionalProperties": false,
      "required": ["revision", "server_time", "scenes", "active_scene_id", "templates", "settings", "banner_queue", "ticker"],
      "properties": {
        "revision": { "type": "integer" },
        "server_time": { "type": "number" },
        "scenes": { "type": "array", "items": { "$ref": "#/$defs/Scene" }, "minItems": 1, "maxItems": 20 },
        "active_scene_id": { "type": "string" },
        "previous_scene_id": { "type": ["string", "null"], "default": null },
        "templates": { "type": "array", "items": { "$ref": "#/$defs/Scene" }, "maxItems": 20 },
        "settings": { "$ref": "#/$defs/StudioSettings" },
        "banner": { "anyOf": [{ "$ref": "#/$defs/Banner" }, { "type": "null" }], "default": null },
        "banner_queue": { "type": "array", "items": { "$ref": "#/$defs/Banner" }, "maxItems": 10 },
        "ticker": { "$ref": "#/$defs/Ticker" },
        "countdown": { "anyOf": [{ "$ref": "#/$defs/Countdown" }, { "type": "null" }], "default": null },
        "replay": { "anyOf": [{ "$ref": "#/$defs/Replay" }, { "type": "null" }], "default": null }
      }
    }
```

Remember the comma after the closing brace of `Envelope`.

- [ ] **Step 4: Regenerate both sets of types**

Run (from `services/pipeline`): `uv run python -m kickstream.tools.gen_contracts`
Run (from `apps/web`): `pnpm gen:contracts`
Expected: `contracts.py` contains `class Studio(BaseModel):` with `banner: Banner | None = None`; `contracts.ts` contains `export interface Studio {`.

- [ ] **Step 5: Run the tests to verify they pass**

Run (from `services/pipeline`): `uv run pytest tests/test_studio_contracts.py tests/test_contracts.py -q`
Expected: 19 passed.

Run (from `apps/web`): `pnpm test src/contracts.test.ts && pnpm typecheck`
Expected: 2 passed; no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts services/pipeline/kickstream/contracts.py services/pipeline/tests/test_studio_contracts.py apps/web/src/contracts.ts
git commit -m "feat: add studio document contracts"
```

---

### Task 2: Studio rules and built-in templates

**Files:**
- Create: `services/pipeline/kickstream/studio/__init__.py` (empty), `templates.py`, `rules.py`
- Test: `services/pipeline/tests/test_studio_rules.py`

**Interfaces:**
- Consumes: the Task 1 models; `KeyMoment`.
- Produces:
  - `studio.templates`: `CANVAS_W = 1920`, `CANVAS_H = 1080`; template names `STARTING_SOON = "Starting soon"`, `LIVE_MATCH = "Live match"`, `ANALYST_DESK = "Analyst desk"`, `BREAK = "Break"`, `FULL_TIME = "Full-time"`; `builtin_templates() -> list[Scene]`; `default_studio() -> Studio` (one scene per template, Starting soon active, revision 0).
  - `studio.rules.StudioError(status: int, field: str, message: str)` with those three attributes.
  - Every rule takes a `Studio` and returns a new `Studio`; none mutates its argument:
    - `create_scene(doc, source: Literal["builtin", "template", "scene"], ref: str, name: str | None = None)`
    - `replace_scene(doc, scene_id, name, elements: list[SceneElement])`
    - `delete_scene(doc, scene_id)`, `activate_scene(doc, scene_id)`
    - `save_template(doc, scene_id, name: str | None = None)`, `delete_template(doc, template_id)`
    - `set_settings(doc, settings: StudioSettings)`, `set_ticker(doc, ticker: Ticker)`
    - `enqueue_banner(doc, text, kind, duration_s, now: float, source_id: str | None = None)`, `clear_banner(doc, now)`
    - `start_countdown(doc, starts_at: float, now, label: str = "")`, `start_break(doc, minutes: int, now, label: str = "")`, `end_countdown(doc)`
    - `start_replay(doc, moment: KeyMoment, now)`, `stop_replay(doc)`
  - `next_deadline(doc) -> float | None`; `expire(doc, now) -> tuple[Studio, list[str]]` (the list holds `"start_match"` when a start countdown ended with automatic start on).
  - `normalize_element(element) -> SceneElement` (clamps into the canvas and cleans `props`).
  - `sanitize_raw(raw: dict) -> dict` (drops elements of unknown type from a loaded file); `sniff_image(content: bytes) -> str | None` (media type from content).
  - Constants `MAX_SCENES, MAX_TEMPLATES, MAX_ELEMENTS, MAX_QUEUE, MAX_IMAGE_BYTES, REPLAY_SECONDS, HALF_TIME_BREAK_MINUTES`.

- [ ] **Step 1: Write the failing tests**

`services/pipeline/tests/test_studio_rules.py`:

```python
import pytest

from kickstream.contracts import KeyMoment, SceneElement, StatFact, Studio, Ticker
from kickstream.studio import rules
from kickstream.studio.rules import StudioError
from kickstream.studio.templates import (ANALYST_DESK, BREAK, CANVAS_H, CANVAS_W, FULL_TIME, LIVE_MATCH,
                                         STARTING_SOON, builtin_templates, default_studio)

NOW = 1_000.0


def scene_id(doc, template):
    return next(s.id for s in doc.scenes if s.template == template)


def element(**over):
    fields = {"id": "x1", "type": "text", "x": 100, "y": 100, "width": 400, "height": 100, "layer": 1,
              "visible": True, "props": {}}
    return SceneElement(**{**fields, **over})


def refused(status, field):
    return pytest.raises(StudioError, check=lambda e: (e.status, e.field) == (status, field))


def moment(n=1, kind="goal"):
    return KeyMoment(id=f"m-1-k{n}", match_id="m-1", minute=23, kind=kind, team="home", score_home=1,
                     score_away=0, facts=[StatFact(label="xg", value=0.4)])


# --- templates -------------------------------------------------------------------------------

def test_there_are_five_built_in_templates_that_fit_the_canvas():
    templates = builtin_templates()
    assert [t.name for t in templates] == [STARTING_SOON, LIVE_MATCH, ANALYST_DESK, BREAK, FULL_TIME]
    for template in templates:
        assert template.template == template.name and template.elements
        for e in template.elements:
            assert 0 <= e.x and e.x + e.width <= CANVAS_W and 0 <= e.y and e.y + e.height <= CANVAS_H
            assert rules.normalize_element(e) == e, f"{template.name}/{e.type} is not already normal"


def test_a_new_studio_has_one_scene_per_template_with_starting_soon_live():
    doc = default_studio()
    assert [s.template for s in doc.scenes] == [STARTING_SOON, LIVE_MATCH, ANALYST_DESK, BREAK, FULL_TIME]
    assert doc.active_scene_id == scene_id(doc, STARTING_SOON) and doc.revision == 0
    assert len({s.id for s in doc.scenes}) == 5
    assert Studio.model_validate(doc.model_dump()) == doc


# --- scenes ----------------------------------------------------------------------------------

def test_scenes_can_be_made_from_a_template_a_saved_template_or_another_scene():
    doc = default_studio()
    doc = rules.create_scene(doc, "builtin", LIVE_MATCH, name="Second half")
    made = doc.scenes[-1]
    assert (made.name, made.template) == ("Second half", LIVE_MATCH) and len(doc.scenes) == 6
    doc = rules.save_template(doc, made.id, name="My live")
    doc = rules.create_scene(doc, "template", doc.templates[0].id)
    assert (doc.scenes[-1].name, doc.scenes[-1].template) == ("My live", LIVE_MATCH)
    doc = rules.create_scene(doc, "scene", made.id)
    assert doc.scenes[-1].name == "Second half copy"
    assert doc.scenes[-1].elements == made.elements and doc.scenes[-1].id != made.id


def test_creating_from_something_that_does_not_exist_is_refused():
    doc = default_studio()
    for source, ref in (("builtin", "Halftime show"), ("template", "nope"), ("scene", "nope")):
        with refused(404, "ref"):
            rules.create_scene(doc, source, ref)


def test_the_scene_and_template_limits_hold():
    doc = default_studio()
    for _ in range(rules.MAX_SCENES - 5):
        doc = rules.create_scene(doc, "builtin", BREAK)
    with refused(422, "scenes"):
        rules.create_scene(doc, "builtin", BREAK)
    for _ in range(rules.MAX_TEMPLATES):
        doc = rules.save_template(doc, doc.scenes[0].id)
    with refused(422, "templates"):
        rules.save_template(doc, doc.scenes[0].id)


def test_replacing_a_scene_keeps_elements_inside_the_canvas_and_cleans_their_properties():
    doc = default_studio()
    target = doc.scenes[1].id
    elements = [
        element(id="a", x=-50, y=5000, width=10, height=10),
        element(id="b", x=1900, y=0, width=400, height=3000),
        element(id="c", type="narration", props={"lines": 99, "junk": True}),
        element(id="d", type="text", props={"text": "Hi", "size": 5, "align": "diagonal"}),
        element(id="e", type="image", props={"image_id": 7, "fit": "stretch"}),
        element(id="f", type="pitch", props={"pressure": False}),
        element(id="g", type="stats", props={"anything": 1}),
    ]
    doc = rules.replace_scene(doc, target, "  Renamed  ", elements)
    saved = {e.id: e for e in doc.scenes[1].elements}
    assert doc.scenes[1].name == "Renamed" and doc.scenes[1].template == LIVE_MATCH
    assert (saved["a"].x, saved["a"].y, saved["a"].width, saved["a"].height) == (0, CANVAS_H - 40, 40, 40)
    assert (saved["b"].x, saved["b"].width, saved["b"].height, saved["b"].y) == (CANVAS_W - 400, 400, CANVAS_H, 0)
    assert saved["c"].props == {"lines": 6}
    assert saved["d"].props == {"text": "Hi", "size": 12, "align": "center"}
    assert saved["e"].props == {"image_id": None, "fit": "contain"}
    assert saved["f"].props == {"pressure": False} and saved["g"].props == {}


@pytest.mark.parametrize("name, elements, field", [
    ("   ", [], "name"),
    ("x" * 61, [], "name"),
    ("Live", [element(id=f"e{i}") for i in range(41)], "elements"),
    ("Live", [element(id="same"), element(id="same")], "elements"),
    ("Live", [element(type="text", props={"text": "x" * 201})], "props.text"),
], ids=["blank-name", "long-name", "too-many", "duplicate-ids", "long-text"])
def test_a_scene_outside_the_limits_is_refused(name, elements, field):
    doc = default_studio()
    with refused(422, field):
        rules.replace_scene(doc, doc.scenes[0].id, name, elements)


def test_replacing_an_unknown_scene_is_not_found_and_leaves_the_others_alone():
    doc = default_studio()
    with refused(404, "scene"):
        rules.replace_scene(doc, "nope", "Live", [])
    changed = rules.replace_scene(doc, doc.scenes[2].id, "Desk", [])
    assert [s.elements for i, s in enumerate(changed.scenes) if i != 2] == [s.elements for i, s in enumerate(doc.scenes) if i != 2]
    assert doc.scenes[2].elements, "the original document is not mutated"


def test_the_active_scene_and_the_last_scene_cannot_be_deleted():
    doc = default_studio()
    with refused(409, "scene"):
        rules.delete_scene(doc, doc.active_scene_id)
    for scene in doc.scenes[1:]:
        doc = rules.delete_scene(doc, scene.id)
    assert len(doc.scenes) == 1
    with refused(409, "scene"):
        rules.delete_scene(doc, doc.scenes[0].id)
    with refused(404, "scene"):
        rules.delete_scene(doc, "nope")


def test_activating_a_scene_makes_it_the_program():
    doc = default_studio()
    live = scene_id(doc, LIVE_MATCH)
    assert rules.activate_scene(doc, live).active_scene_id == live
    with refused(404, "scene"):
        rules.activate_scene(doc, "nope")


def test_templates_can_be_deleted():
    doc = default_studio()
    doc = rules.save_template(doc, doc.scenes[0].id)
    assert rules.delete_template(doc, doc.templates[0].id).templates == []
    with refused(404, "template"):
        rules.delete_template(doc, "nope")


# --- ticker and settings ---------------------------------------------------------------------

def test_ticker_messages_are_trimmed_and_blank_ones_dropped():
    ticker = Ticker(enabled=True, speed=200, messages=["  Welcome  ", "", "   ", "Subscribe"], show_score=False, show_stats=True)
    saved = rules.set_ticker(default_studio(), ticker).ticker
    assert saved.messages == ["Welcome", "Subscribe"] and (saved.speed, saved.show_score) == (200, False)


def test_settings_are_replaced_whole():
    doc = default_studio()
    settings = doc.settings.model_copy(update={"mode": "analyst", "language": "hi", "auto_banner": False})
    assert rules.set_settings(doc, settings).settings == settings


# --- banner ----------------------------------------------------------------------------------

def test_the_first_banner_shows_at_once_and_later_ones_wait_in_order():
    doc = rules.enqueue_banner(default_studio(), "  First  ", "custom", 8, NOW)
    assert (doc.banner.text, doc.banner.ends_at, doc.banner_queue) == ("First", NOW + 8, [])
    doc = rules.enqueue_banner(doc, "Second", "info", 5, NOW + 1, source_id="n1")
    doc = rules.enqueue_banner(doc, "Third", "custom", 5, NOW + 2)
    assert [b.text for b in doc.banner_queue] == ["Second", "Third"]
    assert doc.banner_queue[0].ends_at is None and doc.banner_queue[0].source_id == "n1"


def test_goals_jump_the_queue_but_keep_their_own_order():
    doc = rules.enqueue_banner(default_studio(), "On screen", "custom", 8, NOW)
    for text, kind in (("info 1", "info"), ("goal 1", "goal"), ("info 2", "info"), ("goal 2", "goal")):
        doc = rules.enqueue_banner(doc, text, kind, 8, NOW)
    assert [b.text for b in doc.banner_queue] == ["goal 1", "goal 2", "info 1", "info 2"]


def test_a_full_queue_drops_its_oldest_message_that_is_not_a_goal():
    doc = rules.enqueue_banner(default_studio(), "On screen", "custom", 8, NOW)
    doc = rules.enqueue_banner(doc, "goal", "goal", 8, NOW)
    for n in range(rules.MAX_QUEUE - 1):
        doc = rules.enqueue_banner(doc, f"info {n}", "info", 8, NOW)
    assert len(doc.banner_queue) == rules.MAX_QUEUE
    doc = rules.enqueue_banner(doc, "newest", "info", 8, NOW)
    texts = [b.text for b in doc.banner_queue]
    assert len(texts) == rules.MAX_QUEUE and texts[0] == "goal" and "info 0" not in texts and texts[-1] == "newest"


def test_clearing_the_banner_shows_the_next_one_or_nothing():
    doc = rules.enqueue_banner(default_studio(), "First", "custom", 8, NOW)
    doc = rules.enqueue_banner(doc, "Second", "custom", 5, NOW)
    doc = rules.clear_banner(doc, NOW + 3)
    assert (doc.banner.text, doc.banner.ends_at, doc.banner_queue) == ("Second", NOW + 8, [])
    assert rules.clear_banner(doc, NOW + 4).banner is None
    assert rules.clear_banner(default_studio(), NOW).banner is None


@pytest.mark.parametrize("text, duration, field", [("   ", 8, "text"), ("x" * 201, 8, "text"), ("ok", 2, "duration_s"), ("ok", 31, "duration_s")])
def test_banners_outside_the_limits_are_refused(text, duration, field):
    with refused(422, field):
        rules.enqueue_banner(default_studio(), text, "custom", duration, NOW)


# --- countdown and breaks --------------------------------------------------------------------

def test_a_start_countdown_cuts_to_starting_soon():
    doc = default_studio()
    doc = rules.activate_scene(doc, scene_id(doc, FULL_TIME))
    doc = rules.start_countdown(doc, NOW + 600, NOW, label="Kick-off")
    assert (doc.countdown.kind, doc.countdown.ends_at, doc.countdown.label) == ("start", NOW + 600, "Kick-off")
    assert doc.active_scene_id == scene_id(doc, STARTING_SOON)


@pytest.mark.parametrize("starts_at", [NOW, NOW - 5, NOW + 24 * 3600 + 1])
def test_a_start_time_in_the_past_or_too_far_ahead_is_refused(starts_at):
    with refused(422, "starts_at"):
        rules.start_countdown(default_studio(), starts_at, NOW)


def test_a_break_remembers_the_scene_and_returns_to_it():
    doc = default_studio()
    live = scene_id(doc, LIVE_MATCH)
    doc = rules.start_break(rules.activate_scene(doc, live), 5, NOW)
    assert (doc.active_scene_id, doc.previous_scene_id) == (scene_id(doc, BREAK), live)
    assert (doc.countdown.kind, doc.countdown.ends_at) == ("break", NOW + 300)
    ended = rules.end_countdown(doc)
    assert (ended.active_scene_id, ended.previous_scene_id, ended.countdown) == (live, None, None)


def test_a_break_started_during_a_break_keeps_the_first_scene_remembered():
    doc = default_studio()
    live = scene_id(doc, LIVE_MATCH)
    doc = rules.start_break(rules.activate_scene(doc, live), 5, NOW)
    doc = rules.start_break(doc, 10, NOW + 60)
    assert doc.previous_scene_id == live and doc.countdown.ends_at == NOW + 60 + 600


@pytest.mark.parametrize("minutes", [0, -1, 61])
def test_a_break_outside_one_to_sixty_minutes_is_refused(minutes):
    with refused(422, "minutes"):
        rules.start_break(default_studio(), minutes, NOW)


def test_switching_scenes_by_hand_during_a_break_means_the_break_ends_where_the_streamer_is():
    doc = default_studio()
    live, desk = scene_id(doc, LIVE_MATCH), scene_id(doc, ANALYST_DESK)
    doc = rules.start_break(rules.activate_scene(doc, live), 5, NOW)
    doc = rules.activate_scene(doc, desk)
    ended, _ = rules.expire(doc, NOW + 301)
    assert (ended.active_scene_id, ended.countdown) == (desk, None)


def test_deleting_the_remembered_scene_during_a_break_leaves_the_break_scene_up_afterwards():
    doc = default_studio()
    live = scene_id(doc, LIVE_MATCH)
    doc = rules.start_break(rules.activate_scene(doc, live), 5, NOW)
    doc = rules.delete_scene(doc, live)
    ended, _ = rules.expire(doc, NOW + 301)
    assert ended.active_scene_id == scene_id(doc, BREAK) and ended.countdown is None
    assert ended.active_scene_id in {s.id for s in ended.scenes}


def test_cancelling_a_start_countdown_stays_on_the_current_scene():
    doc = rules.start_countdown(default_studio(), NOW + 600, NOW)
    cancelled = rules.end_countdown(doc)
    assert cancelled.countdown is None and cancelled.active_scene_id == doc.active_scene_id
    untouched = default_studio()
    assert rules.end_countdown(untouched) is untouched, "ending nothing changes nothing"


# --- replay ----------------------------------------------------------------------------------

def test_a_replay_runs_for_eight_seconds_and_a_new_one_replaces_it():
    doc = rules.start_replay(default_studio(), moment(1), NOW)
    assert (doc.replay.match_id, doc.replay.moment_id, doc.replay.minute) == ("m-1", "m-1-k1", 23)
    assert (doc.replay.started_at, doc.replay.duration_s) == (NOW, rules.REPLAY_SECONDS)
    again = rules.start_replay(doc, moment(2), NOW + 3)
    assert (again.replay.moment_id, again.replay.started_at) == ("m-1-k2", NOW + 3)
    assert rules.stop_replay(again).replay is None


# --- deadlines -------------------------------------------------------------------------------

def test_the_next_deadline_is_the_earliest_of_banner_countdown_and_replay():
    doc = default_studio()
    assert rules.next_deadline(doc) is None
    doc = rules.start_countdown(doc, NOW + 600, NOW)
    doc = rules.enqueue_banner(doc, "Hi", "custom", 8, NOW)
    assert rules.next_deadline(doc) == NOW + 8
    doc = rules.start_replay(doc, moment(), NOW - 5)
    assert rules.next_deadline(doc) == NOW + 3


def test_nothing_expires_before_its_time():
    doc = rules.enqueue_banner(rules.start_break(default_studio(), 5, NOW), "Hi", "custom", 8, NOW)
    same, actions = rules.expire(doc, NOW + 7.9)
    assert same is doc and actions == []


def test_an_expired_banner_gives_way_to_the_next_and_the_last_one_leaves_the_screen_clear():
    doc = rules.enqueue_banner(default_studio(), "First", "custom", 8, NOW)
    doc = rules.enqueue_banner(doc, "Second", "custom", 5, NOW)
    doc, _ = rules.expire(doc, NOW + 8)
    assert (doc.banner.text, doc.banner.ends_at) == ("Second", NOW + 13)
    doc, _ = rules.expire(doc, NOW + 13)
    assert doc.banner is None and doc.banner_queue == []


def test_a_finished_replay_is_cleared():
    doc, _ = rules.expire(rules.start_replay(default_studio(), moment(), NOW), NOW + rules.REPLAY_SECONDS)
    assert doc.replay is None


def test_when_the_start_countdown_ends_the_match_starts_and_the_program_cuts_to_live():
    doc = rules.start_countdown(default_studio(), NOW + 600, NOW)
    ended, actions = rules.expire(doc, NOW + 600)
    assert actions == ["start_match"] and ended.countdown is None
    assert ended.active_scene_id == scene_id(ended, LIVE_MATCH)


def test_with_automatic_start_off_the_countdown_just_ends():
    doc = default_studio()
    doc = rules.set_settings(doc, doc.settings.model_copy(update={"auto_start": False}))
    doc = rules.start_countdown(doc, NOW + 600, NOW)
    ended, actions = rules.expire(doc, NOW + 600)
    assert actions == [] and ended.countdown is None and ended.active_scene_id == doc.active_scene_id


def test_everything_overdue_is_settled_in_one_pass():
    doc = rules.start_countdown(default_studio(), NOW + 60, NOW)
    doc = rules.enqueue_banner(doc, "Stale", "custom", 8, NOW)
    doc = rules.start_replay(doc, moment(), NOW)
    ended, actions = rules.expire(doc, NOW + 5000)
    assert (ended.banner, ended.replay, ended.countdown, actions) == (None, None, None, ["start_match"])


# --- loading and uploads ---------------------------------------------------------------------

def test_elements_of_an_unknown_type_are_dropped_from_a_loaded_file():
    raw = default_studio().model_dump()
    raw["scenes"][0]["elements"].append({**raw["scenes"][0]["elements"][0], "id": "zz", "type": "webcam"})
    raw["templates"] = [{"id": "t1", "name": "Old", "elements": [{"id": "q", "type": "hologram"}]}]
    cleaned = Studio.model_validate(rules.sanitize_raw(raw))
    assert "zz" not in {e.id for e in cleaned.scenes[0].elements}
    assert cleaned.templates[0].elements == []
    assert len(cleaned.scenes[0].elements) == len(default_studio().scenes[0].elements)


@pytest.mark.parametrize("content, expected", [
    (b"\x89PNG\r\n\x1a\n" + b"\x00" * 20, "image/png"),
    (b"\xff\xd8\xff\xe0" + b"\x00" * 20, "image/jpeg"),
    (b"RIFF\x24\x00\x00\x00WEBPVP8 ", "image/webp"),
    (b"<svg xmlns='http://www.w3.org/2000/svg'/>", None),
    (b"GIF89a" + b"\x00" * 20, None),
    (b"just some text", None),
    (b"RIFF\x24\x00\x00\x00WAVEfmt ", None),
    (b"", None),
], ids=["png", "jpeg", "webp", "svg", "gif", "text", "wav", "empty"])
def test_an_image_is_recognised_by_its_content_not_its_name(content, expected):
    assert rules.sniff_image(content) == expected
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_studio_rules.py -q`
Expected: collection error, `ModuleNotFoundError: No module named 'kickstream.studio'`.

- [ ] **Step 3: Write the templates**

`services/pipeline/kickstream/studio/templates.py`:

```python
"""The built-in scene templates and the studio a new installation starts with."""

from kickstream.contracts import Scene, SceneElement, Studio, StudioSettings, Ticker

CANVAS_W = 1920
CANVAS_H = 1080

STARTING_SOON = "Starting soon"
LIVE_MATCH = "Live match"
ANALYST_DESK = "Analyst desk"
BREAK = "Break"
FULL_TIME = "Full-time"


def _el(layer: int, type_: str, x: int, y: int, width: int, height: int, **props) -> SceneElement:
    return SceneElement(id=f"e{layer}", type=type_, x=x, y=y, width=width, height=height, layer=layer,
                        visible=True, props=props)


def _title(layer: int, text: str, y: int, size: int) -> SceneElement:
    return _el(layer, "text", 360, y, 1200, 160, text=text, size=size, align="center")


def builtin_templates() -> list[Scene]:
    layouts = {
        STARTING_SOON: [
            _title(1, "Kick-off soon", 160, 96),
            _el(2, "countdown", 660, 380, 600, 260),
            _title(3, "Northbridge FC vs Harbour City", 700, 56),
            _el(4, "ticker", 0, 1000, 1920, 80),
        ],
        LIVE_MATCH: [
            _el(1, "scoreboard", 40, 40, 1100, 120),
            _el(2, "pitch", 40, 180, 1100, 700, pressure=True),
            _el(3, "narration", 1180, 40, 700, 620, lines=4),
            _el(4, "banner", 1180, 680, 700, 200),
            _el(5, "ticker", 0, 1000, 1920, 80),
        ],
        ANALYST_DESK: [
            _el(1, "scoreboard", 40, 40, 900, 120),
            _el(2, "stats", 40, 180, 900, 420),
            _el(3, "timeline", 40, 620, 900, 140),
            _el(4, "narration", 980, 40, 900, 420, lines=4),
            _el(5, "pitch", 980, 480, 900, 560, pressure=True),
            _el(6, "banner", 40, 780, 900, 180),
        ],
        BREAK: [
            _title(1, "Back soon", 100, 96),
            _el(2, "countdown", 660, 280, 600, 220),
            _el(3, "recap", 460, 520, 1000, 440),
            _el(4, "ticker", 0, 1000, 1920, 80),
        ],
        FULL_TIME: [
            _el(1, "scoreboard", 400, 40, 1120, 120),
            _el(2, "recap", 160, 200, 800, 560),
            _el(3, "stats", 1000, 200, 760, 560),
            _el(4, "banner", 400, 800, 1120, 180),
        ],
    }
    return [
        Scene(id=f"builtin-{name.lower().replace(' ', '-')}", name=name, template=name, elements=elements)
        for name, elements in layouts.items()
    ]


def default_studio() -> Studio:
    scenes = [template.model_copy(update={"id": f"scene-{n}"}) for n, template in enumerate(builtin_templates(), 1)]
    return Studio(
        revision=0, server_time=0.0, scenes=scenes, active_scene_id=scenes[0].id, templates=[],
        settings=StudioSettings(mode="fan", language="en", auto_banner=True, auto_start=True,
                                auto_half_time_break=False),
        banner_queue=[],
        ticker=Ticker(enabled=True, speed=120, messages=[], show_score=True, show_stats=True),
    )
```

- [ ] **Step 4: Write the rules**

`services/pipeline/kickstream/studio/rules.py`:

```python
"""Every rule for changing the studio document.

Each rule takes a document and returns a new one; none mutates its argument. Time is passed
in, so the rules can be tested without a clock. A broken limit raises `StudioError`.
"""

import typing
import uuid

from kickstream.contracts import Banner, Countdown, KeyMoment, Replay, Scene, SceneElement, Studio, StudioSettings, Ticker
from kickstream.studio.templates import BREAK, CANVAS_H, CANVAS_W, LIVE_MATCH, STARTING_SOON, builtin_templates

MAX_SCENES = 20
MAX_TEMPLATES = 20
MAX_ELEMENTS = 40
MAX_QUEUE = 10
MIN_SIZE = 40
MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_START_AHEAD_S = 24 * 3600
REPLAY_SECONDS = 8.0
HALF_TIME_BREAK_MINUTES = 2
ELEMENT_TYPES = frozenset(typing.get_args(SceneElement.model_fields["type"].annotation))


class StudioError(Exception):
    """A change the studio refuses. `status` is the HTTP status it maps to."""

    def __init__(self, status: int, field: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.field = field
        self.message = message


def new_id() -> str:
    return uuid.uuid4().hex[:8]


def _with(doc: Studio, **changes) -> Studio:
    return doc.model_copy(update=changes)


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


# --- elements ----------------------------------------------------------------------------------

def _int_prop(props: dict, key: str, default: int, low: int, high: int) -> int:
    value = props.get(key, default)
    return _clamp(value, low, high) if isinstance(value, int) and not isinstance(value, bool) else default


def _choice_prop(props: dict, key: str, default: str, choices: tuple[str, ...]) -> str:
    value = props.get(key, default)
    return value if value in choices else default


def _normalize_props(type_: str, props: dict) -> dict:
    """Keep only the properties this element type uses, each within its range."""
    if type_ == "pitch":
        return {"pressure": props.get("pressure", True) is not False}
    if type_ == "narration":
        return {"lines": _int_prop(props, "lines", 3, 1, 6)}
    if type_ == "text":
        text = props.get("text", "")
        text = text if isinstance(text, str) else ""
        if len(text) > 200:
            raise StudioError(422, "props.text", "Text can be at most 200 characters.")
        return {"text": text, "size": _int_prop(props, "size", 48, 12, 200),
                "align": _choice_prop(props, "align", "center", ("left", "center", "right"))}
    if type_ == "image":
        image_id = props.get("image_id")
        return {"image_id": image_id if isinstance(image_id, str) else None,
                "fit": _choice_prop(props, "fit", "contain", ("contain", "cover"))}
    return {}


def normalize_element(element: SceneElement) -> SceneElement:
    width = _clamp(element.width, MIN_SIZE, CANVAS_W)
    height = _clamp(element.height, MIN_SIZE, CANVAS_H)
    return element.model_copy(update={
        "width": width, "height": height,
        "x": _clamp(element.x, 0, CANVAS_W - width), "y": _clamp(element.y, 0, CANVAS_H - height),
        "props": _normalize_props(element.type, element.props),
    })


# --- scenes and templates ----------------------------------------------------------------------

def _find(scenes: list[Scene], scene_id: str, field: str) -> Scene:
    for scene in scenes:
        if scene.id == scene_id:
            return scene
    raise StudioError(404, field, f"There is no {field} with the ID {scene_id}.")


def _first_from(doc: Studio, template: str) -> str | None:
    return next((scene.id for scene in doc.scenes if scene.template == template), None)


def _checked_name(name: str) -> str:
    name = name.strip()
    if not 1 <= len(name) <= 60:
        raise StudioError(422, "name", "A scene name must be 1 to 60 characters.")
    return name


def create_scene(doc: Studio, source: str, ref: str, name: str | None = None) -> Studio:
    if len(doc.scenes) >= MAX_SCENES:
        raise StudioError(422, "scenes", f"A studio can hold at most {MAX_SCENES} scenes.")
    if source == "builtin":
        origin = next((template for template in builtin_templates() if template.name == ref), None)
    elif source == "template":
        origin = next((template for template in doc.templates if template.id == ref), None)
    else:
        origin = next((scene for scene in doc.scenes if scene.id == ref), None)
    if origin is None:
        raise StudioError(404, "ref", f"There is no {source} called {ref}.")
    default_name = f"{origin.name} copy"[:60] if source == "scene" else origin.name
    scene = Scene(id=new_id(), name=_checked_name(name or default_name), template=origin.template,
                  elements=list(origin.elements))
    return _with(doc, scenes=[*doc.scenes, scene])


def replace_scene(doc: Studio, scene_id: str, name: str, elements: list[SceneElement]) -> Studio:
    current = _find(doc.scenes, scene_id, "scene")
    if len(elements) > MAX_ELEMENTS:
        raise StudioError(422, "elements", f"A scene can hold at most {MAX_ELEMENTS} elements.")
    if len({element.id for element in elements}) != len(elements):
        raise StudioError(422, "elements", "Element IDs must be unique within a scene.")
    updated = current.model_copy(update={
        "name": _checked_name(name), "elements": [normalize_element(element) for element in elements]})
    return _with(doc, scenes=[updated if scene.id == scene_id else scene for scene in doc.scenes])


def delete_scene(doc: Studio, scene_id: str) -> Studio:
    _find(doc.scenes, scene_id, "scene")
    if scene_id == doc.active_scene_id:
        raise StudioError(409, "scene", "The scene on the program cannot be deleted. Switch scenes first.")
    if len(doc.scenes) == 1:
        raise StudioError(409, "scene", "The last scene cannot be deleted.")
    previous = None if doc.previous_scene_id == scene_id else doc.previous_scene_id
    return _with(doc, scenes=[scene for scene in doc.scenes if scene.id != scene_id], previous_scene_id=previous)


def activate_scene(doc: Studio, scene_id: str) -> Studio:
    _find(doc.scenes, scene_id, "scene")
    # A scene chosen by hand is where the streamer wants to be, so a running break no longer
    # returns anywhere when it ends.
    return _with(doc, active_scene_id=scene_id, previous_scene_id=None)


def save_template(doc: Studio, scene_id: str, name: str | None = None) -> Studio:
    scene = _find(doc.scenes, scene_id, "scene")
    if len(doc.templates) >= MAX_TEMPLATES:
        raise StudioError(422, "templates", f"A studio can hold at most {MAX_TEMPLATES} saved templates.")
    template = scene.model_copy(update={"id": new_id(), "name": _checked_name(name or scene.name)})
    return _with(doc, templates=[*doc.templates, template])


def delete_template(doc: Studio, template_id: str) -> Studio:
    _find(doc.templates, template_id, "template")
    return _with(doc, templates=[template for template in doc.templates if template.id != template_id])


# --- settings and ticker -----------------------------------------------------------------------

def set_settings(doc: Studio, settings: StudioSettings) -> Studio:
    return _with(doc, settings=settings)


def set_ticker(doc: Studio, ticker: Ticker) -> Studio:
    messages = [message.strip() for message in ticker.messages if message.strip()]
    return _with(doc, ticker=ticker.model_copy(update={"messages": messages}))


# --- banner ------------------------------------------------------------------------------------

def enqueue_banner(doc: Studio, text: str, kind: str, duration_s: int, now: float,
                   source_id: str | None = None) -> Studio:
    text = text.strip()
    if not 1 <= len(text) <= 200:
        raise StudioError(422, "text", "A banner needs 1 to 200 characters of text.")
    if not 3 <= duration_s <= 30:
        raise StudioError(422, "duration_s", "A banner stays up for 3 to 30 seconds.")
    banner = Banner(id=new_id(), text=text, kind=kind, duration_s=duration_s, source_id=source_id)
    if doc.banner is None:
        return _with(doc, banner=banner.model_copy(update={"ends_at": now + duration_s}))
    queue = list(doc.banner_queue)
    if len(queue) >= MAX_QUEUE:
        queue.pop(next((index for index, waiting in enumerate(queue) if waiting.kind != "goal"), 0))
    # Goals go ahead of everything else that is waiting, behind any goals already waiting.
    position = sum(waiting.kind == "goal" for waiting in queue) if kind == "goal" else len(queue)
    queue.insert(position, banner)
    return _with(doc, banner_queue=queue)


def clear_banner(doc: Studio, now: float) -> Studio:
    if not doc.banner_queue:
        return _with(doc, banner=None)
    following, *rest = doc.banner_queue
    return _with(doc, banner=following.model_copy(update={"ends_at": now + following.duration_s}), banner_queue=rest)


# --- countdown and breaks ----------------------------------------------------------------------

def start_countdown(doc: Studio, starts_at: float, now: float, label: str = "") -> Studio:
    if not now < starts_at <= now + MAX_START_AHEAD_S:
        raise StudioError(422, "starts_at", "The start time must be in the future and within 24 hours.")
    return _with(doc, countdown=Countdown(kind="start", ends_at=starts_at, label=label[:60]),
                 previous_scene_id=None, active_scene_id=_first_from(doc, STARTING_SOON) or doc.active_scene_id)


def start_break(doc: Studio, minutes: int, now: float, label: str = "") -> Studio:
    if not 1 <= minutes <= 60:
        raise StudioError(422, "minutes", "A break lasts 1 to 60 minutes.")
    on_break = doc.countdown is not None and doc.countdown.kind == "break"
    return _with(doc, countdown=Countdown(kind="break", ends_at=now + minutes * 60, label=label[:60]),
                 previous_scene_id=doc.previous_scene_id if on_break else doc.active_scene_id,
                 active_scene_id=_first_from(doc, BREAK) or doc.active_scene_id)


def _back_from_break(doc: Studio) -> Studio:
    remembered = doc.previous_scene_id
    still_there = remembered is not None and any(scene.id == remembered for scene in doc.scenes)
    return _with(doc, countdown=None, previous_scene_id=None,
                 active_scene_id=remembered if still_there else doc.active_scene_id)


def end_countdown(doc: Studio) -> Studio:
    if doc.countdown is None:
        return doc
    return _back_from_break(doc) if doc.countdown.kind == "break" else _with(doc, countdown=None)


# --- replay ------------------------------------------------------------------------------------

def start_replay(doc: Studio, moment: KeyMoment, now: float) -> Studio:
    return _with(doc, replay=Replay(match_id=moment.match_id, moment_id=moment.id, minute=moment.minute,
                                    started_at=now, duration_s=REPLAY_SECONDS))


def stop_replay(doc: Studio) -> Studio:
    return _with(doc, replay=None)


# --- deadlines ---------------------------------------------------------------------------------

def next_deadline(doc: Studio) -> float | None:
    times = []
    if doc.banner is not None and doc.banner.ends_at is not None:
        times.append(doc.banner.ends_at)
    if doc.countdown is not None:
        times.append(doc.countdown.ends_at)
    if doc.replay is not None:
        times.append(doc.replay.started_at + doc.replay.duration_s)
    return min(times) if times else None


def expire(doc: Studio, now: float) -> tuple[Studio, list[str]]:
    """Settle everything whose time has come. Returns the same object when nothing was due."""
    actions: list[str] = []
    while doc.banner is not None and doc.banner.ends_at is not None and doc.banner.ends_at <= now:
        doc = clear_banner(doc, now)
    if doc.replay is not None and doc.replay.started_at + doc.replay.duration_s <= now:
        doc = stop_replay(doc)
    if doc.countdown is not None and doc.countdown.ends_at <= now:
        if doc.countdown.kind == "break":
            doc = _back_from_break(doc)
        else:
            doc = _with(doc, countdown=None)
            if doc.settings.auto_start:
                actions.append("start_match")
                doc = _with(doc, active_scene_id=_first_from(doc, LIVE_MATCH) or doc.active_scene_id)
    return doc, actions


# --- loading and uploads -----------------------------------------------------------------------

def sanitize_raw(raw: dict) -> dict:
    """Drop elements of a type this version does not know, so a file from another version loads."""

    def clean(scene: dict) -> dict:
        elements = [element for element in scene.get("elements", []) if element.get("type") in ELEMENT_TYPES]
        return {**scene, "elements": elements}

    return {**raw, "scenes": [clean(scene) for scene in raw.get("scenes", [])],
            "templates": [clean(scene) for scene in raw.get("templates", [])]}


def sniff_image(content: bytes) -> str | None:
    """The media type of an upload, judged by its first bytes. None for anything not allowed."""
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp"
    return None
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_studio_rules.py -q`
Expected: all pass (60 with parametrised cases).

- [ ] **Step 6: Commit**

```bash
git add services/pipeline/kickstream/studio services/pipeline/tests/test_studio_rules.py
git commit -m "feat: add studio rules and built-in scene templates"
```

---

### Task 3: Studio and image stores

**Files:**
- Create: `services/pipeline/kickstream/ports/studio_store.py`, `services/pipeline/kickstream/ports/image_store.py`
- Create: `services/pipeline/kickstream/adapters/json_studio_store.py`, `services/pipeline/kickstream/adapters/dir_image_store.py`
- Modify: `.gitignore` (add `.data/`)
- Test: `services/pipeline/tests/test_studio_stores.py`

**Interfaces:**
- Consumes: `Studio`; `studio.rules.sanitize_raw` is NOT used here (adapters do not import stages) — the store takes a `sanitize` function.
- Produces:
  - `ports.studio_store.StudioStore` with `load() -> Studio | None` and `save(studio: Studio) -> None` (raises `OSError` when the write fails).
  - `ports.image_store.ImageStore` with `save(content: bytes, media_type: str) -> str` (returns the image ID; raises `ImageStoreFull` at the limit) and `get(image_id: str) -> tuple[bytes, str] | None`; `ports.image_store.ImageStoreFull(Exception)`.
  - `adapters.json_studio_store.JsonStudioStore(path: Path, sanitize: Callable[[dict], dict] = lambda raw: raw)`. A file that cannot be read as a studio is moved to `<name>.corrupt` and `load()` returns `None`.
  - `adapters.dir_image_store.DirImageStore(directory: Path, max_images: int = 50)`. IDs look like `<32 hex>.<png|jpg|webp>`; `get` returns `None` for anything else.

- [ ] **Step 1: Write the failing tests**

`services/pipeline/tests/test_studio_stores.py`:

```python
import json

import pytest

from kickstream.adapters.dir_image_store import DirImageStore
from kickstream.adapters.json_studio_store import JsonStudioStore
from kickstream.ports.image_store import ImageStoreFull
from kickstream.studio import rules
from kickstream.studio.templates import default_studio

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def test_a_saved_studio_is_loaded_back(tmp_path):
    store = JsonStudioStore(tmp_path / "data" / "studio.json")
    assert store.load() is None, "nothing saved yet"
    doc = rules.enqueue_banner(default_studio(), "गोल!", "goal", 8, 1000.0)
    store.save(doc)
    assert JsonStudioStore(tmp_path / "data" / "studio.json").load() == doc
    assert [p.name for p in (tmp_path / "data").iterdir()] == ["studio.json"], "no temporary file is left behind"


@pytest.mark.parametrize("content", ["{not json", "[1, 2, 3]", '{"revision": "soon"}', ""],
                         ids=["malformed", "not-an-object", "wrong-shape", "empty"])
def test_an_unreadable_file_is_set_aside_and_the_studio_starts_fresh(tmp_path, content):
    path = tmp_path / "studio.json"
    path.write_text(content, encoding="utf-8")
    store = JsonStudioStore(path)
    assert store.load() is None
    assert not path.exists()
    assert (tmp_path / "studio.json.corrupt").read_text(encoding="utf-8") == content
    store.save(default_studio())
    assert store.load() == default_studio()


def test_a_second_corrupt_file_replaces_the_one_set_aside_earlier(tmp_path):
    path = tmp_path / "studio.json"
    for content in ("first", "second"):
        path.write_text(content, encoding="utf-8")
        assert JsonStudioStore(path).load() is None
    assert (tmp_path / "studio.json.corrupt").read_text(encoding="utf-8") == "second"


def test_the_sanitizer_runs_before_validation(tmp_path):
    path = tmp_path / "studio.json"
    raw = default_studio().model_dump()
    raw["scenes"][0]["elements"].append({**raw["scenes"][0]["elements"][0], "id": "zz", "type": "webcam"})
    path.write_text(json.dumps(raw), encoding="utf-8")
    assert JsonStudioStore(path).load() is None, "without a sanitizer the unknown element makes the file unreadable"
    path.write_text(json.dumps(raw), encoding="utf-8")
    loaded = JsonStudioStore(path, sanitize=rules.sanitize_raw).load()
    assert loaded == default_studio()


def test_a_failed_save_raises_and_leaves_the_previous_file(tmp_path):
    path = tmp_path / "studio.json"
    store = JsonStudioStore(path)
    store.save(default_studio())
    blocker = tmp_path / "studio.tmp"
    blocker.mkdir()
    with pytest.raises(OSError):
        store.save(rules.enqueue_banner(default_studio(), "x", "custom", 8, 1.0))
    blocker.rmdir()
    assert store.load() == default_studio()


def test_images_are_saved_under_generated_ids_and_fetched_with_their_type(tmp_path):
    store = DirImageStore(tmp_path / "images")
    png = store.save(PNG, "image/png")
    jpg = store.save(b"\xff\xd8\xff" + b"\x01" * 8, "image/jpeg")
    webp = store.save(b"RIFF\x00\x00\x00\x00WEBP", "image/webp")
    assert png.endswith(".png") and jpg.endswith(".jpg") and webp.endswith(".webp") and len({png, jpg, webp}) == 3
    assert store.get(png) == (PNG, "image/png")
    assert store.get(jpg)[1] == "image/jpeg" and store.get(webp)[1] == "image/webp"


def test_an_unsupported_media_type_is_refused(tmp_path):
    with pytest.raises(ValueError):
        DirImageStore(tmp_path).save(b"<svg/>", "image/svg+xml")


@pytest.mark.parametrize("image_id", [
    "../studio.json", "..\\studio.json", "/etc/passwd", "secret.png", "a" * 32 + ".gif", "a" * 31 + ".png",
    "A" * 32 + ".png", "a" * 32 + ".png/../../x", "", "a" * 32 + ".png\x00",
])
def test_only_well_formed_ids_can_be_read(tmp_path, image_id):
    (tmp_path / "studio.json").write_text("{}", encoding="utf-8")
    (tmp_path / "images").mkdir()
    (tmp_path / "images" / "secret.png").write_bytes(PNG)
    assert DirImageStore(tmp_path / "images").get(image_id) is None


def test_a_well_formed_id_that_was_never_saved_is_not_found(tmp_path):
    assert DirImageStore(tmp_path).get("0" * 32 + ".png") is None


def test_the_store_refuses_images_past_its_limit(tmp_path):
    store = DirImageStore(tmp_path, max_images=2)
    store.save(PNG, "image/png")
    store.save(PNG, "image/png")
    with pytest.raises(ImageStoreFull):
        store.save(PNG, "image/png")
    assert len(list(tmp_path.iterdir())) == 2
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_studio_stores.py -q`
Expected: collection error, `ModuleNotFoundError: No module named 'kickstream.adapters.dir_image_store'`.

- [ ] **Step 3: Write the ports**

`services/pipeline/kickstream/ports/studio_store.py`:

```python
from typing import Protocol

from kickstream.contracts import Studio


class StudioStore(Protocol):
    def load(self) -> Studio | None:
        """The saved studio, or None when there is none to use."""

    def save(self, studio: Studio) -> None:
        """Persist the studio. Raises OSError when it could not be written."""
```

`services/pipeline/kickstream/ports/image_store.py`:

```python
from typing import Protocol


class ImageStoreFull(Exception):
    """The store already holds as many images as it allows."""


class ImageStore(Protocol):
    def save(self, content: bytes, media_type: str) -> str:
        """Store an image and return its ID. Raises ImageStoreFull at the limit."""

    def get(self, image_id: str) -> tuple[bytes, str] | None:
        """The image's bytes and media type, or None when there is no such image."""
```

- [ ] **Step 4: Write the adapters**

`services/pipeline/kickstream/adapters/json_studio_store.py`:

```python
import json
import logging
from collections.abc import Callable
from pathlib import Path

from pydantic import ValidationError

from kickstream.contracts import Studio

log = logging.getLogger(__name__)


class JsonStudioStore:
    """The studio document as one JSON file, replaced atomically on every save."""

    def __init__(self, path: Path, sanitize: Callable[[dict], dict] = lambda raw: raw) -> None:
        self._path = Path(path)
        self._sanitize = sanitize

    def load(self) -> Studio | None:
        if not self._path.exists():
            return None
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raise ValueError("the studio file does not hold an object")
            return Studio.model_validate(self._sanitize(raw))
        except (OSError, ValueError, ValidationError, AttributeError, TypeError) as exc:
            aside = self._path.with_name(self._path.name + ".corrupt")
            log.warning("studio file %s is unreadable (%s); moved to %s", self._path, type(exc).__name__, aside)
            self._path.replace(aside)
            return None

    def save(self, studio: Studio) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(".tmp")
        temporary.write_text(studio.model_dump_json(), encoding="utf-8")
        temporary.replace(self._path)
```

`services/pipeline/kickstream/adapters/dir_image_store.py`:

```python
import re
import uuid
from pathlib import Path

from kickstream.ports.image_store import ImageStoreFull

_EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
_MEDIA_TYPES = {extension: media_type for media_type, extension in _EXTENSIONS.items()}
# IDs are generated here and nothing else is ever read, so a request cannot name another file.
_ID = re.compile(r"[0-9a-f]{32}\.(png|jpg|webp)")


class DirImageStore:
    def __init__(self, directory: Path, max_images: int = 50) -> None:
        self._directory = Path(directory)
        self._max_images = max_images

    def save(self, content: bytes, media_type: str) -> str:
        if media_type not in _EXTENSIONS:
            raise ValueError(f"unsupported media type {media_type}")
        self._directory.mkdir(parents=True, exist_ok=True)
        if sum(1 for _ in self._directory.iterdir()) >= self._max_images:
            raise ImageStoreFull
        image_id = f"{uuid.uuid4().hex}.{_EXTENSIONS[media_type]}"
        (self._directory / image_id).write_bytes(content)
        return image_id

    def get(self, image_id: str) -> tuple[bytes, str] | None:
        match = _ID.fullmatch(image_id)
        if match is None:
            return None
        try:
            return (self._directory / image_id).read_bytes(), _MEDIA_TYPES[match.group(1)]
        except OSError:
            return None
```

Append to `.gitignore`:

```
.data/
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_studio_stores.py tests/test_architecture.py -q`
Expected: all pass. `test_architecture.py` confirms the adapters still import no stage.

- [ ] **Step 6: Commit**

```bash
git add .gitignore services/pipeline/kickstream/ports services/pipeline/kickstream/adapters services/pipeline/tests/test_studio_stores.py
git commit -m "feat: add studio document and image stores"
```

---

### Task 4: Studio service and stage

**Files:**
- Create: `services/pipeline/kickstream/studio/service.py`, `services/pipeline/kickstream/studio/stage.py`
- Test: `services/pipeline/tests/test_studio_service.py`

**Interfaces:**
- Consumes: `studio.rules`, `studio.templates.default_studio`, `ports.studio_store.StudioStore`, `ports.image_store.ImageStore, ImageStoreFull`, `ports.bus.STATUS, INSIGHTS, NARRATIVES, EventBus`, contracts `KeyMoment, MatchStatus, Narrative, Studio`.
- Produces:
  - `studio.service.StudioService(store: StudioStore, images: ImageStore, *, now: Callable[[], float] = time.time, start_match: Callable[[], Awaitable[str]], find_moment: Callable[[str, str], KeyMoment | None])`. The constructor loads the saved document or starts from `default_studio()`.
    - `doc: Studio` (property; a copy stamped with `server_time = now()`), `settings` (property), `now() -> float`
    - `async apply(change: Callable[[Studio], Studio]) -> Studio`: runs one rule under a lock, bumps `revision`, validates the result against the schema, saves, notifies. A rule that returns its argument unchanged changes nothing. Raises `StudioError` (422 from a rule or the schema, 503 when the save fails) and leaves the document as it was.
    - `async banner(text, kind, duration_s, source_id=None)`, `async take_break(minutes, label="")`, `async countdown(starts_at, label="")`, `async replay(match_id, moment_id)` (404 `StudioError` for an unknown moment)
    - `upload(content: bytes) -> str`, `image(image_id: str) -> tuple[bytes, str] | None`
    - `async tick() -> None`: settles everything due at `now()`, then starts a match if a start countdown ended with automatic start on.
    - `async run() -> None`: calls `tick()` at each deadline and after each change, forever.
    - `changes() -> AsyncIterator[Studio]`: the current document, then the latest document after each change.
  - `studio.stage.StudioStage(bus: EventBus, service: StudioService)` with `async run() -> None`; subscribes to `STATUS`, `INSIGHTS`, `NARRATIVES` in its constructor.
  - Two constants added to `studio.rules`: `DEFAULT_BANNER_SECONDS = 8`, `REPLAY_WINDOW_SECONDS = 20`.

- [ ] **Step 1: Write the failing tests**

`services/pipeline/tests/test_studio_service.py`:

```python
import asyncio

import pytest

from kickstream.adapters.dir_image_store import DirImageStore
from kickstream.adapters.json_studio_store import JsonStudioStore
from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.contracts import MatchStatus, Narrative
from kickstream.domain.teams import AWAY, HOME
from kickstream.ports.bus import INSIGHTS, NARRATIVES, STATUS
from kickstream.studio import rules
from kickstream.studio.rules import StudioError
from kickstream.studio.service import StudioService
from kickstream.studio.stage import StudioStage
from kickstream.studio.templates import BREAK, LIVE_MATCH, default_studio

from tests.factories import MATCH, moment

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


class FakeNow:
    def __init__(self, at=1_000.0):
        self.at = at

    def __call__(self):
        return self.at


class Harness:
    def __init__(self, tmp_path, now=None, fail_start=False):
        self.now = now or FakeNow()
        self.started = []
        self.fail_start = fail_start
        self.moments = {(MATCH, f"{MATCH}-k1"): moment(1)}
        self.service = StudioService(
            JsonStudioStore(tmp_path / "studio.json", sanitize=rules.sanitize_raw), DirImageStore(tmp_path / "images", max_images=3),
            now=self.now, start_match=self._start, find_moment=lambda m, k: self.moments.get((m, k)))

    async def _start(self):
        if self.fail_start:
            raise RuntimeError("simulator unavailable")
        self.started.append(self.now.at)
        return "m-1"


def scene_id(doc, template):
    return next(s.id for s in doc.scenes if s.template == template)


async def test_a_new_studio_starts_from_the_templates_and_stamps_the_server_time(tmp_path):
    harness = Harness(tmp_path)
    doc = harness.service.doc
    assert len(doc.scenes) == 5 and doc.revision == 0 and doc.server_time == 1_000.0
    harness.now.at = 1_050.0
    assert harness.service.doc.server_time == 1_050.0


async def test_a_change_bumps_the_revision_and_survives_a_restart(tmp_path):
    harness = Harness(tmp_path)
    live = scene_id(harness.service.doc, LIVE_MATCH)
    doc = await harness.service.apply(lambda d: rules.activate_scene(d, live))
    assert (doc.revision, doc.active_scene_id) == (1, live)
    restarted = Harness(tmp_path).service.doc
    assert (restarted.revision, restarted.active_scene_id) == (1, live)


async def test_a_rule_that_changes_nothing_does_not_create_a_revision(tmp_path):
    harness = Harness(tmp_path)
    doc = await harness.service.apply(rules.end_countdown)
    assert doc.revision == 0 and not (tmp_path / "studio.json").exists()


async def test_a_refused_change_leaves_the_document_as_it_was(tmp_path):
    harness = Harness(tmp_path)
    with pytest.raises(StudioError):
        await harness.service.apply(lambda d: rules.activate_scene(d, "nope"))
    assert harness.service.doc.revision == 0


async def test_a_result_outside_the_schema_is_refused_with_the_field_named(tmp_path):
    harness = Harness(tmp_path)

    def too_many_queued(doc):
        waiting = rules.enqueue_banner(rules.enqueue_banner(doc, "a", "info", 8, 0.0), "b", "info", 8, 0.0).banner_queue[0]
        return doc.model_copy(update={"banner_queue": [waiting] * 11})

    with pytest.raises(StudioError, check=lambda e: e.status == 422 and e.field.startswith("banner_queue")):
        await harness.service.apply(too_many_queued)
    assert harness.service.doc.revision == 0


async def test_a_failed_save_is_reported_and_nothing_changes(tmp_path):
    harness = Harness(tmp_path)
    (tmp_path / "studio.tmp").mkdir()
    with pytest.raises(StudioError, check=lambda e: e.status == 503):
        await harness.service.banner("Hello", "custom", 8)
    doc = harness.service.doc
    assert doc.revision == 0 and doc.banner is None


async def test_subscribers_get_the_current_document_then_the_latest_after_changes(tmp_path):
    harness = Harness(tmp_path)
    changes = harness.service.changes()
    assert (await anext(changes)).revision == 0
    await harness.service.banner("One", "custom", 8)
    await harness.service.banner("Two", "custom", 8)
    latest = await asyncio.wait_for(anext(changes), 1)
    assert latest.revision == 2, "a slow page gets the latest document, not every step"
    pending = asyncio.create_task(anext(changes))
    await asyncio.sleep(0.01)
    assert not pending.done()
    pending.cancel()
    await changes.aclose()
    assert harness.service._listeners == set()


async def test_tick_settles_what_is_due_and_nothing_sooner(tmp_path):
    harness = Harness(tmp_path)
    await harness.service.banner("Hello", "custom", 8)
    harness.now.at += 7
    await harness.service.tick()
    assert harness.service.doc.banner is not None and harness.service.doc.revision == 1
    harness.now.at += 1
    await harness.service.tick()
    assert harness.service.doc.banner is None and harness.service.doc.revision == 2


async def test_the_end_of_the_start_countdown_starts_the_match_and_cuts_to_live(tmp_path):
    harness = Harness(tmp_path)
    await harness.service.countdown(harness.now.at + 600, label="Kick-off")
    harness.now.at += 600
    await harness.service.tick()
    doc = harness.service.doc
    assert harness.started == [1_600.0]
    assert doc.countdown is None and doc.active_scene_id == scene_id(doc, LIVE_MATCH)


async def test_a_match_that_fails_to_start_does_not_undo_the_scene_change(tmp_path):
    harness = Harness(tmp_path, fail_start=True)
    await harness.service.countdown(harness.now.at + 60)
    harness.now.at += 60
    await harness.service.tick()
    assert harness.service.doc.countdown is None


async def test_deadlines_that_passed_while_the_server_was_down_are_settled_on_start(tmp_path):
    first = Harness(tmp_path)
    live = scene_id(first.service.doc, LIVE_MATCH)
    await first.service.apply(lambda d: rules.activate_scene(d, live))
    await first.service.take_break(5)
    await first.service.banner("Stale", "custom", 8)
    assert first.service.doc.active_scene_id == scene_id(first.service.doc, BREAK)

    later = Harness(tmp_path, now=FakeNow(first.now.at + 3_600))
    assert later.service.doc.countdown is not None, "loaded as saved"
    await later.service.tick()
    doc = later.service.doc
    assert (doc.countdown, doc.banner, doc.active_scene_id) == (None, None, live)


async def test_a_start_countdown_that_ended_while_down_still_starts_the_match(tmp_path):
    first = Harness(tmp_path)
    await first.service.countdown(first.now.at + 60)
    later = Harness(tmp_path, now=FakeNow(first.now.at + 500))
    await later.service.tick()
    assert later.started == [1_500.0]


async def test_the_run_loop_settles_overdue_deadlines_when_a_change_wakes_it(tmp_path):
    harness = Harness(tmp_path)
    loop = asyncio.create_task(harness.service.run())
    await harness.service.banner("Hello", "custom", 3)
    harness.now.at += 10
    await harness.service.apply(lambda d: rules.set_ticker(d, d.ticker.model_copy(update={"speed": 200})))
    await asyncio.sleep(0.05)
    assert harness.service.doc.banner is None, "the change woke the loop, which found the banner overdue"
    assert not loop.done()
    loop.cancel()


async def test_replaying_a_known_moment_sets_the_replay_and_an_unknown_one_is_not_found(tmp_path):
    harness = Harness(tmp_path)
    doc = await harness.service.replay(MATCH, f"{MATCH}-k1")
    assert (doc.replay.moment_id, doc.replay.started_at, doc.replay.duration_s) == (f"{MATCH}-k1", 1_000.0, 8.0)
    for match_id, moment_id in ((MATCH, "nope"), ("m-9", f"{MATCH}-k1")):
        with pytest.raises(StudioError, check=lambda e: (e.status, e.field) == (404, "moment")):
            await harness.service.replay(match_id, moment_id)


async def test_uploads_are_checked_by_content_size_and_count(tmp_path):
    harness = Harness(tmp_path)
    image_id = harness.service.upload(PNG)
    assert harness.service.image(image_id) == (PNG, "image/png")
    assert harness.service.image("../studio.json") is None
    for content in (b"plain text pretending", b"<svg xmlns='http://www.w3.org/2000/svg'/>", b""):
        with pytest.raises(StudioError, check=lambda e: (e.status, e.field) == (422, "image")):
            harness.service.upload(content)
    with pytest.raises(StudioError, check=lambda e: "2 MB" in e.message):
        harness.service.upload(PNG + b"\x00" * rules.MAX_IMAGE_BYTES)
    harness.service.upload(PNG)
    harness.service.upload(PNG)
    with pytest.raises(StudioError, check=lambda e: e.status == 422 and "already holds" in e.message):
        harness.service.upload(PNG)


# --- stage ------------------------------------------------------------------------------------

def narrative(mode="fan", language="en", n=1, text="GOAL! What a strike."):
    return Narrative(id=f"{MATCH}-k{n}-{mode}-{language}", match_id=MATCH, minute=23, moment_id=f"{MATCH}-k{n}",
                     mode=mode, language=language, text=text, source="scripted", agent="scripted", evidence=[], team="home")


def status(state="live", match_id=MATCH):
    return MatchStatus(match_id=match_id, state=state, minute=45, score_home=0, score_away=0, speed=30, home=HOME, away=AWAY)


async def staged(tmp_path, **settings):
    harness = Harness(tmp_path)
    if settings:
        await harness.service.apply(lambda d: rules.set_settings(d, d.settings.model_copy(update=settings)))
    bus = InMemoryEventBus()
    task = asyncio.create_task(StudioStage(bus, harness.service).run())

    async def publish(topic, payload, match_id=MATCH):
        await bus.publish(topic, match_id, payload)
        await asyncio.sleep(0.01)

    return harness, publish, task


async def test_a_goal_narrative_in_the_program_variant_becomes_a_banner(tmp_path):
    harness, publish, task = await staged(tmp_path)
    await publish(INSIGHTS, moment(1, kind="goal"))
    await publish(NARRATIVES, narrative("analyst", "en"))
    await publish(NARRATIVES, narrative("fan", "es"))
    assert harness.service.doc.banner is None, "other variants are not the program's"
    await publish(NARRATIVES, narrative("fan", "en"))
    task.cancel()
    banner = harness.service.doc.banner
    assert (banner.text, banner.kind, banner.duration_s, banner.source_id) == ("GOAL! What a strike.", "goal", 8, f"{MATCH}-k1-fan-en")


async def test_red_cards_become_card_banners_and_lesser_moments_do_not(tmp_path):
    harness, publish, task = await staged(tmp_path)
    await publish(INSIGHTS, moment(1, kind="big_chance"))
    await publish(NARRATIVES, narrative(n=1))
    assert harness.service.doc.banner is None
    await publish(INSIGHTS, moment(2, kind="red_card"))
    await publish(NARRATIVES, narrative(n=2, text="Red card!"))
    task.cancel()
    assert harness.service.doc.banner.kind == "card"


async def test_the_banner_follows_the_program_language(tmp_path):
    harness, publish, task = await staged(tmp_path, mode="analyst", language="hi")
    await publish(INSIGHTS, moment(1))
    await publish(NARRATIVES, narrative("fan", "en"))
    await publish(NARRATIVES, narrative("analyst", "hi", text="गोल!"))
    task.cancel()
    assert harness.service.doc.banner.text == "गोल!"


async def test_automatic_banners_can_be_switched_off(tmp_path):
    harness, publish, task = await staged(tmp_path, auto_banner=False)
    await publish(INSIGHTS, moment(1))
    await publish(NARRATIVES, narrative())
    task.cancel()
    assert harness.service.doc.banner is None


async def test_a_long_narrative_is_cut_to_fit_a_banner(tmp_path):
    harness, publish, task = await staged(tmp_path)
    await publish(INSIGHTS, moment(1))
    await publish(NARRATIVES, narrative(text="x" * 500))
    task.cancel()
    assert len(harness.service.doc.banner.text) == 200


async def test_half_time_starts_a_two_minute_break_once_per_match_when_enabled(tmp_path):
    harness, publish, task = await staged(tmp_path, auto_half_time_break=True)
    await publish(STATUS, status("live"))
    assert harness.service.doc.countdown is None
    await publish(STATUS, status("half_time"))
    doc = harness.service.doc
    assert (doc.countdown.kind, doc.countdown.ends_at) == ("break", 1_000.0 + 120)
    await harness.service.apply(rules.end_countdown)
    await publish(STATUS, status("half_time"))
    assert harness.service.doc.countdown is None, "a repeated half-time status does not restart the break"
    await publish(STATUS, status("half_time", match_id="m-2"), match_id="m-2")
    task.cancel()
    assert harness.service.doc.countdown is not None


async def test_half_time_does_nothing_unless_enabled(tmp_path):
    harness, publish, task = await staged(tmp_path)
    await publish(STATUS, status("half_time"))
    task.cancel()
    assert harness.service.doc.countdown is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_studio_service.py -q`
Expected: collection error, `ModuleNotFoundError: No module named 'kickstream.studio.service'`.

- [ ] **Step 3: Add the two constants**

In `services/pipeline/kickstream/studio/rules.py`, after `REPLAY_SECONDS = 8.0`, add:

```python
REPLAY_WINDOW_SECONDS = 20  # match time shown by a replay, ending at the moment
DEFAULT_BANNER_SECONDS = 8
```

- [ ] **Step 4: Write the service**

`services/pipeline/kickstream/studio/service.py`:

```python
"""Holds the studio document: applies rules, saves, notifies pages, and settles deadlines."""

import asyncio
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable

from pydantic import ValidationError

from kickstream.contracts import KeyMoment, Studio, StudioSettings
from kickstream.ports.image_store import ImageStore, ImageStoreFull
from kickstream.ports.studio_store import StudioStore
from kickstream.studio import rules
from kickstream.studio.rules import StudioError
from kickstream.studio.templates import default_studio

log = logging.getLogger(__name__)


class StudioService:
    def __init__(self, store: StudioStore, images: ImageStore, *, now: Callable[[], float] = time.time,
                 start_match: Callable[[], Awaitable[str]],
                 find_moment: Callable[[str, str], KeyMoment | None]) -> None:
        self._store = store
        self._images = images
        self._now = now
        self._start_match = start_match
        self._find_moment = find_moment
        self._doc = store.load() or default_studio()
        self._lock = asyncio.Lock()
        self._wake = asyncio.Event()
        self._listeners: set[asyncio.Event] = set()

    @property
    def doc(self) -> Studio:
        return self._doc.model_copy(update={"server_time": self._now()})

    @property
    def settings(self) -> StudioSettings:
        return self._doc.settings

    def now(self) -> float:
        return self._now()

    async def apply(self, change: Callable[[Studio], Studio]) -> Studio:
        async with self._lock:
            return self._commit(change(self._doc))

    def _commit(self, changed: Studio) -> Studio:
        if changed is self._doc:
            return self.doc
        try:
            candidate = Studio.model_validate(changed.model_copy(update={"revision": self._doc.revision + 1}).model_dump())
        except ValidationError as exc:
            first = exc.errors()[0]
            raise StudioError(422, ".".join(str(part) for part in first["loc"]), first["msg"]) from exc
        try:
            self._store.save(candidate)
        except OSError as exc:
            raise StudioError(503, "studio", "The change could not be saved. Nothing was changed.") from exc
        self._doc = candidate
        for listener in self._listeners:
            listener.set()
        self._wake.set()
        return self.doc

    # --- changes that need the clock or a lookup ---------------------------------------------

    async def banner(self, text: str, kind: str, duration_s: int, source_id: str | None = None) -> Studio:
        return await self.apply(lambda doc: rules.enqueue_banner(doc, text, kind, duration_s, self._now(), source_id))

    async def clear_banner(self) -> Studio:
        return await self.apply(lambda doc: rules.clear_banner(doc, self._now()))

    async def countdown(self, starts_at: float, label: str = "") -> Studio:
        return await self.apply(lambda doc: rules.start_countdown(doc, starts_at, self._now(), label))

    async def take_break(self, minutes: int, label: str = "") -> Studio:
        return await self.apply(lambda doc: rules.start_break(doc, minutes, self._now(), label))

    async def replay(self, match_id: str, moment_id: str) -> Studio:
        moment = self._find_moment(match_id, moment_id)
        if moment is None:
            raise StudioError(404, "moment", "That key moment is no longer available to replay.")
        return await self.apply(lambda doc: rules.start_replay(doc, moment, self._now()))

    # --- images -------------------------------------------------------------------------------

    def upload(self, content: bytes) -> str:
        if len(content) > rules.MAX_IMAGE_BYTES:
            raise StudioError(422, "image", "An image can be at most 2 MB.")
        media_type = rules.sniff_image(content)
        if media_type is None:
            raise StudioError(422, "image", "Only PNG, JPEG and WebP images can be uploaded.")
        try:
            return self._images.save(content, media_type)
        except ImageStoreFull as exc:
            raise StudioError(422, "image", "The studio already holds as many images as it allows.") from exc
        except OSError as exc:
            raise StudioError(503, "image", "The image could not be saved.") from exc

    def image(self, image_id: str) -> tuple[bytes, str] | None:
        return self._images.get(image_id)

    # --- deadlines ----------------------------------------------------------------------------

    async def tick(self) -> None:
        async with self._lock:
            settled, actions = rules.expire(self._doc, self._now())
            self._commit(settled)
        for action in actions:
            if action == "start_match":
                try:
                    await self._start_match()
                except Exception:  # noqa: BLE001 - the program has already cut to live; report and carry on
                    log.exception("the match could not be started at the end of the countdown")

    async def run(self) -> None:
        while True:
            # Cleared before the tick, so a change made during it is not lost.
            self._wake.clear()
            try:
                await self.tick()
            except StudioError as exc:
                log.warning("could not settle studio deadlines (%s); retrying", exc.message)
                await asyncio.sleep(1)
                continue
            deadline = rules.next_deadline(self._doc)
            timeout = None if deadline is None else max(0.0, deadline - self._now())
            try:
                await asyncio.wait_for(self._wake.wait(), timeout)
            except TimeoutError:
                pass

    # --- pages --------------------------------------------------------------------------------

    async def changes(self) -> AsyncIterator[Studio]:
        """The current document, then the latest one after each change. Slow readers skip steps."""
        listener = asyncio.Event()
        self._listeners.add(listener)
        try:
            yield self.doc
            while True:
                await listener.wait()
                listener.clear()
                yield self.doc
        finally:
            self._listeners.discard(listener)
```

- [ ] **Step 5: Write the stage**

`services/pipeline/kickstream/studio/stage.py`:

```python
import logging

from kickstream.contracts import KeyMoment, MatchStatus, Narrative
from kickstream.ports.bus import INSIGHTS, NARRATIVES, STATUS, EventBus
from kickstream.studio import rules
from kickstream.studio.rules import StudioError
from kickstream.studio.service import StudioService

log = logging.getLogger(__name__)
_BANNER_KIND = {"goal": "goal", "red_card": "card"}
_REMEMBERED_MOMENTS = 2000


class StudioStage:
    """Feeds the studio from the match: automatic banners and the half-time break."""

    def __init__(self, bus: EventBus, service: StudioService) -> None:
        self._service = service
        self._messages = bus.subscribe(STATUS, INSIGHTS, NARRATIVES)
        self._kinds: dict[str, str] = {}
        self._half_times: set[str] = set()

    async def run(self) -> None:
        async for message in self._messages:
            try:
                await self._handle(message.match_id, message.payload)
            except StudioError as exc:
                log.warning("studio ignored a match message: %s", exc.message)

    async def _handle(self, match_id: str, payload) -> None:
        settings = self._service.settings
        if isinstance(payload, KeyMoment):
            if len(self._kinds) >= _REMEMBERED_MOMENTS:
                self._kinds.clear()
            self._kinds[payload.id] = payload.kind
        elif isinstance(payload, Narrative):
            kind = _BANNER_KIND.get(self._kinds.get(payload.moment_id, ""))
            in_program_variant = (payload.mode, payload.language) == (settings.mode, settings.language)
            if kind and settings.auto_banner and in_program_variant:
                await self._service.banner(payload.text[:200], kind, rules.DEFAULT_BANNER_SECONDS, source_id=payload.id)
        elif isinstance(payload, MatchStatus) and payload.state == "half_time":
            if settings.auto_half_time_break and match_id not in self._half_times:
                self._half_times.add(match_id)
                await self._service.take_break(rules.HALF_TIME_BREAK_MINUTES)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `uv run pytest tests/test_studio_service.py tests/test_studio_rules.py -q`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add services/pipeline/kickstream/studio services/pipeline/tests/test_studio_service.py
git commit -m "feat: add studio service with server-side deadlines and match-driven banners"
```

---

### Task 5: Studio HTTP API and wiring

**Files:**
- Create: `services/pipeline/kickstream/studio/api.py`
- Modify: `services/pipeline/kickstream/app.py` (full replacement below)
- Modify: `services/pipeline/tests/test_architecture.py` (add `studio` to the stages)
- Modify: `services/pipeline/tests/test_api.py`, `services/pipeline/tests/test_pipeline.py` (give each test its own data directory)
- Test: `services/pipeline/tests/test_studio_api.py`

**Interfaces:**
- Consumes: `StudioService`, `StudioStage`, `rules`, `ports.store.MatchStore`, both store adapters, the cycle 1 pipeline.
- Produces:
  - `studio.api.find_moment(store: MatchStore, match_id: str, moment_id: str) -> KeyMoment | None`
  - `studio.api.replay_events(store: MatchStore, match_id: str, moment: KeyMoment) -> list[MatchEvent]`: team events in the 20 match seconds ending at the moment's event, oldest first.
  - `studio.api.build_studio_router(*, service: StudioService, store: MatchStore) -> APIRouter`
  - `app.Settings` gains `data_dir: Path = Path(".data")` (`KICKSTREAM_DATA_DIR`). `app.build_pipeline` and `app.create_app` gain `now: Callable[[], float] = time.time`. `Pipeline` gains `studio: StudioService`.
  - A refused change is returned as `{"detail": [{"loc": ["body", <field>], "msg": <message>, "type": "studio"}]}` with the rule's status, the same shape FastAPI uses for its own validation errors.

HTTP surface. Every route that changes the studio returns the new `Studio` document.

| Method and path | Body | Errors |
|---|---|---|
| `GET /api/studio` | | |
| `GET /api/studio/stream` | | Server-Sent Events: `id:` is the revision, `data:` the document |
| `POST /api/studio/scenes` | `{"source": "builtin" \| "template" \| "scene", "ref": str, "name"?: str}` | 404 `ref`, 422 `scenes` / `name` |
| `PUT /api/studio/scenes/{id}` | `{"name": str, "elements": SceneElement[]}` | 404 `scene`, 422 |
| `DELETE /api/studio/scenes/{id}` | | 404, 409 `scene` |
| `POST /api/studio/scenes/{id}/activate` | | 404 `scene` |
| `POST /api/studio/templates` | `{"scene_id": str, "name"?: str}` | 404 `scene`, 422 `templates` |
| `DELETE /api/studio/templates/{id}` | | 404 `template` |
| `PUT /api/studio/settings` | `StudioSettings` | 422 |
| `POST /api/studio/banner` | `{"text": str, "kind"?: "custom" \| "info" \| "goal" \| "card", "duration_s"?: int, "source_id"?: str}` | 422 `text` / `duration_s` |
| `DELETE /api/studio/banner` | | |
| `PUT /api/studio/ticker` | `Ticker` | 422 |
| `POST /api/studio/countdown` | `{"kind": "start", "starts_at": number, "label"?: str}` or `{"kind": "break", "minutes": int, "label"?: str}` | 422 `starts_at` / `minutes` |
| `DELETE /api/studio/countdown` | | |
| `POST /api/studio/replay` | `{"match_id": str, "moment_id": str}` | 404 `moment` |
| `DELETE /api/studio/replay` | | |
| `POST /api/studio/images` | the raw image bytes | 422 `image`; returns 201 `{"id": str}` |
| `GET /api/studio/images/{id}` | | 404 |
| `GET /api/matches/{id}/moments/{moment_id}/replay` | | 404; returns `{"moment": KeyMoment, "events": MatchEvent[]}` |

- [ ] **Step 1: Write the failing tests**

`services/pipeline/tests/test_studio_api.py`:

```python
import time

import pytest
from fastapi.testclient import TestClient

from kickstream.adapters.clocks import InstantClock
from kickstream.app import Settings, create_app

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


class FakeNow:
    def __init__(self):
        self.at = 5_000.0

    def __call__(self):
        return self.at


def make_app(tmp_path, now):
    settings = Settings(None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data")
    return create_app(settings, clock_factory=lambda speed: InstantClock(), match_prefix="m", now=now)


@pytest.fixture
def now():
    return FakeNow()


@pytest.fixture
def client(tmp_path, now):
    with TestClient(make_app(tmp_path, now)) as test_client:
        yield test_client


def field(response):
    return response.json()["detail"][0]["loc"][-1]


def scene(doc, template):
    return next(s for s in doc["scenes"] if s["template"] == template)


def test_the_studio_starts_with_five_scenes_and_the_server_time(client, now):
    doc = client.get("/api/studio").json()
    assert [s["name"] for s in doc["scenes"]] == ["Starting soon", "Live match", "Analyst desk", "Break", "Full-time"]
    assert doc["active_scene_id"] == doc["scenes"][0]["id"] and doc["server_time"] == now.at
    assert (doc["banner"], doc["countdown"], doc["replay"]) == (None, None, None)


def test_scenes_can_be_created_edited_activated_and_deleted(client):
    doc = client.post("/api/studio/scenes", json={"source": "builtin", "ref": "Live match", "name": "Second half"}).json()
    made = doc["scenes"][-1]
    assert (made["name"], len(doc["scenes"])) == ("Second half", 6)

    moved = [{**made["elements"][0], "x": 400, "y": 5000}, *made["elements"][1:]]
    doc = client.put(f"/api/studio/scenes/{made['id']}", json={"name": "Second half v2", "elements": moved}).json()
    edited = doc["scenes"][-1]
    assert edited["name"] == "Second half v2"
    assert (edited["elements"][0]["x"], edited["elements"][0]["y"]) == (400, 1080 - edited["elements"][0]["height"])

    doc = client.post(f"/api/studio/scenes/{made['id']}/activate").json()
    assert doc["active_scene_id"] == made["id"]
    assert client.delete(f"/api/studio/scenes/{made['id']}").status_code == 409
    client.post(f"/api/studio/scenes/{doc['scenes'][0]['id']}/activate")
    doc = client.delete(f"/api/studio/scenes/{made['id']}").json()
    assert len(doc["scenes"]) == 5


def test_refusals_name_the_field_and_use_the_right_status(client):
    first = client.get("/api/studio").json()["scenes"][0]
    cases = [
        (client.post("/api/studio/scenes", json={"source": "builtin", "ref": "Halftime show"}), 404, "ref"),
        (client.post("/api/studio/scenes", json={"source": "pasted", "ref": "x"}), 422, "source"),
        (client.put("/api/studio/scenes/nope", json={"name": "x", "elements": []}), 404, "scene"),
        (client.put(f"/api/studio/scenes/{first['id']}", json={"name": "   ", "elements": []}), 422, "name"),
        (client.put(f"/api/studio/scenes/{first['id']}", json={"name": "x", "elements": [{**first["elements"][0], "type": "webcam"}]}), 422, "type"),
        (client.post("/api/studio/scenes/nope/activate"), 404, "scene"),
        (client.delete(f"/api/studio/scenes/{first['id']}"), 409, "scene"),
        (client.post("/api/studio/templates", json={"scene_id": "nope"}), 404, "scene"),
        (client.delete("/api/studio/templates/nope"), 404, "template"),
        (client.post("/api/studio/banner", json={"text": "   "}), 422, "text"),
        (client.post("/api/studio/banner", json={"text": "ok", "duration_s": 99}), 422, "duration_s"),
        (client.post("/api/studio/banner", json={"text": "ok", "kind": "shout"}), 422, "kind"),
        (client.post("/api/studio/countdown", json={"kind": "start"}), 422, "starts_at"),
        (client.post("/api/studio/countdown", json={"kind": "start", "starts_at": 1.0}), 422, "starts_at"),
        (client.post("/api/studio/countdown", json={"kind": "break"}), 422, "minutes"),
        (client.post("/api/studio/countdown", json={"kind": "break", "minutes": 0}), 422, "minutes"),
        (client.post("/api/studio/replay", json={"match_id": "m-9", "moment_id": "m-9-k1"}), 404, "moment"),
        (client.put("/api/studio/ticker", json={"enabled": True, "speed": 5, "messages": [], "show_score": True, "show_stats": True}), 422, "speed"),
        (client.put("/api/studio/settings", json={"mode": "coach", "language": "en", "auto_banner": True, "auto_start": True, "auto_half_time_break": False}), 422, "mode"),
    ]
    for response, status, name in cases:
        assert (response.status_code, field(response)) == (status, name), response.text
    assert client.get("/api/studio").json()["revision"] == 0, "no refused request changed anything"


def test_templates_settings_and_ticker_are_saved(client):
    doc = client.get("/api/studio").json()
    doc = client.post("/api/studio/templates", json={"scene_id": doc["scenes"][1]["id"], "name": "My live"}).json()
    template = doc["templates"][0]
    assert template["name"] == "My live"
    doc = client.post("/api/studio/scenes", json={"source": "template", "ref": template["id"]}).json()
    assert doc["scenes"][-1]["name"] == "My live"
    assert client.delete(f"/api/studio/templates/{template['id']}").json()["templates"] == []

    settings = {"mode": "analyst", "language": "hi", "auto_banner": False, "auto_start": False, "auto_half_time_break": True}
    assert client.put("/api/studio/settings", json=settings).json()["settings"] == settings
    ticker = {"enabled": True, "speed": 200, "messages": ["  Welcome  ", " "], "show_score": False, "show_stats": True}
    assert client.put("/api/studio/ticker", json=ticker).json()["ticker"]["messages"] == ["Welcome"]


def test_banners_show_queue_and_clear(client, now):
    doc = client.post("/api/studio/banner", json={"text": "Welcome"}).json()
    assert (doc["banner"]["text"], doc["banner"]["kind"], doc["banner"]["ends_at"]) == ("Welcome", "custom", now.at + 8)
    doc = client.post("/api/studio/banner", json={"text": "Next", "kind": "info", "duration_s": 5, "source_id": "n1"}).json()
    assert [b["text"] for b in doc["banner_queue"]] == ["Next"]
    doc = client.delete("/api/studio/banner").json()
    assert (doc["banner"]["text"], doc["banner_queue"]) == ("Next", [])
    assert client.delete("/api/studio/banner").json()["banner"] is None


def test_a_break_cuts_away_and_ending_it_returns(client, now):
    doc = client.get("/api/studio").json()
    live = scene(doc, "Live match")["id"]
    client.post(f"/api/studio/scenes/{live}/activate")
    doc = client.post("/api/studio/countdown", json={"kind": "break", "minutes": 5, "label": "Back soon"}).json()
    assert doc["active_scene_id"] == scene(doc, "Break")["id"]
    assert doc["countdown"] == {"kind": "break", "ends_at": now.at + 300, "label": "Back soon"}
    doc = client.delete("/api/studio/countdown").json()
    assert (doc["active_scene_id"], doc["countdown"]) == (live, None)


def test_when_the_start_countdown_runs_out_a_match_starts_and_the_program_goes_live(client, now):
    doc = client.post("/api/studio/countdown", json={"kind": "start", "starts_at": now.at + 600}).json()
    assert doc["active_scene_id"] == scene(doc, "Starting soon")["id"]
    assert client.get("/api/matches/current").status_code == 404
    now.at += 601
    client.put("/api/studio/ticker", json={**doc["ticker"], "speed": 150})  # any change wakes the deadline loop
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and client.get("/api/matches/current").status_code != 200:
        time.sleep(0.05)
    assert client.get("/api/matches/current").json() == {"match_id": "m-1"}
    doc = client.get("/api/studio").json()
    assert doc["countdown"] is None and doc["active_scene_id"] == scene(doc, "Live match")["id"]


def _play_a_match(client):
    match_id = client.post("/api/matches", json={"speed": 600}).json()["match_id"]
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        title = client.get(f"/api/matches/{match_id}/overlays/latest").json().get("recap_card", {}).get("data", {}).get("title", "")
        if title.startswith("Full-time"):
            return match_id
        time.sleep(0.1)
    raise AssertionError("the match did not finish")


def test_goals_reach_the_banner_by_themselves_during_a_match(client):
    _play_a_match(client)
    doc = client.get("/api/studio").json()
    shown = [doc["banner"], *doc["banner_queue"]]
    goals = [b for b in shown if b and b["kind"] == "goal"]
    assert goals and goals[0]["text"].startswith("GOAL!") and goals[0]["source_id"].endswith("-fan-en")


def test_a_key_moment_can_be_replayed_and_its_events_fetched(client, now):
    match_id = _play_a_match(client)
    log = client.app.state.pipeline.store.read(match_id)
    goal = next(i.payload for i in log if i.type == "key_moment" and i.payload.kind == "goal")

    doc = client.post("/api/studio/replay", json={"match_id": match_id, "moment_id": goal.id}).json()
    assert doc["replay"] == {"match_id": match_id, "moment_id": goal.id, "minute": goal.minute, "started_at": now.at, "duration_s": 8.0}

    body = client.get(f"/api/matches/{match_id}/moments/{goal.id}/replay").json()
    assert body["moment"]["id"] == goal.id
    times = [e["minute"] * 60 + e["second"] for e in body["events"]]
    assert times and times == sorted(times) and times[-1] - times[0] <= 20
    assert body["events"][-1]["type"] == "goal" and all(e["team"] for e in body["events"])

    assert client.delete("/api/studio/replay").json()["replay"] is None
    assert client.get(f"/api/matches/{match_id}/moments/nope/replay").status_code == 404
    assert client.get(f"/api/matches/m-99/moments/{goal.id}/replay").status_code == 404


def test_images_are_accepted_by_content_and_served_safely(client):
    created = client.post("/api/studio/images", content=PNG, headers={"content-type": "application/octet-stream"})
    assert created.status_code == 201
    image_id = created.json()["id"]
    fetched = client.get(f"/api/studio/images/{image_id}")
    assert (fetched.status_code, fetched.content, fetched.headers["content-type"]) == (200, PNG, "image/png")
    assert fetched.headers["x-content-type-options"] == "nosniff"

    for content in (b"<svg xmlns='http://www.w3.org/2000/svg'/>", b"plain text named logo.png", b"", PNG + b"\x00" * (2 * 1024 * 1024)):
        refused = client.post("/api/studio/images", content=content, headers={"content-type": "image/png"})
        assert (refused.status_code, field(refused)) == (422, "image")
    for bad_id in ("nope.png", "..%2Fstudio.json", "0" * 32 + ".png"):
        assert client.get(f"/api/studio/images/{bad_id}").status_code == 404


def test_scenes_and_settings_survive_a_restart(tmp_path, now):
    with TestClient(make_app(tmp_path, now)) as first:
        doc = first.get("/api/studio").json()
        target = doc["scenes"][1]
        first.put(f"/api/studio/scenes/{target['id']}", json={"name": "Matchday", "elements": target["elements"][:2]})
        first.put("/api/studio/settings", json={**doc["settings"], "language": "es"})
    with TestClient(make_app(tmp_path, now)) as second:
        doc = second.get("/api/studio").json()
        assert doc["scenes"][1]["name"] == "Matchday" and len(doc["scenes"][1]["elements"]) == 2
        assert doc["settings"]["language"] == "es" and doc["revision"] == 2


def test_a_corrupt_studio_file_does_not_stop_the_server(tmp_path, now):
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "studio.json").write_text("{broken", encoding="utf-8")
    with TestClient(make_app(tmp_path, now)) as test_client:
        assert len(test_client.get("/api/studio").json()["scenes"]) == 5
    assert (tmp_path / "data" / "studio.json.corrupt").exists()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_studio_api.py -q`
Expected: every test errors with `TypeError: Settings.__init__() got an unexpected keyword argument 'data_dir'`.

- [ ] **Step 3: Write the API**

`services/pipeline/kickstream/studio/api.py`:

```python
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict
from sse_starlette.sse import EventSourceResponse

from kickstream.contracts import KeyMoment, MatchEvent, SceneElement, Studio, StudioSettings, Ticker
from kickstream.ports.store import MatchStore
from kickstream.studio import rules
from kickstream.studio.rules import StudioError
from kickstream.studio.service import StudioService


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NewScene(_Body):
    source: Literal["builtin", "template", "scene"]
    ref: str
    name: str | None = None


class SceneBody(_Body):
    name: str
    elements: list[SceneElement]


class NewTemplate(_Body):
    scene_id: str
    name: str | None = None


class NewBanner(_Body):
    text: str
    kind: Literal["custom", "info", "goal", "card"] = "custom"
    duration_s: int = rules.DEFAULT_BANNER_SECONDS
    source_id: str | None = None


class NewCountdown(_Body):
    kind: Literal["start", "break"]
    starts_at: float | None = None
    minutes: int | None = None
    label: str = ""


class NewReplay(_Body):
    match_id: str
    moment_id: str


def find_moment(store: MatchStore, match_id: str, moment_id: str) -> KeyMoment | None:
    for item in store.read(match_id):
        if item.type == "key_moment" and item.payload.id == moment_id:
            return item.payload
    return None


def replay_events(store: MatchStore, match_id: str, moment: KeyMoment) -> list[MatchEvent]:
    """Team events in the match seconds leading up to the moment, oldest first."""

    def at(event: MatchEvent) -> int:
        return event.minute * 60 + event.second

    events = [item.payload for item in store.read(match_id) if item.type == "match_event"]
    # A moment without its own event (a momentum swing, sustained pressure) ends with its minute.
    anchor = next((at(event) for event in events if event.id == moment.event_id), moment.minute * 60 + 59)
    return [event for event in events
            if event.team is not None and anchor - rules.REPLAY_WINDOW_SECONDS <= at(event) <= anchor]


def build_studio_router(*, service: StudioService, store: MatchStore) -> APIRouter:
    router = APIRouter()

    @router.get("/api/studio")
    def get_studio() -> Studio:
        return service.doc

    @router.get("/api/studio/stream")
    async def get_stream() -> EventSourceResponse:
        async def documents():
            async for doc in service.changes():
                yield {"id": str(doc.revision), "data": doc.model_dump_json()}

        return EventSourceResponse(documents())

    @router.post("/api/studio/scenes")
    async def post_scene(body: NewScene) -> Studio:
        return await service.apply(lambda doc: rules.create_scene(doc, body.source, body.ref, body.name))

    @router.put("/api/studio/scenes/{scene_id}")
    async def put_scene(scene_id: str, body: SceneBody) -> Studio:
        return await service.apply(lambda doc: rules.replace_scene(doc, scene_id, body.name, body.elements))

    @router.delete("/api/studio/scenes/{scene_id}")
    async def delete_scene(scene_id: str) -> Studio:
        return await service.apply(lambda doc: rules.delete_scene(doc, scene_id))

    @router.post("/api/studio/scenes/{scene_id}/activate")
    async def post_activate(scene_id: str) -> Studio:
        return await service.apply(lambda doc: rules.activate_scene(doc, scene_id))

    @router.post("/api/studio/templates")
    async def post_template(body: NewTemplate) -> Studio:
        return await service.apply(lambda doc: rules.save_template(doc, body.scene_id, body.name))

    @router.delete("/api/studio/templates/{template_id}")
    async def delete_template(template_id: str) -> Studio:
        return await service.apply(lambda doc: rules.delete_template(doc, template_id))

    @router.put("/api/studio/settings")
    async def put_settings(body: StudioSettings) -> Studio:
        return await service.apply(lambda doc: rules.set_settings(doc, body))

    @router.post("/api/studio/banner")
    async def post_banner(body: NewBanner) -> Studio:
        return await service.banner(body.text, body.kind, body.duration_s, body.source_id)

    @router.delete("/api/studio/banner")
    async def delete_banner() -> Studio:
        return await service.clear_banner()

    @router.put("/api/studio/ticker")
    async def put_ticker(body: Ticker) -> Studio:
        return await service.apply(lambda doc: rules.set_ticker(doc, body))

    @router.post("/api/studio/countdown")
    async def post_countdown(body: NewCountdown) -> Studio:
        if body.kind == "start":
            if body.starts_at is None:
                raise StudioError(422, "starts_at", "A start countdown needs a start time.")
            return await service.countdown(body.starts_at, body.label)
        if body.minutes is None:
            raise StudioError(422, "minutes", "A break needs a length in minutes.")
        return await service.take_break(body.minutes, body.label)

    @router.delete("/api/studio/countdown")
    async def delete_countdown() -> Studio:
        return await service.apply(rules.end_countdown)

    @router.post("/api/studio/replay")
    async def post_replay(body: NewReplay) -> Studio:
        return await service.replay(body.match_id, body.moment_id)

    @router.delete("/api/studio/replay")
    async def delete_replay() -> Studio:
        return await service.apply(rules.stop_replay)

    @router.post("/api/studio/images", status_code=201)
    async def post_image(request: Request) -> dict[str, str]:
        declared = request.headers.get("content-length", "0")
        if declared.isdigit() and int(declared) > rules.MAX_IMAGE_BYTES:
            raise StudioError(422, "image", "An image can be at most 2 MB.")
        return {"id": service.upload(await request.body())}

    @router.get("/api/studio/images/{image_id}")
    def get_image(image_id: str) -> Response:
        found = service.image(image_id)
        if found is None:
            raise HTTPException(status_code=404, detail="no such image")
        content, media_type = found
        return Response(content=content, media_type=media_type, headers={
            "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"})

    @router.get("/api/matches/{match_id}/moments/{moment_id}/replay")
    def get_replay_events(match_id: str, moment_id: str) -> dict:
        moment = find_moment(store, match_id, moment_id)
        if moment is None:
            raise HTTPException(status_code=404, detail="no such key moment")
        return {"moment": moment.model_dump(mode="json"),
                "events": [event.model_dump(mode="json") for event in replay_events(store, match_id, moment)]}

    return router
```

- [ ] **Step 4: Wire the studio into the composition root**

Replace `services/pipeline/kickstream/app.py` with:

```python
"""Composition root. The only module that names concrete adapters."""

import asyncio
import os
import secrets
import time
from collections.abc import Callable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from kickstream.adapters.agent_writer import AgentNarrativeWriter
from kickstream.adapters.clocks import RealClock
from kickstream.adapters.dir_image_store import DirImageStore
from kickstream.adapters.json_studio_store import JsonStudioStore
from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.adapters.memory_store import InMemoryMatchStore
from kickstream.adapters.scripted_writer import ScriptedNarrativeWriter
from kickstream.adapters.sse_broadcaster import InProcessBroadcaster
from kickstream.analytics.stage import AnalyticsStage
from kickstream.control import MatchController
from kickstream.domain.demo import DEMO_SEED
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
from kickstream.studio.api import build_studio_router, find_moment
from kickstream.studio.rules import StudioError, sanitize_raw
from kickstream.studio.service import StudioService
from kickstream.studio.stage import StudioStage

STUDIO_MATCH_SPEED = 30.0  # playback speed of a match the studio starts at the end of a countdown


@dataclass(frozen=True)
class Settings:
    llm_base_url: str | None
    llm_model: str | None
    llm_api_key: str | None
    llm_max_calls: int = 60  # per match; a key moment costs 3 calls, a recap 2
    llm_reserve: int = 15  # kept back for goals and recaps
    llm_min_gap_s: float = 2.0  # between non-priority model calls
    cache_dir: Path = Path(".cache/narration")
    data_dir: Path = Path(".data")  # the studio document and uploaded images

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "Settings":
        return cls(
            llm_base_url=env.get("KICKSTREAM_LLM_BASE_URL") or None,
            llm_model=env.get("KICKSTREAM_LLM_MODEL") or None,
            llm_api_key=env.get("KICKSTREAM_LLM_API_KEY") or None,
            llm_max_calls=int(env.get("KICKSTREAM_LLM_MAX_CALLS", "60")),
            cache_dir=Path(env.get("KICKSTREAM_CACHE_DIR", ".cache/narration")),
            data_dir=Path(env.get("KICKSTREAM_DATA_DIR", ".data")),
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
    studio: StudioService
    stages: list
    tasks: list[asyncio.Task] = field(default_factory=list)

    def start(self) -> None:
        self.tasks = [asyncio.create_task(stage.run()) for stage in self.stages]
        self.tasks.append(asyncio.create_task(self.studio.run()))

    async def stop(self) -> None:
        await self.controller.stop()
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.tasks = []


def build_pipeline(
    settings: Settings,
    *,
    clock_factory: Callable[[float], Clock] = RealClock,
    writer: NarrativeWriter | None = None,
    match_prefix: str = "m",
    now: Callable[[], float] = time.time,
) -> Pipeline:
    bus, store, broadcaster = InMemoryEventBus(), InMemoryMatchStore(), InProcessBroadcaster()
    primary = writer
    if primary is None and settings.llm_configured:
        primary = AgentNarrativeWriter(settings.llm_base_url, settings.llm_model, settings.llm_api_key)
    service = NarrationService(
        ScriptedNarrativeWriter(),
        primary,
        budget=Budget(settings.llm_max_calls, settings.llm_reserve, settings.llm_min_gap_s),
        cache=DiskCache(settings.cache_dir) if primary is not None else None,
    )
    controller = MatchController(bus, clock_factory, HOME, AWAY, prefix=match_prefix)
    studio = StudioService(
        JsonStudioStore(settings.data_dir / "studio.json", sanitize=sanitize_raw),
        DirImageStore(settings.data_dir / "images"),
        now=now,
        start_match=lambda: controller.start(DEMO_SEED, STUDIO_MATCH_SPEED),
        find_moment=lambda match_id, moment_id: find_moment(store, match_id, moment_id),
    )
    # Every stage subscribes in its constructor, so nothing published after this point is missed.
    stages = [
        AnalyticsStage(bus),
        NarrationStage(bus, service),
        OverlayStage(bus),
        Recorder(bus, store, broadcaster),
        StudioStage(bus, studio),
    ]
    return Pipeline(bus, store, broadcaster, controller, studio, stages)


def create_app(
    settings: Settings | None = None,
    *,
    clock_factory: Callable[[float], Clock] = RealClock,
    writer: NarrativeWriter | None = None,
    match_prefix: str | None = None,
    now: Callable[[], float] = time.time,
) -> FastAPI:
    # Match IDs are unique to this process, so an ID a browser kept from before a restart is
    # reported as unknown instead of silently naming a different match.
    pipeline = build_pipeline(
        settings or Settings.from_env(),
        clock_factory=clock_factory,
        writer=writer,
        match_prefix=match_prefix or f"m{secrets.token_hex(3)}",
        now=now,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        pipeline.start()
        yield
        await pipeline.stop()

    app = FastAPI(title="Kickstream", lifespan=lifespan)
    app.state.pipeline = pipeline

    @app.exception_handler(StudioError)
    async def refused(_: Request, exc: StudioError) -> JSONResponse:
        # The same shape FastAPI uses for its own validation errors, so clients read one format.
        detail = [{"loc": ["body", exc.field], "msg": exc.message, "type": "studio"}]
        return JSONResponse(status_code=exc.status, content={"detail": detail})

    app.include_router(
        build_router(
            store=pipeline.store,
            broadcaster=pipeline.broadcaster,
            teams=(HOME, AWAY),
            start_match=pipeline.controller.start,
            current_match=lambda: pipeline.controller.current,
            match_exists=pipeline.controller.exists,
        )
    )
    app.include_router(build_studio_router(service=pipeline.studio, store=pipeline.store))
    return app
```

- [ ] **Step 5: Keep the existing tests out of the working directory**

Every existing test builds `Settings(None, None, None, cache_dir=tmp_path)`. With the studio wired in, that would write `.data/` into `services/pipeline`. In `services/pipeline/tests/test_api.py` and `services/pipeline/tests/test_pipeline.py`, replace each occurrence of

```python
Settings(None, None, None, cache_dir=tmp_path)
```

with

```python
Settings(None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data")
```

In `test_pipeline.py`, the last assertion of `test_with_a_writer_configured_goals_and_recaps_are_agent_written` becomes:

```python
    assert any((tmp_path / "cache").iterdir()), "agent output is cached on disk"
```

In `services/pipeline/tests/test_architecture.py`, add the new stage:

```python
STAGES = {"simulator", "analytics", "narration", "overlay", "gateway", "studio"}
```

- [ ] **Step 6: Run the whole Python suite**

Run: `uv run pytest -q && uv run ruff check . && uv run ruff format --check .`
Expected: every test passes; no lint findings. Run `uv run ruff format .` first if the format check reports files.

Run: `git status --short services/pipeline`
Expected: no `.data` directory appears under `services/pipeline`.

- [ ] **Step 7: Commit**

```bash
git add services/pipeline
git commit -m "feat: add studio HTTP API and wire the studio into the pipeline"
```

---

### Task 6: Web foundation: routing, shared match hook, studio client, geometry

**Files:**
- Create: `apps/web/src/stream/useCurrentMatch.ts`
- Create: `apps/web/src/studio/api.ts`, `geometry.ts`, `format.ts`, `useStudio.ts`
- Modify: `apps/web/src/App.tsx` (use the shared hook), `apps/web/src/main.tsx` (choose the page), `apps/web/src/i18n.ts` (three strings), `apps/web/src/test/fixtures.ts` (studio builders)
- Test: `apps/web/src/studio/geometry.test.ts`, `format.test.ts`, `useStudio.test.tsx`, `api.test.ts`

**Interfaces:**
- Consumes: cycle 1 `api.ts`, `stream/client.ts`, `stream/store.ts`; the Task 5 HTTP surface.
- Produces:
  - `stream/useCurrentMatch.ts`: `useCurrentMatch(profile: ViewerProfile | null, options?: { eventSource?; retryMs?: number; pollMs?: number }): { matchId: string | null; setMatchId(id: string | null): void }`. Joins the current match, keeps one stream open for `profile` (none while `profile` is null), retries while the server is unreachable, follows a replaced match, and checks for a new match while there is none or the current one has finished.
  - `studio/api.ts`: `StudioRequestError(status, field, message)`; `getStudio()`, `createScene(source, ref, name?)`, `saveScene(scene)`, `deleteScene(id)`, `activateScene(id)`, `saveTemplate(sceneId, name?)`, `deleteTemplate(id)`, `saveSettings(settings)`, `showBanner({ text, kind?, duration_s?, source_id? })`, `clearBanner()`, `saveTicker(ticker)`, `startCountdown(startsAt, label?)`, `startBreak(minutes, label?)`, `endCountdown()`, `startReplay(matchId, momentId)`, `stopReplay()` — each resolves to the new `Studio`; `uploadImage(file: Blob): Promise<string>`, `imageUrl(id): string`, `fetchReplay(matchId, momentId): Promise<{ moment: KeyMoment; events: MatchEvent[] }>`, `STUDIO_STREAM = "/api/studio/stream"`.
  - `studio/geometry.ts`: `CANVAS = { width: 1920, height: 1080 }`, `GRID = 20`, `MIN_SIZE = 40`, `interface Rect { x; y; width; height }`, `rectOf(element): Rect`, `sameRect(a, b): boolean`, `snap(value): number`, `clampRect(rect): Rect`, `moveBy(rect, dx, dy): Rect`, `resizeBy(rect, dw, dh): Rect`, `fitScale(width, height): number`, `raise(elements, id)`, `lower(elements, id)`, `nextLayer(elements): number`.
  - `studio/format.ts`: `formatRemaining(seconds): string`, `countdownLabel(countdown, language): string`, `tickerItems(ticker, status, stats, language): string[]`.
  - `studio/useStudio.ts`: `newer(current: Studio | null, incoming: Studio): Studio`; `useStudio(eventSource?, retryMs?): { studio: Studio | null; offset: number; connected: boolean; accept(doc: Studio): void }` where `offset` is server time minus local time in seconds; `useNow(intervalMs?): number` (local Unix seconds).
  - `test/fixtures.ts`: `element(over?)`, `scene(over?)`, `studio(over?)` builders.

- [ ] **Step 1: Add the fixtures and strings**

Append to `apps/web/src/test/fixtures.ts`:

```ts
import type { Scene, SceneElement, Studio } from "../contracts";

export const element = (over: Partial<SceneElement> = {}): SceneElement => ({
  id: "e1", type: "text", x: 100, y: 100, width: 400, height: 200, layer: 1, visible: true,
  props: { text: "Hello", size: 48, align: "center" }, ...over,
});

export const scene = (over: Partial<Scene> = {}): Scene => ({
  id: "s1", name: "Live match", template: "Live match",
  elements: [
    element({ id: "score", type: "scoreboard", x: 40, y: 40, width: 1100, height: 120, layer: 1, props: {} }),
    element({ id: "banner", type: "banner", x: 1180, y: 680, width: 700, height: 200, layer: 2, props: {} }),
  ],
  ...over,
});

export const studio = (over: Partial<Studio> = {}): Studio => ({
  revision: 1, server_time: 1000,
  scenes: [scene(), scene({ id: "s2", name: "Break", template: "Break", elements: [element({ id: "cd", type: "countdown", props: {} })] })],
  active_scene_id: "s1", previous_scene_id: null, templates: [],
  settings: { mode: "fan", language: "en", auto_banner: true, auto_start: true, auto_half_time_break: false },
  banner: null, banner_queue: [],
  ticker: { enabled: true, speed: 120, messages: [], show_score: true, show_stats: true },
  countdown: null, replay: null, ...over,
});
```

Move the new `import type` line up into the existing import from `"../contracts"` at the top of the file.

In `apps/web/src/i18n.ts`, add to each of the three language objects, after `fullTime`:

```ts
  // en
  replay: "Replay",
  kickoffIn: "Kick-off in",
  backIn: "Back in",
  // es
  replay: "Repetición",
  kickoffIn: "Comienza en",
  backIn: "Volvemos en",
  // hi
  replay: "रीप्ले",
  kickoffIn: "शुरू होने में",
  backIn: "वापसी में",
```

- [ ] **Step 2: Write the failing tests**

`apps/web/src/studio/geometry.test.ts`:

```ts
import { element } from "../test/fixtures";
import { clampRect, fitScale, lower, moveBy, nextLayer, raise, rectOf, resizeBy, sameRect, snap } from "./geometry";

const rect = { x: 100, y: 100, width: 400, height: 200 };

test("snap rounds to the 20 pixel grid", () => {
  expect([0, 9, 10, 29, 31, -9].map(snap)).toEqual([0, 0, 20, 20, 40, -0].map((v) => v + 0));
});

test("moving snaps to the grid and stays inside the canvas", () => {
  expect(moveBy(rect, 47, -33)).toEqual({ x: 140, y: 60, width: 400, height: 200 });
  expect(moveBy(rect, -5000, -5000)).toMatchObject({ x: 0, y: 0 });
  expect(moveBy(rect, 5000, 5000)).toMatchObject({ x: 1920 - 400, y: 1080 - 200 });
  expect(moveBy(rect, 4, 4)).toEqual(rect);
});

test("resizing snaps, keeps the corner, and respects the minimum and the canvas edge", () => {
  expect(resizeBy(rect, 47, 33)).toEqual({ x: 100, y: 100, width: 440, height: 240 });
  expect(resizeBy(rect, -5000, -5000)).toEqual({ x: 100, y: 100, width: 40, height: 40 });
  expect(resizeBy(rect, 5000, 5000)).toEqual({ x: 100, y: 100, width: 1820, height: 980 });
});

test("clampRect pulls a stray rectangle back onto the canvas", () => {
  expect(clampRect({ x: -50, y: 2000, width: 10, height: 5000 })).toEqual({ x: 0, y: 0, width: 40, height: 1080 });
});

test("rectOf and sameRect compare position and size only", () => {
  const item = element({ x: 1, y: 2, width: 3, height: 4 });
  expect(rectOf(item)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  expect(sameRect(rectOf(item), { x: 1, y: 2, width: 3, height: 4 })).toBe(true);
  expect(sameRect(rectOf(item), { x: 1, y: 2, width: 3, height: 5 })).toBe(false);
});

test("fitScale fits 16:9 inside any window", () => {
  expect(fitScale(1920, 1080)).toBe(1);
  expect(fitScale(960, 1080)).toBe(0.5);
  expect(fitScale(3840, 1080)).toBe(1);
  expect(fitScale(0, 0)).toBe(0);
});

test("raise and lower swap an element with its neighbour in the stack", () => {
  const stack = [element({ id: "a", layer: 1 }), element({ id: "b", layer: 2 }), element({ id: "c", layer: 5 })];
  const layers = (items: typeof stack) => Object.fromEntries(items.map((item) => [item.id, item.layer]));
  expect(layers(raise(stack, "a"))).toEqual({ a: 2, b: 1, c: 5 });
  expect(layers(lower(stack, "c"))).toEqual({ a: 1, b: 5, c: 2 });
  expect(raise(stack, "c")).toBe(stack);
  expect(lower(stack, "a")).toBe(stack);
  expect(raise(stack, "missing")).toBe(stack);
  expect(nextLayer(stack)).toBe(6);
  expect(nextLayer([])).toBe(1);
});
```

`apps/web/src/studio/format.test.ts`:

```ts
import { stats, status, studio } from "../test/fixtures";
import { countdownLabel, formatRemaining, tickerItems } from "./format";

test.each([
  [0, "0:00"], [-5, "0:00"], [9.2, "0:10"], [59, "0:59"], [60, "1:00"], [754, "12:34"], [3600, "1:00:00"], [3725, "1:02:05"],
])("formatRemaining(%d) is %s", (seconds, expected) => {
  expect(formatRemaining(seconds)).toBe(expected);
});

test("a countdown uses its own label, or a localized default for its kind", () => {
  expect(countdownLabel({ kind: "start", ends_at: 0, label: "Doors open" }, "en")).toBe("Doors open");
  expect(countdownLabel({ kind: "start", ends_at: 0, label: "" }, "en")).toBe("Kick-off in");
  expect(countdownLabel({ kind: "break", ends_at: 0, label: "" }, "es")).toBe("Volvemos en");
  expect(countdownLabel({ kind: "break", ends_at: 0, label: "  " }, "hi")).toBe("वापसी में");
});

test("the ticker carries the streamer's messages, then the score and stats lines", () => {
  const ticker = { ...studio().ticker, messages: ["Welcome", "Subscribe"] };
  const live = status({ score_home: 2, score_away: 1 });
  const numbers = stats({ shots: 7, possession: 61.5 }, { shots: 2, possession: 38.5 });
  expect(tickerItems(ticker, live, numbers, "en")).toEqual([
    "Welcome", "Subscribe", "Northbridge FC 2-1 Harbour City", "Shots 7-2 · Possession % 61.5-38.5",
  ]);
  expect(tickerItems(ticker, live, numbers, "es")[3]).toBe("Remates 7-2 · Posesión % 61.5-38.5");
});

test("automatic ticker lines can be switched off and need match data", () => {
  const base = studio().ticker;
  expect(tickerItems({ ...base, show_score: false, show_stats: false }, status(), stats(), "en")).toEqual([]);
  expect(tickerItems(base, null, null, "en")).toEqual([]);
  expect(tickerItems({ ...base, enabled: false, messages: ["Hi"] }, status(), stats(), "en")).toEqual([]);
});
```

`apps/web/src/studio/useStudio.test.tsx`:

```tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { FakeEventSource, FakeEventSourceCtor, studio } from "../test/fixtures";
import { newer, useStudio } from "./useStudio";

beforeEach(() => {
  FakeEventSource.instances = [];
});

const push = (doc: ReturnType<typeof studio>) => act(() => FakeEventSource.last.emitRaw(JSON.stringify(doc)));

test("newer keeps the document with the higher revision", () => {
  const two = studio({ revision: 2 });
  expect(newer(null, two)).toBe(two);
  expect(newer(two, studio({ revision: 1 }))).toBe(two);
  expect(newer(two, studio({ revision: 2 }))).toBe(two);
  const three = studio({ revision: 3 });
  expect(newer(two, three)).toBe(three);
});

test("it opens the studio stream and follows it, ignoring stale documents", () => {
  const { result } = renderHook(() => useStudio(FakeEventSourceCtor, 10));
  expect(FakeEventSource.last.url).toBe("/api/studio/stream");
  expect(result.current.studio).toBeNull();
  act(() => FakeEventSource.last.open());
  push(studio({ revision: 4 }));
  expect(result.current.studio?.revision).toBe(4);
  expect(result.current.connected).toBe(true);
  push(studio({ revision: 3, active_scene_id: "s2" }));
  expect(result.current.studio?.active_scene_id).toBe("s1");
  push(studio({ revision: 5, active_scene_id: "s2" }));
  expect(result.current.studio?.active_scene_id).toBe("s2");
});

test("the first document after a reconnect is taken even if its revision is lower", () => {
  const { result } = renderHook(() => useStudio(FakeEventSourceCtor, 10));
  act(() => FakeEventSource.last.open());
  push(studio({ revision: 40 }));
  act(() => FakeEventSource.last.fail(0));
  expect(result.current.connected).toBe(false);
  act(() => FakeEventSource.last.open());
  push(studio({ revision: 0, active_scene_id: "s2" }));
  expect(result.current.studio).toMatchObject({ revision: 0, active_scene_id: "s2" });
});

test("a refused stream is reopened after a pause", async () => {
  renderHook(() => useStudio(FakeEventSourceCtor, 10));
  const first = FakeEventSource.last;
  act(() => first.fail(2));
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
  expect(first.closed).toBe(true);
});

test("accept applies the answer to a change at once, unless the stream is already ahead", () => {
  const { result } = renderHook(() => useStudio(FakeEventSourceCtor, 10));
  act(() => FakeEventSource.last.open());
  push(studio({ revision: 5 }));
  act(() => result.current.accept(studio({ revision: 6, active_scene_id: "s2" })));
  expect(result.current.studio?.active_scene_id).toBe("s2");
  act(() => result.current.accept(studio({ revision: 4, active_scene_id: "s1" })));
  expect(result.current.studio?.active_scene_id).toBe("s2");
});

test("offset is the server clock minus this machine's clock", () => {
  vi.spyOn(Date, "now").mockReturnValue(2_000_000);
  const { result } = renderHook(() => useStudio(FakeEventSourceCtor, 10));
  act(() => FakeEventSource.last.open());
  push(studio({ server_time: 2_090 }));
  expect(result.current.offset).toBe(90);
});

test("garbage on the stream is ignored", () => {
  const { result } = renderHook(() => useStudio(FakeEventSourceCtor, 10));
  act(() => FakeEventSource.last.open());
  act(() => FakeEventSource.last.emitRaw("{oops"));
  act(() => FakeEventSource.last.emitRaw("42"));
  expect(result.current.studio).toBeNull();
});
```

`apps/web/src/studio/api.test.ts`:

```ts
import { scene, studio } from "../test/fixtures";
import {
  activateScene, fetchReplay, imageUrl, saveScene, showBanner, startBreak, startCountdown, StudioRequestError, uploadImage,
} from "./api";

function serve(statusCode: number, body: unknown) {
  const mock = vi.fn(async () => new Response(JSON.stringify(body), { status: statusCode, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", mock);
  return () => {
    const [url, init] = mock.mock.calls[mock.mock.calls.length - 1] as unknown as [string, RequestInit | undefined];
    return { url, method: init?.method, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body };
  };
}

test("changes are sent to their route and resolve to the new document", async () => {
  const last = serve(200, studio({ revision: 9 }));
  expect((await activateScene("s2")).revision).toBe(9);
  expect(last()).toEqual({ url: "/api/studio/scenes/s2/activate", method: "POST", body: undefined });

  await saveScene(scene());
  expect(last()).toMatchObject({ url: "/api/studio/scenes/s1", method: "PUT", body: { name: "Live match" } });
  expect(last().body).not.toHaveProperty("id");

  await showBanner({ text: "Hello", kind: "info", source_id: "n1" });
  expect(last()).toEqual({ url: "/api/studio/banner", method: "POST", body: { text: "Hello", kind: "info", source_id: "n1" } });

  await startCountdown(1234.5);
  expect(last().body).toEqual({ kind: "start", starts_at: 1234.5, label: "" });
  await startBreak(5, "Back soon");
  expect(last().body).toEqual({ kind: "break", minutes: 5, label: "Back soon" });
});

test("a refusal carries the status, the field and the server's message", async () => {
  serve(422, { detail: [{ loc: ["body", "minutes"], msg: "A break lasts 1 to 60 minutes.", type: "studio" }] });
  const error = await startBreak(0).catch((caught) => caught);
  expect(error).toBeInstanceOf(StudioRequestError);
  expect([error.status, error.field, error.message]).toEqual([422, "minutes", "A break lasts 1 to 60 minutes."]);
});

test("a failure with no readable body still gives a usable message", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("Bad gateway", { status: 502 })));
  const error = await activateScene("s1").catch((caught) => caught);
  expect([error.status, error.field, error.message]).toEqual([502, null, "The request failed (502)."]);
});

test("images are uploaded as raw bytes and addressed by id", async () => {
  const last = serve(201, { id: "abc.png" });
  const file = new Blob([new Uint8Array([1, 2, 3])]);
  expect(await uploadImage(file)).toBe("abc.png");
  expect(last()).toMatchObject({ url: "/api/studio/images", method: "POST", body: file });
  expect(imageUrl("a b.png")).toBe("/api/studio/images/a%20b.png");
});

test("replay events are fetched for a match and moment", async () => {
  const last = serve(200, { moment: {}, events: [] });
  await fetchReplay("m 1", "m-1-k1");
  expect(last().url).toBe("/api/matches/m%201/moments/m-1-k1/replay");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test src/studio`
Expected: all four files fail to resolve their modules.

- [ ] **Step 4: Write geometry and formatting**

`apps/web/src/studio/geometry.ts`:

```ts
import type { SceneElement } from "../contracts";

export const CANVAS = { width: 1920, height: 1080 };
export const GRID = 20;
export const MIN_SIZE = 40;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export const snap = (value: number): number => Math.round(value / GRID) * GRID + 0;

export const rectOf = (element: SceneElement): Rect => ({
  x: element.x, y: element.y, width: element.width, height: element.height,
});

export const sameRect = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Sizes first, then position, so an oversized rectangle ends up filling the canvas. */
export function clampRect(rect: Rect): Rect {
  const width = clamp(rect.width, MIN_SIZE, CANVAS.width);
  const height = clamp(rect.height, MIN_SIZE, CANVAS.height);
  return { x: clamp(rect.x, 0, CANVAS.width - width), y: clamp(rect.y, 0, CANVAS.height - height), width, height };
}

export function moveBy(rect: Rect, dx: number, dy: number): Rect {
  return clampRect({ ...rect, x: rect.x + snap(dx), y: rect.y + snap(dy) });
}

/** Resizes from the bottom-right corner; the top-left corner stays where it is. */
export function resizeBy(rect: Rect, dw: number, dh: number): Rect {
  return {
    ...rect,
    width: clamp(rect.width + snap(dw), MIN_SIZE, CANVAS.width - rect.x),
    height: clamp(rect.height + snap(dh), MIN_SIZE, CANVAS.height - rect.y),
  };
}

export function fitScale(width: number, height: number): number {
  return Math.max(0, Math.min(width / CANVAS.width, height / CANVAS.height));
}

function swapWithNeighbour(elements: SceneElement[], id: string, direction: 1 | -1): SceneElement[] {
  const ordered = [...elements].sort((a, b) => a.layer - b.layer);
  const index = ordered.findIndex((element) => element.id === id);
  const neighbour = ordered[index + direction];
  if (index === -1 || neighbour === undefined) return elements;
  const mine = ordered[index].layer;
  return elements.map((element) =>
    element.id === id ? { ...element, layer: neighbour.layer } : element.id === neighbour.id ? { ...element, layer: mine } : element,
  );
}

export const raise = (elements: SceneElement[], id: string) => swapWithNeighbour(elements, id, 1);
export const lower = (elements: SceneElement[], id: string) => swapWithNeighbour(elements, id, -1);
export const nextLayer = (elements: SceneElement[]) => Math.max(0, ...elements.map((element) => element.layer)) + 1;
```

`apps/web/src/studio/format.ts`:

```ts
import type { Countdown, MatchStatus, StatsSnapshot, Ticker } from "../contracts";
import { type Language, t } from "../i18n";

/** Remaining time as m:ss, or h:mm:ss from an hour up. Never negative. */
export function formatRemaining(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function countdownLabel(countdown: Countdown, language: Language): string {
  return countdown.label.trim() || t(language, countdown.kind === "start" ? "kickoffIn" : "backIn");
}

/** What the ticker scrolls: the streamer's messages, then the automatic lines that are switched on. */
export function tickerItems(ticker: Ticker, status: MatchStatus | null, stats: StatsSnapshot | null, language: Language): string[] {
  if (!ticker.enabled) return [];
  const items = [...ticker.messages];
  if (ticker.show_score && status) {
    items.push(`${status.home.name} ${status.score_home}-${status.score_away} ${status.away.name}`);
  }
  if (ticker.show_stats && stats) {
    items.push(
      `${t(language, "shots")} ${stats.home.shots}-${stats.away.shots} · ` +
        `${t(language, "possession")} ${stats.home.possession}-${stats.away.possession}`,
    );
  }
  return items;
}
```

- [ ] **Step 5: Write the studio client and the live hook**

`apps/web/src/studio/api.ts`:

```ts
import type { KeyMoment, MatchEvent, Scene, Studio, StudioSettings, Ticker } from "../contracts";

export const STUDIO_STREAM = "/api/studio/stream";

/** A change the studio refused, or a request that failed. `field` names what was wrong, when known. */
export class StudioRequestError extends Error {
  readonly status: number;
  readonly field: string | null;

  constructor(status: number, field: string | null, message: string) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

async function toError(response: Response): Promise<StudioRequestError> {
  let field: string | null = null;
  let message = `The request failed (${response.status}).`;
  try {
    const body = (await response.json()) as { detail?: { loc?: unknown[]; msg?: unknown }[] };
    const first = Array.isArray(body.detail) ? body.detail[0] : undefined;
    if (first) {
      const last = first.loc?.[first.loc.length - 1];
      field = typeof last === "string" ? last : null;
      message = typeof first.msg === "string" ? first.msg : message;
    }
  } catch {
    // Not JSON: keep the generic message.
  }
  return new StudioRequestError(response.status, field, message);
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(path, init);
  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

const change = (method: string, path: string, body?: unknown) => send<Studio>(method, `/api/studio${path}`, body);
const id = encodeURIComponent;

export const getStudio = () => change("GET", "");
export const createScene = (source: "builtin" | "template" | "scene", ref: string, name?: string) =>
  change("POST", "/scenes", name ? { source, ref, name } : { source, ref });
export const saveScene = (scene: Pick<Scene, "id" | "name" | "elements">) =>
  change("PUT", `/scenes/${id(scene.id)}`, { name: scene.name, elements: scene.elements });
export const deleteScene = (sceneId: string) => change("DELETE", `/scenes/${id(sceneId)}`);
export const activateScene = (sceneId: string) => change("POST", `/scenes/${id(sceneId)}/activate`);
export const saveTemplate = (sceneId: string, name?: string) =>
  change("POST", "/templates", name ? { scene_id: sceneId, name } : { scene_id: sceneId });
export const deleteTemplate = (templateId: string) => change("DELETE", `/templates/${id(templateId)}`);
export const saveSettings = (settings: StudioSettings) => change("PUT", "/settings", settings);
export const showBanner = (banner: { text: string; kind?: "custom" | "info" | "goal" | "card"; duration_s?: number; source_id?: string }) =>
  change("POST", "/banner", banner);
export const clearBanner = () => change("DELETE", "/banner");
export const saveTicker = (ticker: Ticker) => change("PUT", "/ticker", ticker);
export const startCountdown = (startsAt: number, label = "") =>
  change("POST", "/countdown", { kind: "start", starts_at: startsAt, label });
export const startBreak = (minutes: number, label = "") => change("POST", "/countdown", { kind: "break", minutes, label });
export const endCountdown = () => change("DELETE", "/countdown");
export const startReplay = (matchId: string, momentId: string) =>
  change("POST", "/replay", { match_id: matchId, moment_id: momentId });
export const stopReplay = () => change("DELETE", "/replay");

export async function uploadImage(file: Blob): Promise<string> {
  const response = await fetch("/api/studio/images", { method: "POST", body: file });
  if (!response.ok) throw await toError(response);
  return ((await response.json()) as { id: string }).id;
}

export const imageUrl = (imageId: string) => `/api/studio/images/${id(imageId)}`;

export const fetchReplay = (matchId: string, momentId: string) =>
  send<{ moment: KeyMoment; events: MatchEvent[] }>("GET", `/api/matches/${id(matchId)}/moments/${id(momentId)}/replay`);
```

`apps/web/src/studio/useStudio.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import type { Studio } from "../contracts";
import { STUDIO_STREAM } from "./api";

const CLOSED = 2;

/** The document to keep: the incoming one only if its revision is higher. */
export function newer(current: Studio | null, incoming: Studio): Studio {
  return current === null || incoming.revision > current.revision ? incoming : current;
}

function isStudio(value: unknown): value is Studio {
  return value !== null && typeof value === "object" && typeof (value as Studio).revision === "number";
}

/**
 * The studio document, kept live from the server's stream.
 *
 * The first document after each (re)connection is authoritative even if its revision is
 * lower: the server may have restarted from an older or reset file.
 */
export function useStudio(EventSourceImpl?: new (url: string) => EventSource, retryMs = 2000) {
  const [studio, setStudio] = useState<Studio | null>(null);
  const [offset, setOffset] = useState(0);
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const take = useCallback((doc: Studio, authoritative: boolean) => {
    setStudio((current) => (authoritative ? doc : newer(current, doc)));
    setOffset(doc.server_time - Date.now() / 1000);
  }, []);

  const accept = useCallback((doc: Studio) => take(doc, false), [take]);

  useEffect(() => {
    const source = new (EventSourceImpl ?? EventSource)(STUDIO_STREAM);
    let first = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    source.onopen = () => {
      first = true;
      setConnected(true);
    };
    source.onmessage = (message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        return;
      }
      if (!isStudio(parsed)) return;
      take(parsed, first);
      first = false;
    };
    source.onerror = () => {
      setConnected(false);
      // The browser retries a dropped stream itself. One the server refused stays closed.
      if (source.readyState === CLOSED) retry = setTimeout(() => setAttempt((count) => count + 1), retryMs);
    };
    return () => {
      clearTimeout(retry);
      source.close();
    };
  }, [EventSourceImpl, take, attempt, retryMs]);

  return { studio, offset, connected, accept };
}

/** This machine's clock in Unix seconds, refreshed on an interval. Add `offset` for server time. */
export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
```

- [ ] **Step 6: Run the studio tests to verify they pass**

Run: `pnpm test src/studio`
Expected: 4 files pass.

- [ ] **Step 7: Extract the shared match hook**

`apps/web/src/stream/useCurrentMatch.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchCurrentMatch, streamUrl } from "../api";
import type { ViewerProfile } from "../contracts";
import { connect } from "./client";
import { useMatch } from "./store";

export interface CurrentMatchOptions {
  /** Injected by tests; the browser's EventSource is used otherwise. */
  eventSource?: new (url: string) => EventSource;
  /** Delay before retrying when the server cannot be reached. */
  retryMs?: number;
  /** How often to check for a new match while there is none, or the current one has finished. */
  pollMs?: number;
}

/**
 * Follows whichever match the server considers current and keeps one stream open for the
 * given profile, feeding the shared match store. With a null profile no stream is opened.
 */
export function useCurrentMatch(
  profile: ViewerProfile | null,
  { eventSource, retryMs = 2000, pollMs = 3000 }: CurrentMatchOptions = {},
) {
  const [matchId, setMatchId] = useState<string | null>(null);
  // Bumped to reopen the stream for the same match after the server refused it.
  const [attempt, setAttempt] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const connection = useMatch((state) => state.connection);
  const matchState = useMatch((state) => state.data.status?.state);

  const joinCurrent = useCallback(
    async (reopen = false) => {
      clearTimeout(retryTimer.current);
      try {
        const current = await fetchCurrentMatch();
        setMatchId(current);
        if (current === null) useMatch.getState().setConnection("idle");
        else if (reopen) setAttempt((count) => count + 1);
      } catch {
        useMatch.getState().setConnection("reconnecting");
        retryTimer.current = setTimeout(() => void joinCurrent(reopen), retryMs);
      }
    },
    [retryMs],
  );

  useEffect(() => () => clearTimeout(retryTimer.current), []);

  useEffect(() => {
    void joinCurrent();
  }, [joinCurrent]);

  // One stream per (match, profile). Changing either replays the match in the new variant.
  useEffect(() => {
    if (matchId === null || profile === null) return;
    const { apply, reset, setConnection } = useMatch.getState();
    reset();
    return connect(streamUrl(matchId, profile), { onEnvelope: apply, onConnection: setConnection }, eventSource);
  }, [matchId, profile, eventSource, attempt]);

  // A replaced match: move to the current one.
  useEffect(() => {
    if (matchState === "abandoned") void joinCurrent();
  }, [matchState, joinCurrent]);

  // A stream the server refused stays closed. After a pause, ask what is current and reopen.
  useEffect(() => {
    if (connection !== "no_match") return;
    const timer = setTimeout(() => void joinCurrent(true), retryMs);
    return () => clearTimeout(timer);
  }, [connection, joinCurrent, retryMs]);

  // With no match, or a finished one, nothing more will arrive: check now and then for the next.
  const waiting = matchId === null || matchState === "finished";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void joinCurrent(), pollMs);
    return () => clearInterval(timer);
  }, [waiting, joinCurrent, pollMs]);

  return { matchId, setMatchId };
}
```

In `apps/web/src/App.tsx`:

1. Change the React import to `import { useEffect, useState } from "react";`.
2. In the import from `"./api"`, remove `fetchCurrentMatch` and `streamUrl`. Remove the import of `connect` from `"./stream/client"`. Add `import { useCurrentMatch } from "./stream/useCurrentMatch";`.
3. Remove these from the component body: the `matchId` state, the `attempt` state, the `retryTimer` ref, `joinCurrent`, the cleanup effect for `retryTimer`, the stream effect, the `abandoned` effect, the `no_match` effect and the `finished` effect.
4. Replace the first effect (teams and `joinCurrent`) and add the hook, so the block after `const language = profile.language;` reads:

```tsx
  const { matchId, setMatchId } = useCurrentMatch(profile, { eventSource, retryMs, pollMs });

  useEffect(() => {
    fetchTeams().then(setTeams).catch(() => setTeams(null));
  }, []);

  // A new stream replays the match, recaps included; do not reopen one the viewer already saw.
  useEffect(() => {
    setOpenRecap(null);
  }, [matchId, profile]);
```

Everything from `const latestRecap` onward is unchanged.

- [ ] **Step 8: Choose the page from the URL**

`apps/web/src/main.tsx`:

```tsx
import { FluentProvider } from "@fluentui/react-components";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { useSystemTheme } from "./theme";

/** The three pages. `/studio` and `/program` are added in the studio tasks. */
function Page() {
  return <App />;
}

function Root() {
  return (
    <FluentProvider theme={useSystemTheme()} style={{ minHeight: "100%" }}>
      <Page />
    </FluentProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
```

- [ ] **Step 9: Run every web test and the type check**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass, including the unchanged `App.test.tsx` (it covers the extracted hook) and `i18n.test.ts` (the three new strings exist in every language); no type errors.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src
git commit -m "feat: add studio client, canvas geometry and a shared current-match hook"
```

---

### Task 7: Program elements, scene canvas and the program page

**Files:**
- Create: `apps/web/src/studio/elements.tsx`, `apps/web/src/studio/SceneCanvas.tsx`, `apps/web/src/studio/ProgramPage.tsx`
- Modify: `apps/web/src/components/Pitch.tsx` (a `fill` option), `apps/web/src/main.tsx` (the `/program` route)
- Test: `apps/web/src/studio/elements.test.tsx`, `SceneCanvas.test.tsx`, `ProgramPage.test.tsx`

**Interfaces:**
- Consumes: Task 6; cycle 1 `Pitch`, `StatsPanel`, `Timeline`, `stream/store.ts`.
- Produces:
  - `studio/elements.tsx`: `interface ProgramData { match: MatchData; studio: Studio; now: number; language: Language }` (`now` is server time in Unix seconds); `ElementView({ element: SceneElement, data: ProgramData })`. Test IDs: `program-score`, `program-banner` (with `data-kind`), `program-ticker`, `program-countdown`, `program-replay`, `program-recap`, `program-image`.
  - `studio/SceneCanvas.tsx`: `SceneCanvas({ scene, data, scale, editable?, selectedId?, onSelect?(id | null), onChange?(elements) })`. Draws each element in a box with `data-testid="element-<type>"` and `data-element-id`. In program mode hidden elements are not drawn. With `editable`, each box gets a move handle (`role="button"`, name `<type> element`) and a resize handle (name `Resize <type> element`); a finished gesture calls `onChange` once with the whole element list, only if something moved.
  - `studio/ProgramPage.tsx`: `ProgramPage({ eventSource?, retryMs?, pollMs? })` (`data-testid="program"`), and `withReplayFallback(scene: Scene, studio: Studio): Scene`.
  - `Pitch` gains `fill?: boolean`: fit the box's height as well as its width.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/studio/elements.test.tsx`:

```tsx
import { act, screen, waitFor } from "@testing-library/react";
import type { SceneElement } from "../contracts";
import { EMPTY, type MatchData } from "../stream/store";
import { element, matchEvent, narrative, recap, stats, status, studio } from "../test/fixtures";
import { renderUi } from "../test/render";
import { ElementView, type ProgramData } from "./elements";

const live: MatchData = {
  ...EMPTY, minute: 37, status: status({ score_home: 2, score_away: 1, minute: 30 }), stats: stats({ shots: 7 }, { shots: 2 }),
  narratives: [
    { ...narrative({ id: "n3", minute: 37, text: "Third line" }), highlighted: false },
    { ...narrative({ id: "n2", minute: 30, text: "Second line" }), highlighted: false },
    { ...narrative({ id: "n1", minute: 12, text: "First line" }), highlighted: false },
  ],
  recaps: [recap()],
};

function show(type: SceneElement["type"], over: Partial<ProgramData> = {}, props: Record<string, unknown> = {}) {
  const data: ProgramData = { match: live, studio: studio(), now: 1000, language: "en", ...over };
  return renderUi(<ElementView element={element({ type, props })} data={data} />);
}

test("the scoreboard shows teams, score and the running clock", () => {
  show("scoreboard");
  expect(screen.getByTestId("program-score").textContent).toBe("2 - 1");
  expect(screen.getByText("Northbridge FC")).toBeTruthy();
  expect(screen.getByText("37'")).toBeTruthy();
});

test("the scoreboard holds its box when there is no match", () => {
  show("scoreboard", { match: EMPTY });
  expect(screen.getByTestId("program-score").textContent).toBe("–");
});

test("narration shows the newest lines up to the number asked for", () => {
  show("narration", {}, { lines: 2 });
  expect(screen.getByText("Third line")).toBeTruthy();
  expect(screen.getByText("Second line")).toBeTruthy();
  expect(screen.queryByText("First line")).toBeNull();
});

test("narration with nothing to say explains itself in the program language", () => {
  show("narration", { match: EMPTY, language: "es" });
  expect(screen.getByText("Las narraciones aparecen aquí cuando ocurren momentos clave.")).toBeTruthy();
});

test("the banner shows the current message with its kind, and nothing when there is none", () => {
  const { unmount } = show("banner", { studio: studio({ banner: { id: "b", text: "GOAL!", kind: "goal", duration_s: 8, ends_at: 1008, source_id: null } }) });
  expect(screen.getByTestId("program-banner").textContent).toBe("GOAL!");
  expect(screen.getByTestId("program-banner").getAttribute("data-kind")).toBe("goal");
  unmount();
  show("banner");
  expect(screen.queryByTestId("program-banner")).toBeNull();
});

test("the ticker scrolls its items and is empty when switched off", () => {
  const { unmount } = show("ticker", { studio: studio({ ticker: { ...studio().ticker, messages: ["Welcome"] } }) });
  expect(screen.getByTestId("program-ticker").textContent).toContain("Welcome");
  expect(screen.getByTestId("program-ticker").textContent).toContain("Northbridge FC 2-1 Harbour City");
  unmount();
  show("ticker", { studio: studio({ ticker: { ...studio().ticker, enabled: false } }) });
  expect(screen.queryByTestId("program-ticker")).toBeNull();
});

test("the countdown shows the time left on the server's clock", () => {
  const counting = studio({ countdown: { kind: "break", ends_at: 1125, label: "" } });
  const { unmount } = show("countdown", { studio: counting, now: 1000 });
  expect(screen.getByTestId("program-countdown").textContent).toBe("Back in2:05");
  unmount();
  show("countdown", { studio: counting, now: 5000 });
  expect(screen.getByTestId("program-countdown").textContent).toBe("Back in0:00");
});

test("with no countdown running the element is empty", () => {
  show("countdown");
  expect(screen.queryByTestId("program-countdown")).toBeNull();
});

test("the recap shows the latest recap, and nothing before one exists", () => {
  const { unmount } = show("recap");
  expect(screen.getByTestId("program-recap").textContent).toContain("Half-time: Northbridge FC 1-0 Harbour City");
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  unmount();
  show("recap", { match: EMPTY });
  expect(screen.queryByTestId("program-recap")).toBeNull();
});

test("text is drawn with its size and alignment", () => {
  show("text", {}, { text: "Kick-off soon", size: 96, align: "left" });
  const text = screen.getByText("Kick-off soon");
  expect(text.style.fontSize).toBe("96px");
  expect(text.style.textAlign).toBe("left");
});

test("an image is drawn from the image store, and a missing one shows a placeholder", () => {
  const { unmount } = show("image", {}, { image_id: "abc.png", fit: "cover" });
  const image = screen.getByTestId("program-image") as HTMLImageElement;
  expect(image.getAttribute("src")).toBe("/api/studio/images/abc.png");
  expect(image.style.objectFit).toBe("cover");
  act(() => image.dispatchEvent(new Event("error")));
  expect(screen.queryByTestId("program-image")).toBeNull();
  unmount();
  show("image", {}, { image_id: null, fit: "contain" });
  expect(screen.queryByTestId("program-image")).toBeNull();
});

test("stats, pitch and timeline are drawn from the match", () => {
  show("stats");
  expect(screen.getByTestId("stat-shots").textContent).toContain("7");
  show("pitch", { match: { ...live, events: [matchEvent()] } }, { pressure: true });
  expect(screen.getAllByTestId("marker")).toHaveLength(1);
  show("timeline");
  const marker = screen.getByTitle("Half-time recap");
  expect(marker.closest("[inert]")).not.toBeNull();
});

test("a replay fetches the moment's events and reveals them as it plays", async () => {
  const events = Array.from({ length: 4 }, (_, index) => matchEvent({ id: `e${index}`, seq: index }));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ moment: {}, events }), { status: 200 })));
  const replay = { match_id: "m-1", moment_id: "m-1-k1", minute: 23, started_at: 1000, duration_s: 8 };
  const { rerender } = show("replay", { studio: studio({ replay }), now: 1002 });
  await waitFor(() => expect(screen.getAllByTestId("marker")).toHaveLength(1));
  expect(screen.getByTestId("program-replay").textContent).toContain("Replay · 23'");
  const later: ProgramData = { match: live, studio: studio({ replay }), now: 1008, language: "en" };
  rerender(<ElementView element={element({ type: "replay", props: {} })} data={later} />);
  expect(screen.getAllByTestId("marker")).toHaveLength(4);
});

test("with no replay playing the element is empty", () => {
  show("replay");
  expect(screen.queryByTestId("program-replay")).toBeNull();
});
```

`apps/web/src/studio/SceneCanvas.test.tsx`:

```tsx
import { fireEvent, screen } from "@testing-library/react";
import { EMPTY } from "../stream/store";
import { element, scene, studio } from "../test/fixtures";
import { renderUi } from "../test/render";
import type { ProgramData } from "./elements";
import { SceneCanvas } from "./SceneCanvas";

const data: ProgramData = { match: EMPTY, studio: studio(), now: 1000, language: "en" };
const layout = scene({
  elements: [
    element({ id: "a", type: "text", x: 100, y: 100, width: 400, height: 200, layer: 2 }),
    element({ id: "b", type: "countdown", x: 800, y: 100, width: 400, height: 200, layer: 1, props: {} }),
    element({ id: "c", type: "banner", x: 100, y: 600, width: 400, height: 200, layer: 3, visible: false, props: {} }),
  ],
});

function edit(scale = 0.5) {
  const handlers = { onSelect: vi.fn(), onChange: vi.fn() };
  renderUi(<SceneCanvas scene={layout} data={data} scale={scale} editable selectedId="a" {...handlers} />);
  return handlers;
}

const drag = (handle: HTMLElement, dx: number, dy: number) => {
  fireEvent.pointerDown(handle, { clientX: 300, clientY: 300, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 300 + dx / 2, clientY: 300 + dy / 2, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 300 + dx, clientY: 300 + dy, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientX: 300 + dx, clientY: 300 + dy, pointerId: 1 });
};

test("the program draws visible elements at their place, stacked by layer", () => {
  renderUi(<SceneCanvas scene={layout} data={data} scale={0.5} />);
  const text = screen.getByTestId("element-text");
  expect([text.style.left, text.style.top, text.style.width, text.style.height]).toEqual(["100px", "100px", "400px", "200px"]);
  expect([text.style.zIndex, screen.getByTestId("element-countdown").style.zIndex]).toEqual(["2", "1"]);
  expect(screen.queryByTestId("element-banner")).toBeNull();
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  const canvas = screen.getByTestId("scene-canvas");
  expect([canvas.style.width, canvas.style.height]).toEqual(["960px", "540px"]);
});

test("the editor shows hidden elements too, with a handle on each", () => {
  edit();
  expect(screen.getByTestId("element-banner")).toBeTruthy();
  expect(screen.getByRole("button", { name: "text element" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "banner element" }).getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByRole("button", { name: "Resize text element" })).toBeTruthy();
});

test("dragging moves an element by the pointer distance in canvas pixels, snapped to the grid", () => {
  const handlers = edit(0.5);
  drag(screen.getByRole("button", { name: "text element" }), 53, -27);
  expect(handlers.onChange).toHaveBeenCalledOnce();
  const moved = handlers.onChange.mock.calls[0][0];
  expect(moved.find((item: { id: string }) => item.id === "a")).toMatchObject({ x: 200, y: 40, width: 400, height: 200 });
  expect(moved.filter((item: { id: string }) => item.id !== "a")).toEqual(layout.elements.filter((item) => item.id !== "a"));
});

test("the box follows the pointer while the drag is in progress", () => {
  edit(1);
  const handle = screen.getByRole("button", { name: "text element" });
  fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 100, clientY: 60, pointerId: 1 });
  expect(screen.getByTestId("element-text").style.left).toBe("200px");
  expect(screen.getByTestId("element-text").style.top).toBe("160px");
  fireEvent.pointerUp(handle, { clientX: 100, clientY: 60, pointerId: 1 });
});

test("dragging the corner handle resizes", () => {
  const handlers = edit(1);
  drag(screen.getByRole("button", { name: "Resize text element" }), 100, 60);
  expect(handlers.onChange.mock.calls[0][0].find((item: { id: string }) => item.id === "a")).toMatchObject({
    x: 100, y: 100, width: 500, height: 260,
  });
});

test("a drag cannot push an element off the canvas", () => {
  const handlers = edit(1);
  drag(screen.getByRole("button", { name: "text element" }), -9000, 9000);
  expect(handlers.onChange.mock.calls[0][0].find((item: { id: string }) => item.id === "a")).toMatchObject({ x: 0, y: 880 });
});

test("a click that does not move the element selects it without saving", () => {
  const handlers = edit(1);
  drag(screen.getByRole("button", { name: "countdown element" }), 3, 3);
  expect(handlers.onSelect).toHaveBeenCalledWith("b");
  expect(handlers.onChange).not.toHaveBeenCalled();
});

test("arrow keys move by one grid step and Shift with arrows resizes", () => {
  const handlers = edit(1);
  const handle = screen.getByRole("button", { name: "text element" });
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(handlers.onChange.mock.calls[0][0].find((item: { id: string }) => item.id === "a")).toMatchObject({ x: 120, y: 100 });
  fireEvent.keyDown(handle, { key: "ArrowUp", shiftKey: true });
  expect(handlers.onChange.mock.calls[1][0].find((item: { id: string }) => item.id === "a")).toMatchObject({ width: 400, height: 180 });
  fireEvent.keyDown(handle, { key: "Enter" });
  expect(handlers.onChange).toHaveBeenCalledTimes(2);
});

test("clicking the empty canvas clears the selection", () => {
  const handlers = edit(1);
  fireEvent.pointerDown(screen.getByTestId("scene-canvas"), { clientX: 5, clientY: 5, pointerId: 1 });
  expect(handlers.onSelect).toHaveBeenCalledWith(null);
});
```

`apps/web/src/studio/ProgramPage.test.tsx`:

```tsx
import { act, screen, waitFor } from "@testing-library/react";
import { useMatch } from "../stream/store";
import {
  element, envelope, FakeEventSource, FakeEventSourceCtor, scene, status, studio,
} from "../test/fixtures";
import { renderUi } from "../test/render";
import { ProgramPage, withReplayFallback } from "./ProgramPage";

const stream = (path: string) => FakeEventSource.instances.filter((source) => source.url.startsWith(path) && !source.closed).at(-1);

function serve(current: string | null) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const reply = (statusCode: number, body: unknown) => new Response(JSON.stringify(body), { status: statusCode });
    if (url === "/api/matches/current") return current ? reply(200, { match_id: current }) : reply(404, {});
    return reply(404, {});
  }));
}

beforeEach(() => {
  FakeEventSource.instances = [];
  useMatch.setState({ data: useMatch.getInitialState().data, connection: "idle", selectedId: null });
});

const push = (doc: ReturnType<typeof studio>) =>
  act(() => {
    const source = stream("/api/studio/stream")!;
    source.open();
    source.emitRaw(JSON.stringify(doc));
  });

test("before the studio document arrives the page is blank, with no controls", () => {
  serve(null);
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  expect(screen.getByTestId("program").textContent).toBe("");
  expect(screen.queryAllByRole("button")).toHaveLength(0);
});

test("it shows the active scene and cuts when the active scene changes", () => {
  serve(null);
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push(studio());
  expect(screen.getByTestId("element-scoreboard")).toBeTruthy();
  expect(screen.queryByTestId("element-countdown")).toBeNull();
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  push(studio({ revision: 2, active_scene_id: "s2" }));
  expect(screen.getByTestId("element-countdown")).toBeTruthy();
  expect(screen.queryByTestId("element-scoreboard")).toBeNull();
});

test("with no match the scene still holds its elements in place", () => {
  serve(null);
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push(studio());
  expect(screen.getByTestId("program-score").textContent).toBe("–");
  expect(screen.getByTestId("element-banner").style.width).toBe("700px");
});

test("it follows the current match in the studio's mode and language", async () => {
  serve("m-1");
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push(studio({ settings: { ...studio().settings, mode: "analyst", language: "es" } }));
  await waitFor(() => expect(stream("/api/matches/")?.url).toBe("/api/matches/m-1/stream?mode=analyst&lang=es"));
  act(() => {
    const match = stream("/api/matches/")!;
    match.open();
    match.emit(envelope(1, "match_status", status({ score_home: 3 })));
  });
  expect(screen.getByTestId("program-score").textContent).toBe("3 - 0");
});

test("a banner from the studio appears on the program", () => {
  serve(null);
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push(studio());
  expect(screen.queryByTestId("program-banner")).toBeNull();
  push(studio({ revision: 2, banner: { id: "b", text: "Welcome", kind: "custom", duration_s: 8, ends_at: 1008, source_id: null } }));
  expect(screen.getByTestId("program-banner").textContent).toBe("Welcome");
});

test("a scene without a replay element gets one while a replay is playing", () => {
  const replay = { match_id: "m-1", moment_id: "m-1-k1", minute: 23, started_at: 1000, duration_s: 8 };
  const plain = scene();
  expect(withReplayFallback(plain, studio())).toBe(plain);
  const added = withReplayFallback(plain, studio({ replay }));
  expect(added.elements).toHaveLength(plain.elements.length + 1);
  expect(added.elements.at(-1)).toMatchObject({ type: "replay", visible: true });
  expect(added.elements.at(-1)!.layer).toBeGreaterThan(Math.max(...plain.elements.map((item) => item.layer)));

  const own = scene({ elements: [element({ id: "r", type: "replay", props: {} })] });
  expect(withReplayFallback(own, studio({ replay }))).toBe(own);
  const hidden = scene({ elements: [element({ id: "r", type: "replay", visible: false, props: {} })] });
  expect(withReplayFallback(hidden, studio({ replay })).elements).toHaveLength(2);
});

test("after the stream is refused the page reconnects and takes the server's document", async () => {
  serve(null);
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push(studio({ revision: 40 }));
  const first = stream("/api/studio/stream")!;
  act(() => first.fail(2));
  await waitFor(() => expect(stream("/api/studio/stream")).not.toBe(first));
  expect(screen.getByTestId("element-scoreboard")).toBeTruthy();
  push(studio({ revision: 0, active_scene_id: "s2" }));
  expect(screen.getByTestId("element-countdown")).toBeTruthy();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/studio`
Expected: the three new files fail to resolve their modules; the Task 6 files still pass.

- [ ] **Step 3: Let the pitch fill a box**

In `apps/web/src/components/Pitch.tsx`, add `fill?: boolean;` to `PitchProps` with this comment above it:

```tsx
  /** Fit the height of the containing box as well as its width. Used on the studio canvas. */
  fill?: boolean;
```

Add `fill = false` to the destructured props, and add this attribute to the `<svg>` element:

```tsx
      style={fill ? { height: "100%" } : undefined}
```

- [ ] **Step 4: Write the element views**

`apps/web/src/studio/elements.tsx`:

```tsx
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { Pitch } from "../components/Pitch";
import { StatsPanel } from "../components/StatsPanel";
import { Timeline } from "../components/Timeline";
import type { Banner, MatchEvent, Replay, SceneElement, Studio } from "../contracts";
import { type Language, t } from "../i18n";
import type { MatchData } from "../stream/store";
import { fetchReplay, imageUrl } from "./api";
import { countdownLabel, formatRemaining, tickerItems } from "./format";

/** Everything an element can draw from. `now` is the server's clock in Unix seconds. */
export interface ProgramData {
  match: MatchData;
  studio: Studio;
  now: number;
  language: Language;
}

// The program is a broadcast picture, not themed interface: one fixed look, sized for 1080p.
const PANEL: CSSProperties = {
  boxSizing: "border-box", width: "100%", height: "100%", overflow: "hidden", padding: 24, borderRadius: 16,
  color: "#FFFFFF", backgroundColor: "rgba(16, 24, 40, 0.88)", fontSize: 32, lineHeight: 1.3,
};
const CENTERED: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", gap: 32 };
const BANNER_COLOR: Record<Banner["kind"], string> = {
  goal: "#107C10", card: "#C50F1F", info: "#0F6CBD", custom: "#5C2E91",
};
const noop = () => {};

function Panel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ ...PANEL, ...style }}>{children}</div>;
}

/** Cycle 1 components are sized for a dashboard; enlarge them for the 1080p canvas. */
function Enlarged({ children }: { children: ReactNode }) {
  return (
    <Panel>
      <div style={{ zoom: 1.8 }}>{children}</div>
    </Panel>
  );
}

function Scoreboard({ match }: { match: MatchData }) {
  const status = match.status;
  if (!status) {
    return (
      <Panel style={CENTERED}>
        <span data-testid="program-score" style={{ fontSize: 64, opacity: 0.6 }}>–</span>
      </Panel>
    );
  }
  return (
    <Panel style={CENTERED}>
      <span style={{ fontWeight: 600 }}>{status.home.name}</span>
      <span data-testid="program-score" style={{ fontSize: 64, fontWeight: 700 }}>
        {status.score_home} - {status.score_away}
      </span>
      <span style={{ fontWeight: 600 }}>{status.away.name}</span>
      <span style={{ opacity: 0.8 }}>{Math.max(status.minute, match.minute)}'</span>
    </Panel>
  );
}

function Narration({ match, lines, language }: { match: MatchData; lines: number; language: Language }) {
  const shown = match.narratives.slice(0, lines);
  if (shown.length === 0) return <Panel style={{ opacity: 0.7 }}>{t(language, "feedEmpty")}</Panel>;
  return (
    <Panel style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {shown.map((line) => (
        <p key={line.id} style={{ margin: 0 }}>
          <span style={{ opacity: 0.7, marginRight: 12 }}>{line.minute}'</span>
          <span>{line.text}</span>
        </p>
      ))}
    </Panel>
  );
}

function BannerView({ banner }: { banner: Banner | null | undefined }) {
  if (!banner) return null;
  return (
    <div data-testid="program-banner" data-kind={banner.kind}
      style={{ ...PANEL, ...CENTERED, backgroundColor: BANNER_COLOR[banner.kind], fontSize: 40, fontWeight: 600, textAlign: "center" }}>
      {banner.text}
    </div>
  );
}

function TickerView({ data }: { data: ProgramData }) {
  const items = tickerItems(data.studio.ticker, data.match.status, data.match.stats, data.language);
  if (items.length === 0) return null;
  const text = items.join("   •   ");
  const seconds = Math.max(6, (1920 + text.length * 22) / data.studio.ticker.speed);
  return (
    <div data-testid="program-ticker" style={{ ...PANEL, padding: 0, borderRadius: 0, display: "flex", alignItems: "center", whiteSpace: "nowrap" }}>
      <div style={{ display: "inline-block", paddingLeft: "100%", animation: `kickstream-ticker ${seconds}s linear infinite` }}>
        {text}
      </div>
    </div>
  );
}

function CountdownView({ data }: { data: ProgramData }) {
  const countdown = data.studio.countdown;
  if (!countdown) return null;
  return (
    <div data-testid="program-countdown" style={{ ...PANEL, ...CENTERED, flexDirection: "column", gap: 8 }}>
      <span style={{ fontSize: 40, opacity: 0.85 }}>{countdownLabel(countdown, data.language)}</span>
      <span style={{ fontSize: 112, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
        {formatRemaining(countdown.ends_at - data.now)}
      </span>
    </div>
  );
}

function RecapView({ match }: { match: MatchData }) {
  const recap = match.recaps[match.recaps.length - 1];
  if (!recap) return null;
  return (
    <div data-testid="program-recap" style={PANEL}>
      <div style={{ fontSize: 40, fontWeight: 700, marginBottom: 16 }}>{recap.title}</div>
      <ul style={{ margin: 0, paddingLeft: 40 }}>
        {recap.bullets.map((bullet) => (
          <li key={bullet}>{bullet}</li>
        ))}
      </ul>
    </div>
  );
}

function ReplayView({ replay, data }: { replay: Replay; data: ProgramData }) {
  const [events, setEvents] = useState<MatchEvent[]>([]);

  useEffect(() => {
    let current = true;
    setEvents([]);
    fetchReplay(replay.match_id, replay.moment_id)
      .then((body) => current && setEvents(body.events))
      .catch(() => current && setEvents([]));
    return () => {
      current = false;
    };
  }, [replay.match_id, replay.moment_id, replay.started_at]);

  const progress = Math.max(0, Math.min(1, (data.now - replay.started_at) / replay.duration_s));
  const revealed = events.slice(0, Math.max(1, Math.ceil(events.length * progress)));
  return (
    <div data-testid="program-replay" style={{ ...PANEL, display: "flex", flexDirection: "column", gap: 12, border: "6px solid #FFB900" }}>
      <span style={{ alignSelf: "flex-start", padding: "4px 16px", borderRadius: 8, color: "#1B1B1B", backgroundColor: "#FFB900", fontWeight: 700 }}>
        {t(data.language, "replay")} · {replay.minute}'
      </span>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Pitch events={revealed} pressure={null} status={data.match.status} showPressure={false} language={data.language} fill />
      </div>
    </div>
  );
}

function ImageView({ imageId, fit }: { imageId: unknown; fit: unknown }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [imageId]);
  if (typeof imageId !== "string" || broken) {
    return <div style={{ ...PANEL, backgroundColor: "rgba(255, 255, 255, 0.08)", border: "4px dashed rgba(255, 255, 255, 0.4)" }} />;
  }
  return (
    <img data-testid="program-image" src={imageUrl(imageId)} alt="" onError={() => setBroken(true)}
      style={{ width: "100%", height: "100%", objectFit: fit === "cover" ? "cover" : "contain", display: "block" }} />
  );
}

/** Draws one scene element from the match and the studio document. */
export function ElementView({ element, data }: { element: SceneElement; data: ProgramData }) {
  const { match, studio, language } = data;
  const props = element.props as Record<string, unknown>;
  switch (element.type) {
    case "scoreboard":
      return <Scoreboard match={match} />;
    case "pitch":
      return (
        <Panel style={{ padding: 12 }}>
          <Pitch events={match.events} pressure={match.pressure} status={match.status} showPressure={props.pressure !== false} language={language} fill />
        </Panel>
      );
    case "narration":
      return <Narration match={match} lines={typeof props.lines === "number" ? props.lines : 3} language={language} />;
    case "stats":
      return (
        <Enlarged>
          <StatsPanel stats={match.stats} status={match.status} language={language} />
        </Enlarged>
      );
    case "banner":
      return <BannerView banner={studio.banner} />;
    case "ticker":
      return <TickerView data={data} />;
    case "timeline":
      // On the program the timeline is a picture, not a control: its buttons must not take focus or clicks.
      return (
        <Enlarged>
          <div inert>
            <Timeline moments={match.moments} recaps={match.recaps} selectedId={null} language={language} onSelect={noop} onOpenRecap={noop} />
          </div>
        </Enlarged>
      );
    case "recap":
      return <RecapView match={match} />;
    case "replay":
      return studio.replay ? <ReplayView replay={studio.replay} data={data} /> : null;
    case "countdown":
      return <CountdownView data={data} />;
    case "text":
      return (
        <div style={{ ...PANEL, ...CENTERED, backgroundColor: "transparent" }}>
          <span style={{ width: "100%", fontSize: typeof props.size === "number" ? props.size : 48, fontWeight: 700, textAlign: (props.align as CSSProperties["textAlign"]) ?? "center" }}>
            {typeof props.text === "string" ? props.text : ""}
          </span>
        </div>
      );
    case "image":
      return <ImageView imageId={props.image_id} fit={props.fit} />;
  }
}
```

- [ ] **Step 5: Write the scene canvas**

`apps/web/src/studio/SceneCanvas.tsx`:

```tsx
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import type { Scene, SceneElement } from "../contracts";
import { ElementView, type ProgramData } from "./elements";
import { CANVAS, GRID, moveBy, type Rect, rectOf, resizeBy, sameRect } from "./geometry";

interface SceneCanvasProps {
  scene: Scene;
  data: ProgramData;
  /** Screen pixels per canvas pixel. */
  scale: number;
  editable?: boolean;
  selectedId?: string | null;
  onSelect?(elementId: string | null): void;
  /** Called once when a move or resize ends, with the whole element list. */
  onChange?(elements: SceneElement[]): void;
}

interface Gesture {
  id: string;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  origin: Rect;
}

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-GRID, 0], ArrowRight: [GRID, 0], ArrowUp: [0, -GRID], ArrowDown: [0, GRID],
};
const TICKER_KEYFRAMES = "@keyframes kickstream-ticker { from { transform: translateX(0); } to { transform: translateX(-100%); } }";
const HANDLE: CSSProperties = { position: "absolute", inset: 0, cursor: "move", touchAction: "none", background: "transparent" };
const CORNER: CSSProperties = {
  position: "absolute", right: -14, bottom: -14, width: 40, height: 40, borderRadius: 8, cursor: "nwse-resize",
  touchAction: "none", backgroundColor: "#0F6CBD", border: "4px solid #FFFFFF",
};
const LABEL: CSSProperties = {
  position: "absolute", left: 0, top: 0, padding: "2px 12px", fontSize: 24, color: "#FFFFFF",
  backgroundColor: "rgba(15, 108, 189, 0.9)", borderBottomRightRadius: 8, pointerEvents: "none",
};

/** Draws a scene on the 16:9 canvas. The same component is the program and, with `editable`, the editor. */
export function SceneCanvas({ scene, data, scale, editable = false, selectedId = null, onSelect, onChange }: SceneCanvasProps) {
  const [draft, setDraft] = useState<{ id: string; rect: Rect } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const drawn = scene.elements.filter((element) => editable || element.visible).sort((a, b) => a.layer - b.layer);

  const commit = (id: string, rect: Rect) =>
    onChange?.(scene.elements.map((element) => (element.id === id ? { ...element, ...rect } : element)));

  const rectAt = (current: Gesture, event: PointerEvent) => {
    const dx = (event.clientX - current.startX) / scale;
    const dy = (event.clientY - current.startY) / scale;
    return current.mode === "move" ? moveBy(current.origin, dx, dy) : resizeBy(current.origin, dx, dy);
  };

  const begin = (event: PointerEvent, element: SceneElement, mode: Gesture["mode"]) => {
    event.preventDefault();
    event.stopPropagation();
    // Keeps the gesture alive when the pointer leaves the handle. Not available in every test DOM.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    gesture.current = { id: element.id, mode, startX: event.clientX, startY: event.clientY, origin: rectOf(element) };
    onSelect?.(element.id);
  };

  const track = (event: PointerEvent) => {
    const current = gesture.current;
    if (current) setDraft({ id: current.id, rect: rectAt(current, event) });
  };

  const finish = (event: PointerEvent) => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    setDraft(null);
    const rect = rectAt(current, event);
    if (!sameRect(rect, current.origin)) commit(current.id, rect);
  };

  const nudge = (event: KeyboardEvent, element: SceneElement) => {
    const step = ARROWS[event.key];
    if (!step) return;
    event.preventDefault();
    const origin = rectOf(element);
    const rect = event.shiftKey ? resizeBy(origin, step[0], step[1]) : moveBy(origin, step[0], step[1]);
    if (!sameRect(rect, origin)) commit(element.id, rect);
  };

  return (
    <div data-testid="scene-canvas"
      style={{ position: "relative", overflow: "hidden", width: CANVAS.width * scale, height: CANVAS.height * scale, backgroundColor: "#0B1220" }}
      onPointerDown={editable ? () => onSelect?.(null) : undefined}>
      <style>{TICKER_KEYFRAMES}</style>
      <div style={{ position: "relative", width: CANVAS.width, height: CANVAS.height, transform: `scale(${scale})`, transformOrigin: "0 0" }}>
        {drawn.map((element) => {
          const rect = draft?.id === element.id ? draft.rect : rectOf(element);
          const selected = element.id === selectedId;
          return (
            <div key={element.id} data-testid={`element-${element.type}`} data-element-id={element.id}
              style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: element.layer, opacity: editable && !element.visible ? 0.35 : 1 }}>
              <ElementView element={element} data={data} />
              {editable && (
                <>
                  <span style={LABEL}>{element.type}</span>
                  <div role="button" tabIndex={0} aria-label={`${element.type} element`} aria-pressed={selected}
                    style={{ ...HANDLE, outline: selected ? "6px solid #0F6CBD" : "2px dashed rgba(255, 255, 255, 0.5)" }}
                    onPointerDown={(event) => begin(event, element, "move")} onPointerMove={track} onPointerUp={finish}
                    onKeyDown={(event) => nudge(event, element)} />
                  {selected && (
                    <div role="button" tabIndex={-1} aria-label={`Resize ${element.type} element`} style={CORNER}
                      onPointerDown={(event) => begin(event, element, "resize")} onPointerMove={track} onPointerUp={finish} />
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Write the program page and add its route**

`apps/web/src/studio/ProgramPage.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import type { Scene, Studio, ViewerProfile } from "../contracts";
import { useMatch } from "../stream/store";
import { type CurrentMatchOptions, useCurrentMatch } from "../stream/useCurrentMatch";
import { fitScale, nextLayer } from "./geometry";
import { SceneCanvas } from "./SceneCanvas";
import { useNow, useStudio } from "./useStudio";

const REPLAY_BOX = { x: 360, y: 180, width: 1200, height: 720 };

/** A replay must never be invisible: add a centred replay box to a scene that has none showing. */
export function withReplayFallback(scene: Scene, studio: Studio): Scene {
  if (!studio.replay || scene.elements.some((element) => element.type === "replay" && element.visible)) return scene;
  const fallback = { id: "__replay", type: "replay" as const, ...REPLAY_BOX, layer: nextLayer(scene.elements), visible: true, props: {} };
  return { ...scene, elements: [...scene.elements, fallback] };
}

function useWindowSize() {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/** The clean output: the active scene, scaled to the window, with no controls. */
export function ProgramPage({ eventSource, retryMs, pollMs }: CurrentMatchOptions) {
  const { studio, offset } = useStudio(eventSource, retryMs);
  const mode = studio?.settings.mode;
  const language = studio?.settings.language;
  const profile = useMemo<ViewerProfile | null>(
    () => (mode && language ? { mode, language, club: null, player: null } : null),
    [mode, language],
  );
  useCurrentMatch(profile, { eventSource, retryMs, pollMs });
  const match = useMatch((state) => state.data);
  const now = useNow() + offset;
  const size = useWindowSize();

  const active = studio?.scenes.find((scene) => scene.id === studio.active_scene_id) ?? studio?.scenes[0];
  return (
    <div data-testid="program"
      style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", overflow: "hidden", backgroundColor: "#000000", cursor: "none" }}>
      {studio && active && (
        <SceneCanvas scene={withReplayFallback(active, studio)} scale={fitScale(size.width, size.height)}
          data={{ match, studio, now, language: studio.settings.language }} />
      )}
    </div>
  );
}
```

In `apps/web/src/main.tsx`, import the page and choose it by path:

```tsx
import { ProgramPage } from "./studio/ProgramPage";
```

```tsx
/** The three pages. `/studio` is added in the next task. */
function Page() {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/program") return <ProgramPage />;
  return <App />;
}
```

- [ ] **Step 7: Run every web test and the type check**

Run: `pnpm test && pnpm typecheck`
Expected: all pass; no type errors.

- [ ] **Step 8: See the program page**

With `pnpm dev:api` and `pnpm dev:web` running, open `http://127.0.0.1:5173/program`.
Expected: a dark 16:9 picture filling the window with "Kick-off soon", the two team names and a ticker bar. In another terminal:

```bash
curl -s -X POST localhost:8000/api/studio/banner -H "content-type: application/json" -d '{"text":"Hello from the studio"}' > /dev/null
curl -s -X POST localhost:8000/api/studio/countdown -H "content-type: application/json" -d '{"kind":"break","minutes":2}' > /dev/null
```

Expected: the page cuts to the Break scene and counts down from 2:00. End it with `curl -s -X DELETE localhost:8000/api/studio/countdown > /dev/null`.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src
git commit -m "feat: add the program page and a shared scene canvas with drag and resize"
```

---

### Task 8: The control page

**Files:**
- Create: `apps/web/src/studio/panels.tsx`, `apps/web/src/studio/StudioPage.tsx`
- Modify: `apps/web/src/main.tsx` (the `/studio` route)
- Test: `apps/web/src/studio/StudioPage.test.tsx`

**Interfaces:**
- Consumes: Tasks 6 and 7.
- Produces:
  - `studio/panels.tsx`: `SceneList`, `ElementPanel`, `BannerPanel`, `TickerPanel`, `HighlightsPanel`, `CountdownPanel`, `SettingsPanel`. All are props-only; none fetches.
  - `studio/StudioPage.tsx`: `StudioPage({ eventSource?, retryMs?, pollMs? })`. Every control calls one function from `studio/api.ts`, applies the returned document, and shows the server's message if the change is refused.
  - Accessible names the tests and the end-to-end test rely on: buttons `Edit <scene>`, `Go live with <scene>`, `Duplicate <scene>`, `Save <scene> as template`, `Delete <scene>`, `Add scene`, `Add element`, `Remove <type>`, `Bring <type> forward`, `Send <type> back`, `Show banner`, `Clear banner`, `Save ticker`, `Replay <minute>' <kind>`, `Show <minute>' <kind> on banner`, `Stop replay`, `Start countdown`, `Take a break`, `End countdown`, `End break`; checkboxes `Show <type>`; tabs `Elements`, `Banner`, `Ticker`, `Highlights`, `Countdown`, `Settings`; fields `Banner text`, `Messages, one per line`, `Speed`, `Start in (minutes)`, `Break length (minutes)`, `Program mode`, `Program language`, `New scene from`, `Element type`.

The start countdown is set as "start in N minutes" (1 to 1440). The page turns that into a start time on the server's clock.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/studio/StudioPage.test.tsx`:

```tsx
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Studio } from "../contracts";
import { useMatch } from "../stream/store";
import {
  envelope, FakeEventSource, FakeEventSourceCtor, moment, narrative, status, studio,
} from "../test/fixtures";
import { renderUi } from "../test/render";
import { StudioPage } from "./StudioPage";

interface Call {
  url: string;
  method: string;
  body: any;
}

/** Answers the control page's requests. Every studio change succeeds with the next revision unless `refuse` is set. */
function serve(initial: Studio = studio()) {
  let doc = initial;
  const calls: Call[] = [];
  const server = { calls, refuse: null as null | { status: number; field: string; msg: string } };
  const reply = (statusCode: number, body: unknown) => new Response(JSON.stringify(body), { status: statusCode });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/matches/current") return reply(200, { match_id: "m-1" });
    if (!url.startsWith("/api/studio")) return reply(404, {});
    calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
    if (server.refuse) {
      const { status: statusCode, field, msg } = server.refuse;
      return reply(statusCode, { detail: [{ loc: ["body", field], msg, type: "studio" }] });
    }
    if (url === "/api/studio/images") return reply(201, { id: "abc.png" });
    doc = { ...doc, revision: doc.revision + 1 };
    return reply(200, doc);
  }));
  return server;
}

const stream = (path: string) => FakeEventSource.instances.filter((source) => source.url.startsWith(path) && !source.closed).at(-1)!;
const last = (server: ReturnType<typeof serve>) => server.calls[server.calls.length - 1];
const openTab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

beforeEach(() => {
  FakeEventSource.instances = [];
  useMatch.setState({ data: useMatch.getInitialState().data, connection: "idle", selectedId: null });
});

async function opened(doc: Studio = studio()) {
  const server = serve(doc);
  renderUi(<StudioPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  act(() => {
    stream("/api/studio/stream").open();
    stream("/api/studio/stream").emitRaw(JSON.stringify(doc));
  });
  await waitFor(() => expect(stream("/api/matches/").url).toContain("/api/matches/m-1/stream"));
  act(() => {
    const match = stream("/api/matches/");
    match.open();
    match.emit(envelope(1, "match_status", status({ score_home: 1 })));
    match.emit(envelope(2, "key_moment", moment()));
    match.emit(envelope(3, "narrative", narrative()));
  });
  return server;
}

test("until the studio document arrives the page says it is connecting", () => {
  serve();
  renderUi(<StudioPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  expect(screen.getByText("Connecting to the studio…")).toBeTruthy();
});

test("it lists the scenes, marks the one on air, and links to the program", async () => {
  await opened();
  const scenes = within(screen.getByRole("region", { name: "Scenes" }));
  expect(scenes.getByRole("button", { name: "Edit Live match" })).toBeTruthy();
  expect(scenes.getByText("On air")).toBeTruthy();
  expect(scenes.getByRole("button", { name: "Go live with Break" })).toBeTruthy();
  expect(scenes.queryByRole("button", { name: "Go live with Live match" })).toBeNull();
  expect((scenes.getByRole("button", { name: "Delete Live match" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("link", { name: "Open program" }).getAttribute("href")).toBe("/program");
});

test("going live with a scene activates it", async () => {
  const server = await opened();
  fireEvent.click(screen.getByRole("button", { name: "Go live with Break" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/scenes/s2/activate", method: "POST" }));
});

test("scenes can be added from a template, duplicated, saved as a template and deleted", async () => {
  const server = await opened();
  fireEvent.change(screen.getByLabelText("New scene from"), { target: { value: "builtin:Full-time" } });
  fireEvent.click(screen.getByRole("button", { name: "Add scene" }));
  await waitFor(() => expect(last(server).body).toEqual({ source: "builtin", ref: "Full-time" }));
  fireEvent.click(screen.getByRole("button", { name: "Duplicate Break" }));
  await waitFor(() => expect(last(server).body).toEqual({ source: "scene", ref: "s2" }));
  fireEvent.click(screen.getByRole("button", { name: "Save Break as template" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/templates", body: { scene_id: "s2" } }));
  fireEvent.click(screen.getByRole("button", { name: "Delete Break" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/scenes/s2", method: "DELETE" }));
});

test("the editor opens on the scene on air, and another scene can be edited without going live", async () => {
  const server = await opened();
  const editor = within(screen.getByRole("region", { name: "Editor" }));
  expect(editor.getByRole("button", { name: "scoreboard element" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit Break" }));
  expect(editor.getByRole("button", { name: "countdown element" })).toBeTruthy();
  expect(editor.queryByRole("button", { name: "scoreboard element" })).toBeNull();
  expect(server.calls).toHaveLength(0);
  expect(within(screen.getByRole("region", { name: "Program preview" })).getByTestId("element-scoreboard")).toBeTruthy();
});

test("dragging an element saves that scene and only that scene", async () => {
  const server = await opened();
  const handle = within(screen.getByRole("region", { name: "Editor" })).getByRole("button", { name: "scoreboard element" });
  fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 190, clientY: 100, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientX: 190, clientY: 100, pointerId: 1 });
  await waitFor(() => expect(server.calls).toHaveLength(1));
  expect(last(server)).toMatchObject({ url: "/api/studio/scenes/s1", method: "PUT", body: { name: "Live match" } });
  const [scoreboard, banner] = last(server).body.elements;
  expect(scoreboard).toMatchObject({ id: "score", x: 240, y: 40 });
  expect(banner).toEqual(studio().scenes[0].elements[1]);
});

test("elements can be hidden, restacked, removed and added from the panel", async () => {
  const server = await opened();
  const panel = within(screen.getByRole("tabpanel"));
  fireEvent.click(panel.getByRole("checkbox", { name: "Show banner" }));
  await waitFor(() => expect(last(server).body.elements[1]).toMatchObject({ id: "banner", visible: false }));
  fireEvent.click(panel.getByRole("button", { name: "Bring scoreboard forward" }));
  await waitFor(() => expect(last(server).body.elements.map((item: any) => [item.id, item.layer])).toEqual([["score", 2], ["banner", 1]]));
  fireEvent.click(panel.getByRole("button", { name: "Remove banner" }));
  await waitFor(() => expect(last(server).body.elements.map((item: any) => item.id)).toEqual(["score"]));
  fireEvent.change(panel.getByLabelText("Element type"), { target: { value: "ticker" } });
  fireEvent.click(panel.getByRole("button", { name: "Add element" }));
  await waitFor(() => expect(last(server).body.elements).toHaveLength(3));
  const added = last(server).body.elements[2];
  expect(added).toMatchObject({ type: "ticker", visible: true, layer: 3 });
  expect(["score", "banner"]).not.toContain(added.id);
});

test("a selected text element can be edited", async () => {
  const doc = studio();
  doc.scenes[0].elements.push({ id: "title", type: "text", x: 0, y: 0, width: 400, height: 100, layer: 9, visible: true, props: { text: "Old", size: 48, align: "center" } });
  const server = await opened(doc);
  fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Select text" }));
  fireEvent.change(screen.getByLabelText("Text"), { target: { value: "Matchday live" } });
  fireEvent.blur(screen.getByLabelText("Text"));
  await waitFor(() => expect(last(server).body.elements[2].props).toMatchObject({ text: "Matchday live", size: 48 }));
});

test("a custom banner can be shown and cleared, and automatic banners switched off", async () => {
  const showing = studio({ banner: { id: "b", text: "On screen now", kind: "custom", duration_s: 8, ends_at: 2000, source_id: null } });
  const server = await opened(showing);
  openTab("Banner");
  expect(within(screen.getByRole("tabpanel")).getByText("On screen now")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Banner text"), { target: { value: "Welcome to matchday" } });
  fireEvent.click(screen.getByRole("button", { name: "Show banner" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/banner", method: "POST", body: { text: "Welcome to matchday", kind: "custom" } }));
  expect((screen.getByLabelText("Banner text") as HTMLInputElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Clear banner" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/banner", method: "DELETE" }));
  fireEvent.click(screen.getByRole("switch", { name: "Automatic banners for goals and red cards" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/settings", body: { auto_banner: false, mode: "fan" } }));
});

test("the ticker is saved with one message per line", async () => {
  const server = await opened();
  openTab("Ticker");
  fireEvent.change(screen.getByLabelText("Messages, one per line"), { target: { value: "Welcome\n\nSubscribe for more" } });
  fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "200" } });
  fireEvent.click(screen.getByRole("button", { name: "Save ticker" }));
  await waitFor(() => expect(last(server)).toMatchObject({
    url: "/api/studio/ticker", method: "PUT", body: { messages: ["Welcome", "Subscribe for more"], speed: 200, enabled: true },
  }));
});

test("key moments can be replayed and their narration sent to the banner", async () => {
  const server = await opened();
  openTab("Highlights");
  expect(screen.getByText(/^GOAL! Luca Marrowby scores/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Replay 23' Goal" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/replay", body: { match_id: "m-1", moment_id: "m-1-k1" } }));
  fireEvent.click(screen.getByRole("button", { name: "Show 23' Goal on banner" }));
  await waitFor(() => expect(last(server).body).toMatchObject({ kind: "info", source_id: "m-1-k1-fan-en" }));
  expect(last(server).body.text).toMatch(/^GOAL! Luca Marrowby scores/);
});

test("a running replay can be stopped", async () => {
  const replay = { match_id: "m-1", moment_id: "m-1-k1", minute: 23, started_at: 1000, duration_s: 8 };
  const server = await opened(studio({ replay }));
  openTab("Highlights");
  fireEvent.click(screen.getByRole("button", { name: "Stop replay" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/replay", method: "DELETE" }));
});

test("a start countdown is set on the server's clock, and a break by its length", async () => {
  vi.spyOn(Date, "now").mockReturnValue(50_000_000);
  const server = await opened(studio({ server_time: 1000 }));
  openTab("Countdown");
  fireEvent.change(screen.getByLabelText("Start in (minutes)"), { target: { value: "15" } });
  fireEvent.click(screen.getByRole("button", { name: "Start countdown" }));
  await waitFor(() => expect(last(server).body).toEqual({ kind: "start", starts_at: 1000 + 15 * 60, label: "" }));
  fireEvent.change(screen.getByLabelText("Break length (minutes)"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Take a break" }));
  await waitFor(() => expect(last(server).body).toEqual({ kind: "break", minutes: 5, label: "" }));
});

test("a running break shows the time left and can be ended", async () => {
  vi.spyOn(Date, "now").mockReturnValue(50_000_000);
  const server = await opened(studio({ server_time: 1000, countdown: { kind: "break", ends_at: 1125, label: "" } }));
  openTab("Countdown");
  expect(screen.getByText("Break: 2:05 left")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "End break" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/countdown", method: "DELETE" }));
});

test("program mode, language and the automatic switches are saved as they change", async () => {
  const server = await opened();
  openTab("Settings");
  fireEvent.change(screen.getByLabelText("Program language"), { target: { value: "hi" } });
  await waitFor(() => expect(last(server).body).toMatchObject({ language: "hi", mode: "fan" }));
  fireEvent.change(screen.getByLabelText("Program mode"), { target: { value: "analyst" } });
  await waitFor(() => expect(last(server).body).toMatchObject({ mode: "analyst" }));
  fireEvent.click(screen.getByRole("switch", { name: "Take a break automatically at half-time" }));
  await waitFor(() => expect(last(server).body).toMatchObject({ auto_half_time_break: true }));
});

test("a refused change shows the server's reason and leaves the scene as it was", async () => {
  const server = await opened();
  server.refuse = { status: 409, field: "scene", msg: "The scene on the program cannot be deleted. Switch scenes first." };
  fireEvent.click(screen.getByRole("button", { name: "Delete Break" }));
  expect(await screen.findByText("The scene on the program cannot be deleted. Switch scenes first.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit Break" })).toBeTruthy();

  const handle = within(screen.getByRole("region", { name: "Editor" })).getByRole("button", { name: "scoreboard element" });
  fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientX: 190, clientY: 100, pointerId: 1 });
  await waitFor(() => expect(server.calls).toHaveLength(2));
  await waitFor(() => expect(within(screen.getByRole("region", { name: "Editor" })).getByTestId("element-scoreboard").style.left).toBe("40px"));
});

test("a document pushed by another control page replaces what is shown", async () => {
  await opened();
  const renamed = studio({ revision: 7 });
  renamed.scenes[1] = { ...renamed.scenes[1], name: "Half-time show" };
  act(() => stream("/api/studio/stream").emitRaw(JSON.stringify(renamed)));
  expect(screen.getByRole("button", { name: "Edit Half-time show" })).toBeTruthy();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/studio/StudioPage.test.tsx`
Expected: the file fails to resolve `./StudioPage`.

- [ ] **Step 3: Write the panels**

`apps/web/src/studio/panels.tsx`:

```tsx
import {
  Badge, Button, Checkbox, Field, Input, makeStyles, Select, Switch, Text, Textarea, tokens,
} from "@fluentui/react-components";
import { type ChangeEvent, useEffect, useState } from "react";
import type { Scene, SceneElement, Studio, StudioSettings, Ticker } from "../contracts";
import { LANGUAGE_NAMES, LANGUAGES, type Language, type Mode, type StringKey, t } from "../i18n";
import type { FeedMoment, FeedNarrative, MatchData } from "../stream/store";
import { formatRemaining } from "./format";
import { lower, nextLayer, raise } from "./geometry";

const BUILTIN = ["Starting soon", "Live match", "Analyst desk", "Break", "Full-time"];
const ELEMENT_TYPES: SceneElement["type"][] = [
  "scoreboard", "pitch", "narration", "stats", "banner", "ticker", "timeline", "recap", "replay", "countdown", "text", "image",
];

const useStyles = makeStyles({
  panel: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  item: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalXS },
  grow: { flexGrow: 1 },
});

// --- scenes ------------------------------------------------------------------------------------

interface SceneListProps {
  studio: Studio;
  editingId: string;
  onEdit(sceneId: string): void;
  onActivate(sceneId: string): void;
  onCreate(source: "builtin" | "template" | "scene", ref: string): void;
  onDelete(sceneId: string): void;
  onSaveTemplate(sceneId: string): void;
  onDeleteTemplate(templateId: string): void;
}

export function SceneList({ studio, editingId, onEdit, onActivate, onCreate, onDelete, onSaveTemplate, onDeleteTemplate }: SceneListProps) {
  const styles = useStyles();
  const [origin, setOrigin] = useState("builtin:Live match");
  const create = () => {
    const [source, ...rest] = origin.split(":");
    onCreate(source as "builtin" | "template", rest.join(":"));
  };
  return (
    <section className={styles.panel} aria-label="Scenes">
      <Text as="h2" weight="semibold">Scenes</Text>
      <ul className={styles.list}>
        {studio.scenes.map((scene) => {
          const onAir = scene.id === studio.active_scene_id;
          return (
            <li key={scene.id} className={styles.item}>
              <div className={styles.row}>
                <Button className={styles.grow} appearance={scene.id === editingId ? "primary" : "secondary"}
                  aria-label={`Edit ${scene.name}`} onClick={() => onEdit(scene.id)}>
                  {scene.name}
                </Button>
                {onAir ? (
                  <Badge color="danger">On air</Badge>
                ) : (
                  <Button size="small" aria-label={`Go live with ${scene.name}`} onClick={() => onActivate(scene.id)}>Go live</Button>
                )}
              </div>
              <div className={styles.row}>
                <Button size="small" appearance="subtle" aria-label={`Duplicate ${scene.name}`} onClick={() => onCreate("scene", scene.id)}>Duplicate</Button>
                <Button size="small" appearance="subtle" aria-label={`Save ${scene.name} as template`} onClick={() => onSaveTemplate(scene.id)}>Save as template</Button>
                <Button size="small" appearance="subtle" aria-label={`Delete ${scene.name}`} disabled={onAir || studio.scenes.length === 1} onClick={() => onDelete(scene.id)}>Delete</Button>
              </div>
            </li>
          );
        })}
      </ul>
      <Field label="New scene from">
        <Select value={origin} onChange={(_, data) => setOrigin(data.value)}>
          {BUILTIN.map((name) => (
            <option key={name} value={`builtin:${name}`}>{name}</option>
          ))}
          {studio.templates.map((template) => (
            <option key={template.id} value={`template:${template.id}`}>{template.name} (saved)</option>
          ))}
        </Select>
      </Field>
      <Button onClick={create}>Add scene</Button>
      {studio.templates.length > 0 && (
        <ul className={styles.list} aria-label="Saved templates">
          {studio.templates.map((template) => (
            <li key={template.id} className={styles.row}>
              <Text className={styles.grow}>{template.name}</Text>
              <Button size="small" appearance="subtle" aria-label={`Delete template ${template.name}`} onClick={() => onDeleteTemplate(template.id)}>Delete</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --- elements ----------------------------------------------------------------------------------

interface ElementPanelProps {
  scene: Scene;
  selectedId: string | null;
  onSelect(elementId: string | null): void;
  onChange(elements: SceneElement[]): void;
  onUpload(file: File): Promise<string | null>;
}

function newElementId(): string {
  return Math.random().toString(16).slice(2, 10);
}

function TextField({ label, value, onCommit }: { label: string; value: string; onCommit(value: string): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Field label={label}>
      <Textarea value={draft} maxLength={200} onChange={(_, data) => setDraft(data.value)} onBlur={() => draft !== value && onCommit(draft)} />
    </Field>
  );
}

export function ElementPanel({ scene, selectedId, onSelect, onChange, onUpload }: ElementPanelProps) {
  const styles = useStyles();
  const [type, setType] = useState<SceneElement["type"]>("text");
  const stacked = [...scene.elements].sort((a, b) => b.layer - a.layer);
  const selected = scene.elements.find((element) => element.id === selectedId);

  const patch = (id: string, changes: Partial<SceneElement>) =>
    onChange(scene.elements.map((element) => (element.id === id ? { ...element, ...changes } : element)));
  const setProp = (element: SceneElement, key: string, value: unknown) => patch(element.id, { props: { ...element.props, [key]: value } });
  const add = () => {
    const added: SceneElement = { id: newElementId(), type, x: 760, y: 440, width: 400, height: 200, layer: nextLayer(scene.elements), visible: true, props: {} };
    onChange([...scene.elements, added]);
    onSelect(added.id);
  };
  const upload = async (element: SceneElement, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const imageId = await onUpload(file);
    if (imageId) setProp(element, "image_id", imageId);
  };

  return (
    <div className={styles.panel}>
      <ul className={styles.list}>
        {stacked.map((element) => (
          <li key={element.id} className={styles.row}>
            <Checkbox aria-label={`Show ${element.type}`} checked={element.visible} onChange={(_, data) => patch(element.id, { visible: data.checked === true })} />
            <Button className={styles.grow} size="small" appearance={element.id === selectedId ? "primary" : "subtle"}
              aria-label={`Select ${element.type}`} onClick={() => onSelect(element.id)}>
              {element.type}
            </Button>
            <Button size="small" appearance="subtle" aria-label={`Bring ${element.type} forward`} onClick={() => onChange(raise(scene.elements, element.id))}>↑</Button>
            <Button size="small" appearance="subtle" aria-label={`Send ${element.type} back`} onClick={() => onChange(lower(scene.elements, element.id))}>↓</Button>
            <Button size="small" appearance="subtle" aria-label={`Remove ${element.type}`} onClick={() => onChange(scene.elements.filter((other) => other.id !== element.id))}>✕</Button>
          </li>
        ))}
      </ul>
      <div className={styles.row}>
        <Field label="Element type" className={styles.grow}>
          <Select value={type} onChange={(_, data) => setType(data.value as SceneElement["type"])}>
            {ELEMENT_TYPES.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </Select>
        </Field>
        <Button onClick={add} disabled={scene.elements.length >= 40}>Add element</Button>
      </div>
      {selected?.type === "text" && (
        <>
          <TextField label="Text" value={String(selected.props.text ?? "")} onCommit={(value) => setProp(selected, "text", value)} />
          <Field label="Size">
            <Input type="number" min={12} max={200} value={String(selected.props.size ?? 48)} onChange={(_, data) => Number(data.value) >= 12 && setProp(selected, "size", Number(data.value))} />
          </Field>
          <Field label="Alignment">
            <Select value={String(selected.props.align ?? "center")} onChange={(_, data) => setProp(selected, "align", data.value)}>
              <option value="left">Left</option>
              <option value="center">Centre</option>
              <option value="right">Right</option>
            </Select>
          </Field>
        </>
      )}
      {selected?.type === "narration" && (
        <Field label="Lines">
          <Select value={String(selected.props.lines ?? 3)} onChange={(_, data) => setProp(selected, "lines", Number(data.value))}>
            {[1, 2, 3, 4, 5, 6].map((count) => (
              <option key={count} value={count}>{count}</option>
            ))}
          </Select>
        </Field>
      )}
      {selected?.type === "pitch" && (
        <Switch label="Pressure map" checked={selected.props.pressure !== false} onChange={(_, data) => setProp(selected, "pressure", data.checked)} />
      )}
      {selected?.type === "image" && (
        <>
          <Field label="Image file" hint="PNG, JPEG or WebP, up to 2 MB">
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void upload(selected, event)} />
          </Field>
          <Field label="Fit">
            <Select value={String(selected.props.fit ?? "contain")} onChange={(_, data) => setProp(selected, "fit", data.value)}>
              <option value="contain">Show all of it</option>
              <option value="cover">Fill the box</option>
            </Select>
          </Field>
        </>
      )}
    </div>
  );
}

// --- banner ------------------------------------------------------------------------------------

interface BannerPanelProps {
  studio: Studio;
  onShow(text: string): Promise<boolean>;
  onClear(): void;
  onAuto(enabled: boolean): void;
}

export function BannerPanel({ studio, onShow, onClear, onAuto }: BannerPanelProps) {
  const styles = useStyles();
  const [text, setText] = useState("");
  const show = async () => {
    if (await onShow(text)) setText("");
  };
  return (
    <div className={styles.panel}>
      <Field label="Banner text">
        <Input value={text} maxLength={200} onChange={(_, data) => setText(data.value)} />
      </Field>
      <Button appearance="primary" disabled={text.trim() === ""} onClick={() => void show()}>Show banner</Button>
      {studio.banner ? (
        <div className={styles.item}>
          <Text size={200}>On screen</Text>
          <Text>{studio.banner.text}</Text>
          <Button size="small" onClick={onClear}>Clear banner</Button>
        </div>
      ) : (
        <Text size={200}>No banner on screen.</Text>
      )}
      {studio.banner_queue.length > 0 && <Text size={200}>{studio.banner_queue.length} waiting</Text>}
      <Switch label="Automatic banners for goals and red cards" checked={studio.settings.auto_banner} onChange={(_, data) => onAuto(data.checked)} />
    </div>
  );
}

// --- ticker ------------------------------------------------------------------------------------

export function TickerPanel({ ticker, onSave }: { ticker: Ticker; onSave(ticker: Ticker): void }) {
  const styles = useStyles();
  const [draft, setDraft] = useState(ticker);
  const [lines, setLines] = useState(ticker.messages.join("\n"));
  const saved = JSON.stringify(ticker);
  useEffect(() => {
    const current = JSON.parse(saved) as Ticker;
    setDraft(current);
    setLines(current.messages.join("\n"));
  }, [saved]);
  const messages = lines.split("\n").map((line) => line.trim()).filter(Boolean);
  return (
    <div className={styles.panel}>
      <Switch label="Ticker on" checked={draft.enabled} onChange={(_, data) => setDraft({ ...draft, enabled: data.checked })} />
      <Field label="Messages, one per line" hint="Up to 20 messages of 120 characters">
        <Textarea rows={5} value={lines} onChange={(_, data) => setLines(data.value)} />
      </Field>
      <Field label="Speed" hint="40 (slow) to 400 (fast)">
        <Input type="number" min={40} max={400} value={String(draft.speed)} onChange={(_, data) => setDraft({ ...draft, speed: Number(data.value) })} />
      </Field>
      <Switch label="Show the score" checked={draft.show_score} onChange={(_, data) => setDraft({ ...draft, show_score: data.checked })} />
      <Switch label="Show match stats" checked={draft.show_stats} onChange={(_, data) => setDraft({ ...draft, show_stats: data.checked })} />
      <Button appearance="primary" onClick={() => onSave({ ...draft, messages })}>Save ticker</Button>
    </div>
  );
}

// --- highlights --------------------------------------------------------------------------------

interface HighlightsPanelProps {
  match: MatchData;
  replaying: boolean;
  onReplay(moment: FeedMoment): void;
  onStopReplay(): void;
  onBanner(narrative: FeedNarrative): void;
}

export function HighlightsPanel({ match, replaying, onReplay, onStopReplay, onBanner }: HighlightsPanelProps) {
  const styles = useStyles();
  const newestFirst = [...match.moments].reverse();
  return (
    <div className={styles.panel}>
      {replaying && <Button onClick={onStopReplay}>Stop replay</Button>}
      {newestFirst.length === 0 && <Text size={200}>Key moments appear here as the match is played.</Text>}
      <ul className={styles.list}>
        {newestFirst.map((moment) => {
          const label = `${moment.minute}' ${t("en", `kind_${moment.kind}` as StringKey)}`;
          const narrative = match.narratives.find((line) => line.moment_id === moment.id);
          return (
            <li key={moment.id} className={styles.item}>
              <Text weight="semibold">{label}</Text>
              {narrative && <Text size={200}>{narrative.text}</Text>}
              <div className={styles.row}>
                <Button size="small" aria-label={`Replay ${label}`} onClick={() => onReplay(moment)}>Replay</Button>
                {narrative && (
                  <Button size="small" aria-label={`Show ${label} on banner`} onClick={() => onBanner(narrative)}>Show on banner</Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// --- countdown ---------------------------------------------------------------------------------

interface CountdownPanelProps {
  studio: Studio;
  /** The server's clock, Unix seconds. */
  now: number;
  onStart(startsAt: number): void;
  onBreak(minutes: number): void;
  onEnd(): void;
}

export function CountdownPanel({ studio, now, onStart, onBreak, onEnd }: CountdownPanelProps) {
  const styles = useStyles();
  const [startIn, setStartIn] = useState("10");
  const [breakFor, setBreakFor] = useState("5");
  const countdown = studio.countdown;
  const onBreakNow = countdown?.kind === "break";
  return (
    <div className={styles.panel}>
      {countdown && (
        <div className={styles.item}>
          <Text>{`${onBreakNow ? "Break" : "Kick-off"}: ${formatRemaining(countdown.ends_at - now)} left`}</Text>
          <Button size="small" onClick={onEnd}>{onBreakNow ? "End break" : "End countdown"}</Button>
        </div>
      )}
      <Field label="Start in (minutes)" hint="1 to 1440. The match starts and the program cuts to Live when it reaches zero.">
        <Input type="number" min={1} max={1440} value={startIn} onChange={(_, data) => setStartIn(data.value)} />
      </Field>
      <Button onClick={() => onStart(now + Number(startIn) * 60)} disabled={!(Number(startIn) >= 1)}>Start countdown</Button>
      <Field label="Break length (minutes)" hint="1 to 60. The program returns to the scene it left.">
        <Input type="number" min={1} max={60} value={breakFor} onChange={(_, data) => setBreakFor(data.value)} />
      </Field>
      <Button onClick={() => onBreak(Number(breakFor))} disabled={!(Number(breakFor) >= 1)}>Take a break</Button>
    </div>
  );
}

// --- settings ----------------------------------------------------------------------------------

export function SettingsPanel({ settings, onSave }: { settings: StudioSettings; onSave(settings: StudioSettings): void }) {
  const styles = useStyles();
  return (
    <div className={styles.panel}>
      <Field label="Program mode">
        <Select value={settings.mode} onChange={(_, data) => onSave({ ...settings, mode: data.value as Mode })}>
          <option value="fan">Fan</option>
          <option value="analyst">Analyst</option>
        </Select>
      </Field>
      <Field label="Program language">
        <Select value={settings.language} onChange={(_, data) => onSave({ ...settings, language: data.value as Language })}>
          {LANGUAGES.map((language) => (
            <option key={language} value={language}>{LANGUAGE_NAMES[language]}</option>
          ))}
        </Select>
      </Field>
      <Switch label="Start the match when the start countdown ends" checked={settings.auto_start} onChange={(_, data) => onSave({ ...settings, auto_start: data.checked })} />
      <Switch label="Take a break automatically at half-time" checked={settings.auto_half_time_break} onChange={(_, data) => onSave({ ...settings, auto_half_time_break: data.checked })} />
    </div>
  );
}
```

- [ ] **Step 4: Write the control page and add its route**

`apps/web/src/studio/StudioPage.tsx`:

```tsx
import { Badge, Link, makeStyles, MessageBar, MessageBarBody, Tab, TabList, Text, tokens } from "@fluentui/react-components";
import { useMemo, useState } from "react";
import type { Scene, SceneElement, Studio, ViewerProfile } from "../contracts";
import { useMatch } from "../stream/store";
import { type CurrentMatchOptions, useCurrentMatch } from "../stream/useCurrentMatch";
import {
  activateScene, clearBanner, createScene, deleteScene, deleteTemplate, endCountdown, saveScene, saveSettings,
  saveTemplate, saveTicker, showBanner, startBreak, startCountdown, startReplay, stopReplay, uploadImage,
} from "./api";
import { BannerPanel, CountdownPanel, ElementPanel, HighlightsPanel, SceneList, SettingsPanel, TickerPanel } from "./panels";
import { withReplayFallback } from "./ProgramPage";
import { SceneCanvas } from "./SceneCanvas";
import { useNow, useStudio } from "./useStudio";

const EDITOR_SCALE = 0.45;
const PREVIEW_SCALE = 0.16;
const TABS = ["Elements", "Banner", "Ticker", "Highlights", "Countdown", "Settings"] as const;
type TabName = (typeof TABS)[number];

const useStyles = makeStyles({
  page: { minHeight: "100vh", display: "flex", flexDirection: "column", backgroundColor: tokens.colorNeutralBackground2 },
  bar: {
    display: "flex", alignItems: "center", gap: tokens.spacingHorizontalL, padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXL}`,
    backgroundColor: tokens.colorNeutralBackground1, borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  grow: { flexGrow: 1 },
  body: { display: "grid", gridTemplateColumns: "300px auto minmax(320px, 1fr)", gap: tokens.spacingHorizontalXL, padding: tokens.spacingHorizontalXL, alignItems: "start" },
  card: { padding: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow2 },
  column: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
});

/** The streamer's control page: arrange scenes, switch them, and drive what is on the program. */
export function StudioPage({ eventSource, retryMs, pollMs }: CurrentMatchOptions) {
  const styles = useStyles();
  const { studio, offset, connected, accept } = useStudio(eventSource, retryMs);
  const mode = studio?.settings.mode;
  const language = studio?.settings.language;
  const profile = useMemo<ViewerProfile | null>(
    () => (mode && language ? { mode, language, club: null, player: null } : null),
    [mode, language],
  );
  const { matchId } = useCurrentMatch(profile, { eventSource, retryMs, pollMs });
  const match = useMatch((state) => state.data);
  const now = useNow() + offset;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabName>("Elements");
  // The scene as just edited, shown until the server's answer arrives.
  const [pending, setPending] = useState<Scene | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  if (!studio) {
    return (
      <main className={styles.page}>
        <div className={styles.bar}>
          <Text>Connecting to the studio…</Text>
        </div>
      </main>
    );
  }

  /** Sends one change, applies the server's answer, and reports a refusal. True when it was accepted. */
  const run = async (request: () => Promise<Studio>): Promise<boolean> => {
    try {
      accept(await request());
      setProblem(null);
      return true;
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The change was not saved.");
      return false;
    }
  };

  const onAir = studio.scenes.find((scene) => scene.id === studio.active_scene_id) ?? studio.scenes[0];
  const saved = studio.scenes.find((scene) => scene.id === editingId) ?? onAir;
  const editing = pending?.id === saved.id ? pending : saved;
  const data = { match, studio, now, language: studio.settings.language };

  const changeElements = async (elements: SceneElement[]) => {
    const edited = { ...editing, elements };
    setPending(edited);
    await run(() => saveScene(edited));
    setPending(null);
  };

  const upload = async (file: File) => {
    try {
      const imageId = await uploadImage(file);
      setProblem(null);
      return imageId;
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The image was not uploaded.");
      return null;
    }
  };

  return (
    <main className={styles.page}>
      <div className={styles.bar}>
        <Text as="h1" size={500} weight="semibold">Kickstream Studio</Text>
        <Badge color={connected ? "success" : "warning"}>{connected ? "Connected" : "Reconnecting"}</Badge>
        <Text className={styles.grow}>On air: {onAir.name}</Text>
        <Link href="/program" target="_blank" rel="noreferrer">Open program</Link>
      </div>
      {problem && (
        <MessageBar intent="error">
          <MessageBarBody>{problem}</MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.body}>
        <div className={styles.card}>
          <SceneList
            studio={studio}
            editingId={editing.id}
            onEdit={(sceneId) => {
              setEditingId(sceneId);
              setSelectedId(null);
            }}
            onActivate={(sceneId) => void run(() => activateScene(sceneId))}
            onCreate={(source, ref) => void run(() => createScene(source, ref))}
            onDelete={(sceneId) => void run(() => deleteScene(sceneId))}
            onSaveTemplate={(sceneId) => void run(() => saveTemplate(sceneId))}
            onDeleteTemplate={(templateId) => void run(() => deleteTemplate(templateId))}
          />
        </div>
        <div className={styles.column}>
          <section className={styles.card} aria-label="Editor">
            <Text as="h2" weight="semibold" block>Editing: {editing.name}</Text>
            <SceneCanvas scene={editing} data={data} scale={EDITOR_SCALE} editable selectedId={selectedId}
              onSelect={setSelectedId} onChange={(elements) => void changeElements(elements)} />
          </section>
          <section className={styles.card} aria-label="Program preview">
            <Text as="h2" weight="semibold" block>Program</Text>
            <SceneCanvas scene={withReplayFallback(onAir, studio)} data={data} scale={PREVIEW_SCALE} />
          </section>
        </div>
        <div className={styles.card}>
          <TabList selectedValue={tab} onTabSelect={(_, selection) => setTab(selection.value as TabName)}>
            {TABS.map((name) => (
              <Tab key={name} value={name}>{name}</Tab>
            ))}
          </TabList>
          <div role="tabpanel" aria-label={tab} style={{ paddingTop: tokens.spacingVerticalM }}>
            {tab === "Elements" && (
              <ElementPanel scene={editing} selectedId={selectedId} onSelect={setSelectedId}
                onChange={(elements) => void changeElements(elements)} onUpload={upload} />
            )}
            {tab === "Banner" && (
              <BannerPanel studio={studio}
                onShow={(text) => run(() => showBanner({ text, kind: "custom" }))}
                onClear={() => void run(clearBanner)}
                onAuto={(enabled) => void run(() => saveSettings({ ...studio.settings, auto_banner: enabled }))} />
            )}
            {tab === "Ticker" && <TickerPanel ticker={studio.ticker} onSave={(ticker) => void run(() => saveTicker(ticker))} />}
            {tab === "Highlights" && (
              <HighlightsPanel match={match} replaying={studio.replay !== null && studio.replay !== undefined}
                onReplay={(moment) => matchId && void run(() => startReplay(matchId, moment.id))}
                onStopReplay={() => void run(stopReplay)}
                onBanner={(narrative) => void run(() => showBanner({ text: narrative.text.slice(0, 200), kind: "info", source_id: narrative.id }))} />
            )}
            {tab === "Countdown" && (
              <CountdownPanel studio={studio} now={now}
                onStart={(startsAt) => void run(() => startCountdown(startsAt))}
                onBreak={(minutes) => void run(() => startBreak(minutes))}
                onEnd={() => void run(endCountdown)} />
            )}
            {tab === "Settings" && <SettingsPanel settings={studio.settings} onSave={(settings) => void run(() => saveSettings(settings))} />}
          </div>
        </div>
      </div>
    </main>
  );
}
```

In `apps/web/src/main.tsx`, import the page and add its route:

```tsx
import { StudioPage } from "./studio/StudioPage";
```

```tsx
/** The three pages: the fan dashboard, the streamer's studio, and the clean program output. */
function Page() {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/studio") return <StudioPage />;
  if (path === "/program") return <ProgramPage />;
  return <App />;
}
```

- [ ] **Step 5: Run every web test, the type check and the build**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: all pass; no type errors; the build succeeds.

- [ ] **Step 6: Try the studio by hand**

With `pnpm dev:api` and `pnpm dev:web` running, open `http://127.0.0.1:5173/studio` in one window and `http://127.0.0.1:5173/program` in another, and `http://127.0.0.1:5173/` in a third to start a match.

1. Click **Go live** on Live match. The program window cuts to it.
2. Drag the scoreboard in the editor. The program window follows when you let go.
3. Select an element and use the arrow keys, then Shift with the arrow keys.
4. Banner tab: show a custom banner. Wait for a goal: its banner appears by itself.
5. Ticker tab: add two messages and save. They scroll on the program.
6. Highlights tab: press **Replay** on a goal. The program shows the replay, then returns.
7. Countdown tab: take a 1-minute break. The program cuts to Break, counts down and returns by itself.
8. Countdown tab: start a countdown of 1 minute. The program cuts to Starting soon; at zero a new match starts and the program cuts to Live match.
9. Add an image element and upload a logo.
10. Stop and restart the API. Both studio windows reconnect, and the scenes are as you left them.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src
git commit -m "feat: add the studio control page"
```

---

### Task 9: End-to-end test, README and spec note

**Files:**
- Create: `apps/web/e2e/studio.spec.ts`
- Modify: `apps/web/playwright.config.ts` (a data directory for the test server), `.gitignore`, `README.md`, `docs/superpowers/specs/2026-10-12-kickstream-studio-design.md` (one line)

**Interfaces:**
- Consumes: the whole studio.
- Produces: `pnpm e2e` covers the studio across two pages. The test works on a scene it creates and removes, so it can run against a developer's own server without disturbing their scenes.

- [ ] **Step 1: Give the test server its own data directory**

In `apps/web/playwright.config.ts`, add the data directory to the environment of the API server:

```ts
const NO_MODEL = { KICKSTREAM_LLM_BASE_URL: "", KICKSTREAM_LLM_MODEL: "", KICKSTREAM_LLM_API_KEY: "" };
// A server Playwright starts itself keeps its studio apart from a developer's own.
const TEST_SERVER = { ...NO_MODEL, KICKSTREAM_DATA_DIR: ".data-e2e" };
```

and use `env: TEST_SERVER` for the first web server. Append to `.gitignore`:

```
.data-e2e/
```

- [ ] **Step 2: Write the end-to-end test**

`apps/web/e2e/studio.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

const API = "http://127.0.0.1:8000";

test("a streamer builds a scene, goes live, and drives the program", async ({ browser, request }) => {
  // Work on a scene of our own, and put the studio back afterwards.
  const before = await (await request.get(`${API}/api/studio`)).json();
  const made = await (await request.post(`${API}/api/studio/scenes`, { data: { source: "builtin", ref: "Live match", name: "E2E scene" } })).json();
  const sceneId = made.scenes.at(-1).id;

  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const control = await context.newPage();
  const program = await context.newPage();
  await program.setViewportSize({ width: 960, height: 540 });

  try {
    await control.goto("/studio");
    await program.goto("/program");

    // Scenes: going live cuts the program.
    await control.getByRole("button", { name: "Go live with E2E scene" }).click();
    await expect(control.getByText("On air: E2E scene")).toBeVisible();
    await expect(program.getByTestId("element-scoreboard")).toBeVisible();
    await expect(program.getByRole("button")).toHaveCount(0);

    // Canvas: dragging an element moves it on the program when the drag ends.
    await control.getByRole("button", { name: "Edit E2E scene" }).click();
    const leftBefore = await program.getByTestId("element-scoreboard").evaluate((node) => (node as HTMLElement).style.left);
    const handle = control.getByRole("region", { name: "Editor" }).getByRole("button", { name: "scoreboard element" });
    const box = (await handle.boundingBox())!;
    await control.mouse.move(box.x + 30, box.y + 20);
    await control.mouse.down();
    await control.mouse.move(box.x + 120, box.y + 20, { steps: 5 });
    await control.mouse.up();
    await expect
      .poll(() => program.getByTestId("element-scoreboard").evaluate((node) => (node as HTMLElement).style.left))
      .not.toBe(leftBefore);

    // Banner: a custom banner reaches the program.
    await control.getByRole("tab", { name: "Banner" }).click();
    await control.getByLabel("Banner text").fill("Welcome to matchday");
    await control.getByRole("button", { name: "Show banner" }).click();
    await expect(program.getByTestId("program-banner")).toHaveText("Welcome to matchday");

    // Match: the program follows it, and a goal can be replayed.
    await request.post(`${API}/api/matches`, { data: { speed: 600 } });
    await expect(program.getByTestId("program-score")).not.toHaveText("–", { timeout: 30_000 });
    await control.getByRole("tab", { name: "Highlights" }).click();
    await control.getByRole("button", { name: /^Replay \d+' Goal$/ }).first().click({ timeout: 30_000 });
    await expect(program.getByTestId("program-replay")).toBeVisible();
    await expect(program.getByTestId("program-replay")).toContainText("Replay");
    await expect(program.getByTestId("program-replay")).toHaveCount(0, { timeout: 15_000 });

    // Break: the program cuts away, counts down, and returns when the break is ended.
    await control.getByRole("tab", { name: "Countdown" }).click();
    await control.getByLabel("Break length (minutes)").fill("2");
    await control.getByRole("button", { name: "Take a break" }).click();
    await expect(program.getByTestId("program-countdown")).toContainText(/1:5\d/);
    await expect(program.getByTestId("element-scoreboard")).toHaveCount(0);
    await control.getByRole("button", { name: "End break" }).click();
    await expect(program.getByTestId("element-scoreboard")).toBeVisible();
    await expect(control.getByText("On air: E2E scene")).toBeVisible();
  } finally {
    await request.delete(`${API}/api/studio/countdown`);
    await request.delete(`${API}/api/studio/replay`);
    await request.delete(`${API}/api/studio/banner`);
    await request.post(`${API}/api/studio/scenes/${before.active_scene_id}/activate`);
    await request.delete(`${API}/api/studio/scenes/${sceneId}`);
    await context.close();
  }
});
```

- [ ] **Step 3: Run the end-to-end tests**

Run (from `apps/web`): `pnpm e2e`
Expected: 2 passed (the cycle 1 smoke test and the studio test).

- [ ] **Step 4: Document the studio**

In `README.md`, add this section after "AI narratives":

```markdown
## Studio

A streamer composes the picture at `/studio` and captures `/program`.

| Page | Use |
|---|---|
| `http://127.0.0.1:5173/studio` | Arrange scenes on a 16:9 canvas, switch them, and control banners, the ticker, replays and countdowns |
| `http://127.0.0.1:5173/program` | The scene that is on air, with no controls. Point a capture tool such as an OBS browser source at this page, at 1920 × 1080 |

- **Scenes** are saved canvases. Five templates are built in: Starting soon, Live match, Analyst desk, Break and Full-time. Drag and resize elements, or select one and use the arrow keys (Shift with the arrow keys resizes).
- **Banners** appear by themselves for goals and red cards. Any narration line can be sent to the banner from the Highlights tab, and the Banner tab takes your own text.
- **Replays** animate the 20 seconds of play before a key moment on the pitch.
- **Countdowns**: a start countdown starts the match and cuts to the Live scene at zero; a break cuts to the Break scene and returns to where you were.

Scenes, settings and uploaded images are kept in `.data/` (set `KICKSTREAM_DATA_DIR` to move it). The program page shows the match in the mode and language chosen in the studio's Settings tab.

Kickstream does not send video anywhere itself yet. To go live, capture `/program` with a streaming tool.
```

In `docs/superpowers/specs/2026-10-12-kickstream-studio-design.md`, add to the Decisions table:

```markdown
| Languages | The control page is in English; everything on the program page follows the program language |
| Start time | Entered as "start in N minutes" (1 to 1440) and converted to a time on the server's clock |
| Reconnecting | The first document a page receives after reconnecting replaces what it holds, even with a lower revision, because the server may have restarted from a reset file |
```

- [ ] **Step 5: Run every check**

```bash
(cd services/pipeline && uv run ruff check . && uv run ruff format --check . && uv run pytest -q)
(cd apps/web && pnpm typecheck && pnpm test && pnpm build && pnpm e2e)
```

Expected: no lint findings; all Python tests pass; no type errors; all web tests pass; the build succeeds; both end-to-end tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/e2e apps/web/playwright.config.ts .gitignore README.md docs/superpowers/specs
git commit -m "test: add studio end-to-end test and document the studio"
```

