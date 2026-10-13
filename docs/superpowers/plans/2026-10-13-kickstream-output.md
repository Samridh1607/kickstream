# Kickstream Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kickstream renders `/program` in a hidden browser, encodes it once with ffmpeg, and sends it to every enabled destination (YouTube, X, Facebook, Twitch, custom RTMP, or a file), controlled from a new Output tab in the studio.

**Architecture:** A new `output` stage owns an output document and pure rules, and supervises three ports: `ProgramCapture` (a hidden Chromium driven over the DevTools protocol), `Encoder` (one ffmpeg, WebM in, MPEG-TS out) and `Sender` (one ffmpeg per destination, copying without re-encoding). The program page captures its own tab plus an audio mix it owns, and sends the recording to the pipeline over a WebSocket guarded by a per-run token.

**Tech Stack:** Python 3.13, FastAPI, asyncio subprocesses, `websockets` (already a dependency) as the DevTools client, ffmpeg 8, Microsoft Edge or another Chromium; React 19, TypeScript, Fluent UI v9, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-13-kickstream-output-design.md`

## Global Constraints

- A stream key is a secret: no route returns one, none is written to a log, and a failure reason has the key removed.
- The browser flag `--use-fake-ui-for-media-stream` is never used. The program page refuses to record anything whose `displaySurface` is not `"browser"`.
- No test contacts a real platform. Tests that run ffmpeg or a browser are skipped where it is absent.
- Stages import only themselves, `contracts`, `domain` and `ports`; concrete adapters are named only in `app.py`.
- Message shapes live in `packages/contracts/kickstream.schema.json`; `kickstream/contracts.py` and `apps/web/src/contracts.ts` are generated, never edited by hand.
- Quality: `720p30` = 1280×720, 3,000 kbps video; `1080p30` = 1920×1080, 6,000 kbps video; AAC 128 kbps; a keyframe every 2 seconds.
- Limits: 10 destinations; name 1 to 40 characters; address begins `rtmp://` or `rtmps://`, at most 300 characters; key 1 to 300 characters with no whitespace; 20 recordings listed.
- Retry waits: 2, 4, 8, 16, 30 seconds, then 30; `failed` after 10 failures in a row with no time live between them.
- Start limit 20 seconds; whole-run restart once, stop if it fails again within 60 seconds; a process is killed 3 seconds after being asked to finish.
- Never run tests or changing requests against ports 8000 or 5173: the developer uses them. Browser tests use 8010 and 5183.
- Python commands run from `services/pipeline`; web commands from `apps/web`. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The streamer's desktop on air.** If the browser offers a screen or window instead of the tab, the page must refuse and stop the tracks. Pinned in Task 8 (`capture.test.ts`) and Task 6 (browser arguments).
2. **A key leaking.** A sender's error text contains the full address and key; the document, the failure reason and the logs must not. Pinned in Task 2 (`redact`, `view`) and Task 4.
3. **Processes left behind.** The pipeline killed mid-stream, or Stop pressed while a sender hangs. Pinned in Task 6 (`KillOnExit`) and Task 5 (stop within the grace period).
4. **A stale page feeding a new encoder.** After a whole-run restart, the old page's socket may still deliver bytes. Pinned in Task 4 (a feed with an old token is ignored).
5. **One slow destination.** A sender that stops reading must not grow memory or delay the others. Pinned in Task 4 (bounded buffer, restart on overflow).

## File Structure

| File | Responsibility |
|---|---|
| `packages/contracts/kickstream.schema.json` | Adds `Destination`, `Recording`, `Output` |
| `services/pipeline/kickstream/ports/output.py` | `Quality`, `Target`, `OutputFailure`, and the `RecordStore`, `ProgramCapture`, `Encoder`, `Sender` protocols |
| `services/pipeline/kickstream/output/rules.py` | Pure rules: destinations, run states, retry schedule, redaction, views, load and dump |
| `services/pipeline/kickstream/output/service.py` | Holds the state; supervises a run |
| `services/pipeline/kickstream/output/api.py` | Studio routes and the capture socket |
| `services/pipeline/kickstream/adapters/ffmpeg.py` | `FfmpegEncoder`, `FfmpegSender` |
| `services/pipeline/kickstream/adapters/process_group.py` | `KillOnExit` |
| `services/pipeline/kickstream/adapters/chromium_capture.py` | `ChromiumCapture` |
| `services/pipeline/kickstream/adapters/json_record_store.py` | Gains `private=` |
| `apps/web/src/studio/capture.ts` | The program's audio mix and `startCapture` |
| `apps/web/src/output/api.ts`, `OutputTab.tsx` | The studio's Output tab |

---

### Task 1: Contracts

**Files:**
- Modify: `packages/contracts/kickstream.schema.json`
- Regenerate: `services/pipeline/kickstream/contracts.py`, `apps/web/src/contracts.ts`
- Modify: `apps/web/src/test/fixtures.ts`
- Test: `services/pipeline/tests/test_output_contracts.py`

**Interfaces:**
- Produces: Pydantic models and TypeScript types `Destination`, `Recording`, `Output`; fixtures `destination(over)` and `output(over)`.

- [ ] **Step 1: Write the failing test**

`services/pipeline/tests/test_output_contracts.py`:

```python
import pytest
from pydantic import ValidationError


def destination(**over):
    fields = {
        "id": "d1",
        "name": "YouTube",
        "platform": "youtube",
        "url": "rtmp://a.rtmp.youtube.com/live2",
        "enabled": True,
        "key_hint": "wxyz",
        "status": "idle",
    }
    return {**fields, **over}


def output(**over):
    fields = {
        "revision": 1,
        "server_time": 100.0,
        "destinations": [],
        "quality": "720p30",
        "state": "idle",
        "recordings": [],
    }
    return {**fields, **over}


def test_an_output_document_round_trips_and_starts_with_nothing_running():
    from kickstream.contracts import Output

    doc = Output.model_validate(output(destinations=[destination()]))
    assert doc.started_at is None and doc.problem is None
    assert doc.destinations[0].reason is None and doc.destinations[0].live_since is None
    assert Output.model_validate(doc.model_dump(mode="json")) == doc


@pytest.mark.parametrize(
    "bad",
    [
        output(quality="4k60"),
        output(state="paused"),
        output(destinations=[destination(platform="tiktok")]),
        output(destinations=[destination(status="sending")]),
        output(destinations=[destination(name="")]),
        output(destinations=[destination(key_hint="12345")]),
        output(destinations=[destination(id=f"d{n}") for n in range(11)]),
        output(recordings=[{"file": "a.mp4", "size_bytes": -1, "made_at": 1.0}]),
    ],
)
def test_values_outside_the_contract_are_refused(bad):
    from kickstream.contracts import Output

    with pytest.raises(ValidationError):
        Output.model_validate(bad)


def test_a_destination_has_no_place_for_a_key():
    from kickstream.contracts import Destination

    with pytest.raises(ValidationError):
        Destination.model_validate(destination(key="sk-live-secret"))
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_output_contracts.py -q`
Expected: FAIL with `ImportError: cannot import name 'Output'`

- [ ] **Step 3: Add the definitions to the schema**

Add these three entries at the end of `$defs` in `packages/contracts/kickstream.schema.json`:

```json
"Destination": {
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "name", "platform", "url", "enabled", "key_hint", "status"],
  "properties": {
    "id": { "type": "string", "minLength": 1, "maxLength": 64 },
    "name": { "type": "string", "minLength": 1, "maxLength": 40 },
    "platform": { "enum": ["youtube", "x", "facebook", "twitch", "custom", "file"] },
    "url": { "type": "string", "maxLength": 300 },
    "enabled": { "type": "boolean" },
    "key_hint": { "type": "string", "maxLength": 4 },
    "status": { "enum": ["idle", "connecting", "live", "retrying", "failed"] },
    "reason": { "type": ["string", "null"], "default": null },
    "live_since": { "type": ["number", "null"], "default": null }
  }
},
"Recording": {
  "type": "object",
  "additionalProperties": false,
  "required": ["file", "size_bytes", "made_at"],
  "properties": {
    "file": { "type": "string", "minLength": 1, "maxLength": 80 },
    "size_bytes": { "type": "integer", "minimum": 0 },
    "made_at": { "type": "number" }
  }
},
"Output": {
  "type": "object",
  "additionalProperties": false,
  "required": ["revision", "server_time", "destinations", "quality", "state", "recordings"],
  "properties": {
    "revision": { "type": "integer" },
    "server_time": { "type": "number" },
    "destinations": { "type": "array", "items": { "$ref": "#/$defs/Destination" }, "maxItems": 10 },
    "quality": { "enum": ["720p30", "1080p30"] },
    "state": { "enum": ["idle", "starting", "live", "stopping"] },
    "started_at": { "type": ["number", "null"], "default": null },
    "problem": { "type": ["string", "null"], "default": null },
    "recordings": { "type": "array", "items": { "$ref": "#/$defs/Recording" }, "maxItems": 20 }
  }
}
```

- [ ] **Step 4: Regenerate both sides**

Run: `uv run python -m kickstream.tools.gen_contracts` (from `services/pipeline`) and `pnpm gen:contracts` (from `apps/web`).
Expected: both exit 0; `git diff --stat` shows `contracts.py` and `contracts.ts` changed.

- [ ] **Step 5: Add the web fixtures**

Append to `apps/web/src/test/fixtures.ts`, adding `Destination` and `Output` to its `import type { … } from "../contracts"` line:

```ts
export const destination = (over: Partial<Destination> = {}): Destination => ({
  id: "d1", name: "YouTube", platform: "youtube", url: "rtmp://a.rtmp.youtube.com/live2", enabled: true,
  key_hint: "wxyz", status: "idle", reason: null, live_since: null, ...over,
});

export const output = (over: Partial<Output> = {}): Output => ({
  revision: 1, server_time: 1000, destinations: [], quality: "720p30", state: "idle", started_at: null,
  problem: null, recordings: [], ...over,
});
```

- [ ] **Step 6: Run the tests**

Run: `uv run pytest tests/test_output_contracts.py tests/test_contracts.py -q` and `pnpm typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts services/pipeline/kickstream/contracts.py services/pipeline/tests/test_output_contracts.py apps/web/src/contracts.ts apps/web/src/test/fixtures.ts
git commit -m "feat: add the output document to the shared contracts"
```

---

### Task 2: Ports and rules

**Files:**
- Create: `services/pipeline/kickstream/ports/output.py`
- Create: `services/pipeline/kickstream/output/__init__.py` (empty), `services/pipeline/kickstream/output/rules.py`
- Modify: `services/pipeline/tests/test_architecture.py` (add `"output"` to `STAGES`)
- Test: `services/pipeline/tests/test_output_rules.py`

**Interfaces:**
- Consumes: `Destination`, `Output`, `Recording` from Task 1; `Refusal` from `kickstream.domain.errors`.
- Produces, in `kickstream.ports.output`:
  - `Quality(width: int, height: int, video_kbps: int, audio_kbps: int = 128, fps: int = 30)` (frozen dataclass)
  - `Target(kind: Literal["rtmp", "file"], location: str)` (frozen dataclass)
  - `class OutputFailure(Exception)`: a failure whose message may be shown to the streamer
  - protocols `RecordStore`, `ProgramCapture`, `Encoder`, `Sender` (signatures in Step 3)
- Produces, in `kickstream.output.rules`: `OutputError`, `OutputState(doc, keys)`, `QUALITIES`, `DEFAULT_URLS`, `MAX_FAILURES`, `empty_state()`, `add_destination(state, name, platform, url, key)`, `edit_destination(state, destination_id, *, name, url, enabled, key=None)`, `remove_destination(state, destination_id)`, `set_quality(state, quality)`, `begin(state)`, `went_live(state, now)`, `restarting(state)`, `stopping(state)`, `finish(state, problem)`, `mark(state, destination_id, status, reason=None, now=None)`, `add_recording(state, file, size_bytes, now)`, `retry_delay(failures)`, `redact(text, key)`, `target_for(destination, key, recordings_dir, now)`, `view(state, now)`, `dump(state)`, `dump_keys(state)`, `load(record, keys_record)`.

- [ ] **Step 1: Write the failing tests**

`services/pipeline/tests/test_output_rules.py`:

```python
import re
from pathlib import Path

import pytest

from kickstream.output import rules
from kickstream.output.rules import OutputError
from kickstream.ports.output import Quality, Target

KEY = "sk-live-abcd-1234-wxyz"


def refused(change):
    with pytest.raises(OutputError) as caught:
        change()
    return caught.value.status, caught.value.field


def one(platform="youtube", url="", key=KEY, name="Main channel"):
    return rules.add_destination(rules.empty_state(), name, platform, url, key)


def test_the_qualities_are_the_two_the_spec_names():
    assert rules.QUALITIES == {"720p30": Quality(1280, 720, 3000), "1080p30": Quality(1920, 1080, 6000)}


def test_a_known_platform_gets_its_address_and_the_key_is_kept_beside_the_document():
    state = one()
    [dest] = state.doc.destinations
    assert (dest.name, dest.platform, dest.url) == ("Main channel", "youtube", "rtmp://a.rtmp.youtube.com/live2")
    assert (dest.enabled, dest.status, dest.key_hint) == (True, "idle", "wxyz")
    assert state.keys == {dest.id: KEY}
    assert KEY not in rules.view(state, 5.0).model_dump_json()
    assert rules.view(state, 5.0).server_time == 5.0


def test_a_pasted_key_loses_the_spaces_around_it_and_a_short_key_shows_nothing():
    state = one(key=f"  {KEY}\n")
    assert list(state.keys.values()) == [KEY]
    assert one(key="12345678").doc.destinations[0].key_hint == ""


def test_x_and_custom_need_an_address_and_a_file_needs_neither():
    assert refused(lambda: one(platform="x")) == (422, "url")
    assert refused(lambda: one(platform="custom")) == (422, "url")
    assert one(platform="custom", url="rtmps://ingest.example:443/app").doc.destinations[0].url == "rtmps://ingest.example:443/app"
    state = one(platform="file", key="", url="rtmp://ignored.example/x")
    assert state.doc.destinations[0].url == "" and state.keys == {}


@pytest.mark.parametrize(
    "url",
    ["http://example.com/live", "rtmp://", "rtmp:///app", "rtmp://host/a b", "rtmp://host/" + "a" * 300, "example.com"],
)
def test_an_address_that_is_not_rtmp_to_a_host_is_refused(url):
    assert refused(lambda: one(platform="custom", url=url)) == (422, "url")


@pytest.mark.parametrize("key", ["", "   ", "two words", "a" * 301, "line\nbreak"])
def test_a_key_must_be_1_to_300_characters_without_whitespace(key):
    assert refused(lambda: one(key=key)) == (422, "key")


@pytest.mark.parametrize("name", ["", "   ", "n" * 41])
def test_a_name_must_be_1_to_40_characters(name):
    assert refused(lambda: one(name=name)) == (422, "name")


def test_there_can_be_ten_destinations_and_no_more():
    state = rules.empty_state()
    for n in range(10):
        state = rules.add_destination(state, f"D{n}", "file", "", "")
    assert refused(lambda: rules.add_destination(state, "D10", "file", "", "")) == (409, "destinations")


def test_editing_without_a_key_keeps_the_stored_one_and_a_new_key_replaces_it():
    state = one()
    dest = state.doc.destinations[0]
    kept = rules.edit_destination(state, dest.id, name="Second", url="rtmp://b.example/live", enabled=False)
    assert kept.keys == {dest.id: KEY}
    assert (kept.doc.destinations[0].name, kept.doc.destinations[0].enabled) == ("Second", False)
    assert kept.doc.destinations[0].url == "rtmp://b.example/live"
    replaced = rules.edit_destination(state, dest.id, name="Main", url=dest.url, enabled=True, key="new-key-9999-0000")
    assert replaced.keys == {dest.id: "new-key-9999-0000"}
    assert replaced.doc.destinations[0].key_hint == "0000"
    assert refused(lambda: rules.edit_destination(state, "nope", name="x", url="", enabled=True)) == (404, "destination")


def test_removing_a_destination_removes_its_key():
    state = one()
    gone = rules.remove_destination(state, state.doc.destinations[0].id)
    assert gone.doc.destinations == [] and gone.keys == {}
    assert refused(lambda: rules.remove_destination(state, "nope")) == (404, "destination")


def test_quality_is_one_of_the_two():
    assert rules.set_quality(rules.empty_state(), "1080p30").doc.quality == "1080p30"
    assert refused(lambda: rules.set_quality(rules.empty_state(), "4k")) == (422, "quality")


def test_going_live_needs_an_enabled_destination_with_a_key():
    assert refused(lambda: rules.begin(rules.empty_state())) == (409, "destinations")
    state = one()
    dest = state.doc.destinations[0]
    off = rules.edit_destination(state, dest.id, name=dest.name, url=dest.url, enabled=False)
    assert refused(lambda: rules.begin(off)) == (409, "destinations")
    keyless = rules.OutputState(doc=state.doc, keys={})
    assert refused(lambda: rules.begin(keyless)) == (409, "key")


def test_a_run_moves_through_starting_live_stopping_and_back_to_idle():
    state = rules.add_destination(one(), "Recording", "file", "", "")
    first, second = state.doc.destinations
    state = rules.edit_destination(state, second.id, name="Recording", url="", enabled=False)
    started = rules.begin(state)
    assert started.doc.state == "starting" and started.doc.started_at is None
    assert [d.status for d in started.doc.destinations] == ["connecting", "idle"]
    assert refused(lambda: rules.begin(started)) == (409, "output")
    live = rules.went_live(started, 50.0)
    assert (live.doc.state, live.doc.started_at) == ("live", 50.0)
    assert rules.went_live(live, 60.0) is live
    again = rules.restarting(rules.mark(live, first.id, "live", now=51.0))
    assert again.doc.state == "starting" and again.doc.destinations[0].status == "connecting"
    assert rules.stopping(live).doc.state == "stopping"
    assert rules.stopping(rules.empty_state()).doc.state == "idle"
    done = rules.finish(rules.mark(live, first.id, "live", now=51.0), "The encoder stopped.")
    assert (done.doc.state, done.doc.started_at, done.doc.problem) == ("idle", None, "The encoder stopped.")
    assert done.doc.destinations[0].status == "idle" and done.doc.destinations[0].live_since is None
    assert rules.begin(done).doc.problem is None


@pytest.mark.parametrize("state_name", ["starting", "live", "stopping"])
def test_nothing_can_be_changed_while_a_run_is_in_progress(state_name):
    state = one()
    dest = state.doc.destinations[0]
    busy = rules.OutputState(doc=state.doc.model_copy(update={"state": state_name}), keys=state.keys)
    assert refused(lambda: rules.add_destination(busy, "More", "file", "", "")) == (409, "output")
    assert refused(lambda: rules.edit_destination(busy, dest.id, name="x", url=dest.url, enabled=True)) == (409, "output")
    assert refused(lambda: rules.remove_destination(busy, dest.id)) == (409, "output")
    assert refused(lambda: rules.set_quality(busy, "1080p30")) == (409, "output")


def test_a_destination_status_carries_its_reason_and_when_it_went_live():
    state = rules.begin(one())
    dest_id = state.doc.destinations[0].id
    live = rules.mark(state, dest_id, "live", now=70.0)
    assert (live.doc.destinations[0].status, live.doc.destinations[0].live_since) == ("live", 70.0)
    retrying = rules.mark(live, dest_id, "retrying", "Connection refused")
    assert (retrying.doc.destinations[0].status, retrying.doc.destinations[0].reason) == ("retrying", "Connection refused")
    assert rules.mark(state, "gone", "live", now=1.0) is state
    failed = rules.finish(rules.mark(state, dest_id, "failed", "Bad key"), None)
    assert (failed.doc.destinations[0].status, failed.doc.destinations[0].reason) == ("failed", "Bad key")


def test_retries_wait_2_4_8_16_30_and_then_30():
    assert [rules.retry_delay(n) for n in range(1, 9)] == [2, 4, 8, 16, 30, 30, 30, 30]
    assert rules.MAX_FAILURES == 10


def test_a_failure_reason_never_carries_the_key():
    text = f"Error opening output rtmp://a.example/live2/{KEY}: I/O error"
    assert KEY not in rules.redact(text, KEY)
    assert "rtmp://a.example/live2/" in rules.redact(text, KEY)
    assert rules.redact("Plain failure", "") == "Plain failure"
    assert len(rules.redact("x" * 900, KEY)) == 200


def test_a_target_is_the_address_with_the_key_or_a_new_file():
    state = one(platform="custom", url="rtmp://ingest.example/app/")
    dest = state.doc.destinations[0]
    assert rules.target_for(dest, KEY, Path("rec"), 0.0) == Target("rtmp", f"rtmp://ingest.example/app/{KEY}")
    file_dest = one(platform="file", key="").doc.destinations[0]
    target = rules.target_for(file_dest, "", Path("rec"), 1_800_000_000.0)
    assert target.kind == "file"
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}-\d{6}\.mp4", Path(target.location).name)
    assert Path(target.location).parent == Path("rec")


def test_the_twenty_newest_recordings_are_listed_newest_first():
    state = rules.empty_state()
    for n in range(22):
        state = rules.add_recording(state, f"r{n}.mp4", 1000 + n, float(n))
    assert len(state.doc.recordings) == 20
    assert (state.doc.recordings[0].file, state.doc.recordings[0].size_bytes) == ("r21.mp4", 1021)
    assert state.doc.recordings[-1].file == "r2.mp4"


def test_a_saved_state_loads_idle_with_its_keys_and_nothing_secret_in_the_document_record():
    state = rules.went_live(rules.begin(one()), 9.0)
    dest_id = state.doc.destinations[0].id
    state = rules.mark(state, dest_id, "live", now=9.0)
    record, keys = rules.dump(state), rules.dump_keys(state)
    assert KEY not in str(record) and keys == {"keys": {dest_id: KEY}}
    loaded = rules.load(record, keys)
    assert (loaded.doc.state, loaded.doc.started_at, loaded.doc.problem) == ("idle", None, None)
    assert (loaded.doc.destinations[0].status, loaded.doc.destinations[0].live_since) == ("idle", None)
    assert loaded.keys == {dest_id: KEY}


def test_a_destination_whose_key_was_lost_shows_no_key():
    state = one()
    loaded = rules.load(rules.dump(state), None)
    assert loaded.keys == {} and loaded.doc.destinations[0].key_hint == ""
    stray = rules.load(rules.dump(state), {"keys": {"someone-else": "k", state.doc.destinations[0].id: 5}})
    assert stray.keys == {}


def test_a_record_of_the_wrong_shape_cannot_be_loaded():
    with pytest.raises((ValueError, TypeError, KeyError)):
        rules.load({"doc": {"revision": "x"}}, None)
    with pytest.raises((ValueError, TypeError, KeyError)):
        rules.load({}, None)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_output_rules.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'kickstream.output'`

- [ ] **Step 3: Write the ports**

`services/pipeline/kickstream/ports/output.py`:

```python
"""What the output stage needs from the outside world: a browser, an encoder, senders and storage."""

from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Literal, Protocol


@dataclass(frozen=True)
class Quality:
    width: int
    height: int
    video_kbps: int
    audio_kbps: int = 128
    fps: int = 30


@dataclass(frozen=True)
class Target:
    """Where one sender delivers: an RTMP address with its key, or a file path."""

    kind: Literal["rtmp", "file"]
    location: str


class OutputFailure(Exception):
    """Something outside the pipeline failed. The message is written for the streamer."""


class RecordStore(Protocol):
    def load(self) -> dict | None:
        """The saved record, or None when there is none to use."""

    def save(self, record: dict) -> None:
        """Persist the record. Raises OSError when it could not be written."""

    def set_aside(self) -> None:
        """Move the saved record out of the way, so the next load finds nothing."""


class ProgramCapture(Protocol):
    """A hidden browser showing the program page, which records itself."""

    def available(self) -> str | None:
        """None when a browser can be started, else what is missing."""

    async def start(self, url: str, width: int, height: int) -> None:
        """Open the page at that size and have it start recording. Raises OutputFailure."""

    async def wait(self) -> None:
        """Returns when the browser has exited."""

    async def stop(self) -> None:
        """End the browser and everything it started. Safe to call when not started."""


class Encoder(Protocol):
    """Turns the page's recording into one encoded stream."""

    def available(self) -> str | None:
        """None when the encoder can be started, else what is missing."""

    async def start(self, quality: Quality) -> None:
        """Raises OutputFailure when it cannot be started."""

    async def write(self, data: bytes) -> None:
        """Give it more of the recording. Never raises; data for a stopped encoder is dropped."""

    def output(self) -> AsyncIterator[bytes]:
        """The encoded stream, in pieces a sender can start from. Ends when the encoder exits."""

    async def stop(self) -> None:
        """End the encoder. Safe to call when not started."""


class Sender(Protocol):
    """Delivers the encoded stream to one destination, without re-encoding."""

    async def start(self, target: Target, on_live: Callable[[], None]) -> None:
        """Begin delivering. `on_live` is called once the destination is receiving. Raises OutputFailure."""

    async def write(self, data: bytes) -> None:
        """Give it more of the stream. Never raises; data for a sender that has ended is dropped."""

    async def wait(self) -> str:
        """Returns when the sender has ended, with its last words. They may contain the key."""

    async def stop(self) -> None:
        """Ask it to finish, and end it if it has not within the grace period. Safe to call twice."""
```

- [ ] **Step 4: Write the rules**

`services/pipeline/kickstream/output/__init__.py` is empty.

`services/pipeline/kickstream/output/rules.py`:

```python
"""Every rule for destinations and for what a run may do.

Each rule takes a state and returns a new one; none mutates its argument. Time is passed in.
A broken limit raises `OutputError`. Stream keys live beside the document, never in it.
"""

import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from kickstream.contracts import Destination, Output, Recording
from kickstream.domain.errors import Refusal
from kickstream.ports.output import Quality, Target

MAX_DESTINATIONS = 10
MAX_RECORDINGS = 20
MAX_FAILURES = 10  # in a row, with no time live between them
MAX_REASON = 200
_RETRY_DELAYS_S = (2, 4, 8, 16, 30)
_HINT = 4
QUALITIES = {"720p30": Quality(1280, 720, 3000), "1080p30": Quality(1920, 1080, 6000)}
# X gives each account its own address, so it has no default.
DEFAULT_URLS = {
    "youtube": "rtmp://a.rtmp.youtube.com/live2",
    "facebook": "rtmps://live-api-s.facebook.com:443/rtmp/",
    "twitch": "rtmp://live.twitch.tv/app",
}


class OutputError(Refusal):
    """A change the output rules refuse."""


@dataclass(frozen=True)
class OutputState:
    doc: Output
    keys: Mapping[str, str] = field(default_factory=dict)  # destination id -> stream key


def empty_state() -> OutputState:
    return OutputState(
        doc=Output(revision=0, server_time=0.0, destinations=[], quality="720p30", state="idle", recordings=[])
    )


def _doc(state: OutputState, **changes) -> OutputState:
    return replace(state, doc=state.doc.model_copy(update=changes))


def _editable(state: OutputState) -> None:
    if state.doc.state != "idle":
        raise OutputError(409, "output", "Stop the stream before changing this.")


def _find(state: OutputState, destination_id: str) -> Destination:
    for destination in state.doc.destinations:
        if destination.id == destination_id:
            return destination
    raise OutputError(404, "destination", "That destination no longer exists.")


def _swap(state: OutputState, updated: Destination) -> OutputState:
    return _doc(state, destinations=[updated if d.id == updated.id else d for d in state.doc.destinations])


def _name(name: str) -> str:
    name = " ".join(name.split())
    if not 1 <= len(name) <= 40:
        raise OutputError(422, "name", "A destination needs a name of 1 to 40 characters.")
    return name


def _url(platform: str, url: str) -> str:
    if platform == "file":
        return ""
    url = url.strip() or DEFAULT_URLS.get(platform, "")
    if not url:
        raise OutputError(422, "url", "Enter the server address the platform gives you.")
    try:
        parts = urlsplit(url)
        scheme, host = parts.scheme, parts.hostname
    except ValueError:
        scheme, host = "", None
    if len(url) > 300 or any(c.isspace() for c in url) or scheme not in ("rtmp", "rtmps") or not host:
        raise OutputError(422, "url", "A server address begins with rtmp:// or rtmps:// and names a host.")
    return url


def _key(key: str) -> str:
    key = key.strip()  # a pasted key often brings a line break with it
    if not 1 <= len(key) <= 300 or any(c.isspace() for c in key):
        raise OutputError(422, "key", "A stream key is 1 to 300 characters with no spaces.")
    return key


def _hint(key: str) -> str:
    """The end of a key, to tell keys apart. A short key would be mostly given away, so it shows nothing."""
    return key[-_HINT:] if len(key) > 2 * _HINT else ""


# --- destinations ------------------------------------------------------------------------------


def add_destination(state: OutputState, name: str, platform: str, url: str, key: str) -> OutputState:
    _editable(state)
    if len(state.doc.destinations) >= MAX_DESTINATIONS:
        raise OutputError(409, "destinations", f"There can be at most {MAX_DESTINATIONS} destinations.")
    key = "" if platform == "file" else _key(key)
    destination = Destination(
        id=uuid.uuid4().hex[:8],
        name=_name(name),
        platform=platform,
        url=_url(platform, url),
        enabled=True,
        key_hint=_hint(key),
        status="idle",
    )
    keys = {**state.keys, destination.id: key} if key else state.keys
    return replace(_doc(state, destinations=[*state.doc.destinations, destination]), keys=keys)


def edit_destination(
    state: OutputState, destination_id: str, *, name: str, url: str, enabled: bool, key: str | None = None
) -> OutputState:
    _editable(state)
    current = _find(state, destination_id)
    changes: dict = {"name": _name(name), "url": _url(current.platform, url), "enabled": enabled}
    keys = state.keys
    if key is not None and current.platform != "file":
        key = _key(key)
        keys = {**state.keys, destination_id: key}
        changes["key_hint"] = _hint(key)
    return replace(_swap(state, current.model_copy(update=changes)), keys=keys)


def remove_destination(state: OutputState, destination_id: str) -> OutputState:
    _editable(state)
    _find(state, destination_id)
    remaining = [d for d in state.doc.destinations if d.id != destination_id]
    keys = {held: key for held, key in state.keys.items() if held != destination_id}
    return replace(_doc(state, destinations=remaining), keys=keys)


def set_quality(state: OutputState, quality: str) -> OutputState:
    _editable(state)
    if quality not in QUALITIES:
        raise OutputError(422, "quality", "Choose 720p30 or 1080p30.")
    return _doc(state, quality=quality)


# --- a run -------------------------------------------------------------------------------------


def _reset(destination: Destination, status: str) -> Destination:
    return destination.model_copy(update={"status": status, "reason": None, "live_since": None})


def begin(state: OutputState) -> OutputState:
    if state.doc.state != "idle":
        raise OutputError(409, "output", "The stream is already running.")
    enabled = [d for d in state.doc.destinations if d.enabled]
    if not enabled:
        raise OutputError(409, "destinations", "Turn on at least one destination first.")
    for destination in enabled:
        if destination.platform != "file" and destination.id not in state.keys:
            raise OutputError(409, "key", f"{destination.name} has no stream key. Add it again, or turn it off.")
    return restarting(_doc(state, problem=None))


def restarting(state: OutputState) -> OutputState:
    """Back to the beginning of a run: nothing is live until the encoder produces video again."""
    destinations = [_reset(d, "connecting" if d.enabled else "idle") for d in state.doc.destinations]
    return _doc(state, destinations=destinations, state="starting", started_at=None)


def went_live(state: OutputState, now: float) -> OutputState:
    return _doc(state, state="live", started_at=now) if state.doc.state == "starting" else state


def stopping(state: OutputState) -> OutputState:
    return _doc(state, state="stopping") if state.doc.state in ("starting", "live") else state


def finish(state: OutputState, problem: str | None) -> OutputState:
    """The run is over. A destination that failed keeps saying why until the next run."""
    destinations = [d if d.status == "failed" else _reset(d, "idle") for d in state.doc.destinations]
    return _doc(state, destinations=destinations, state="idle", started_at=None, problem=problem)


def mark(
    state: OutputState, destination_id: str, status: str, reason: str | None = None, now: float | None = None
) -> OutputState:
    current = next((d for d in state.doc.destinations if d.id == destination_id), None)
    if current is None:
        return state
    live_since = now if status == "live" else current.live_since
    return _swap(state, current.model_copy(update={"status": status, "reason": reason, "live_since": live_since}))


def add_recording(state: OutputState, file: str, size_bytes: int, now: float) -> OutputState:
    recording = Recording(file=file, size_bytes=size_bytes, made_at=now)
    return _doc(state, recordings=[recording, *state.doc.recordings][:MAX_RECORDINGS])


def retry_delay(failures: int) -> int:
    """Seconds to wait before the next try, after that many failures in a row."""
    return _RETRY_DELAYS_S[min(max(failures, 1), len(_RETRY_DELAYS_S)) - 1]


def redact(text: str, key: str) -> str:
    """A sender's last words, safe to show: the key removed, and no longer than a line."""
    if key:
        text = text.replace(key, "…")
    return text[:MAX_REASON]


def target_for(destination: Destination, key: str, recordings_dir: Path, now: float) -> Target:
    if destination.platform == "file":
        name = datetime.fromtimestamp(now).strftime("%Y-%m-%d-%H%M%S") + ".mp4"
        return Target("file", str(recordings_dir / name))
    return Target("rtmp", f"{destination.url.rstrip('/')}/{key}")


# --- views and storage ---------------------------------------------------------------------------


def view(state: OutputState, now: float) -> Output:
    return state.doc.model_copy(update={"server_time": now})


def dump(state: OutputState) -> dict:
    return {"doc": state.doc.model_dump(mode="json")}


def dump_keys(state: OutputState) -> dict:
    return {"keys": dict(state.keys)}


def load(record: dict, keys_record: dict | None) -> OutputState:
    """A saved state, as it should be after a restart: nothing running, nothing live."""
    doc = Output.model_validate(record["doc"])
    saved = (keys_record or {}).get("keys", {})
    saved = saved if isinstance(saved, dict) else {}
    ids = {d.id for d in doc.destinations}
    keys = {held: key for held, key in saved.items() if held in ids and isinstance(key, str) and key}
    destinations = [
        _reset(d, "idle").model_copy(update={"key_hint": d.key_hint if d.id in keys else ""})
        for d in doc.destinations
    ]
    doc = doc.model_copy(update={"destinations": destinations, "state": "idle", "started_at": None, "problem": None})
    return OutputState(doc=doc, keys=keys)
```

- [ ] **Step 5: Add the stage to the architecture test**

In `services/pipeline/tests/test_architecture.py`, change `STAGES` to:

```python
STAGES = {"simulator", "analytics", "narration", "overlay", "gateway", "studio", "audience", "output"}
```

- [ ] **Step 6: Run the tests**

Run: `uv run pytest tests/test_output_rules.py tests/test_architecture.py -q`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add services/pipeline/kickstream/ports/output.py services/pipeline/kickstream/output services/pipeline/tests/test_output_rules.py services/pipeline/tests/test_architecture.py
git commit -m "feat: add the output ports and rules"
```

---

### Task 3: A private record file

**Files:**
- Modify: `services/pipeline/kickstream/adapters/json_record_store.py`
- Test: `services/pipeline/tests/test_output_store.py`

**Interfaces:**
- Produces: `JsonRecordStore(path, private=False)`. With `private=True` the file is readable only by its owner where the system supports file modes.

- [ ] **Step 1: Write the failing test**

`services/pipeline/tests/test_output_store.py`:

```python
import stat
import sys

import pytest

from kickstream.adapters.json_record_store import JsonRecordStore


def test_a_private_record_round_trips(tmp_path):
    store = JsonRecordStore(tmp_path / "data" / "keys.json", private=True)
    assert store.load() is None
    store.save({"keys": {"d1": "sk-live"}})
    assert JsonRecordStore(tmp_path / "data" / "keys.json", private=True).load() == {"keys": {"d1": "sk-live"}}


@pytest.mark.skipif(sys.platform == "win32", reason="Windows has no owner-only file mode")
def test_a_private_record_is_readable_only_by_its_owner(tmp_path):
    path = tmp_path / "keys.json"
    JsonRecordStore(path, private=True).save({"keys": {}})
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_a_private_record_that_is_not_json_is_set_aside(tmp_path):
    path = tmp_path / "keys.json"
    path.write_text("{oops", encoding="utf-8")
    assert JsonRecordStore(path, private=True).load() is None
    assert (tmp_path / "keys.json.corrupt").exists()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/test_output_store.py -q`
Expected: FAIL with `TypeError: JsonRecordStore.__init__() got an unexpected keyword argument 'private'`

- [ ] **Step 3: Implement**

In `services/pipeline/kickstream/adapters/json_record_store.py`, add `import contextlib` and `import os` at the top, and replace `__init__` and `save`:

```python
    def __init__(self, path: Path, *, private: bool = False) -> None:
        self._path = Path(path)
        self._private = private  # holds secrets: readable only by its owner, where the system has file modes

    def save(self, record: dict) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(".tmp")
        temporary.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        if self._private:
            with contextlib.suppress(OSError):
                os.chmod(temporary, 0o600)
        temporary.replace(self._path)
```

- [ ] **Step 4: Run the tests**

Run: `uv run pytest tests/test_output_store.py tests/test_audience_adapters.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/pipeline/kickstream/adapters/json_record_store.py services/pipeline/tests/test_output_store.py
git commit -m "feat: let a record file be private to its owner"
```

---

### Task 4: The output service

**Files:**
- Create: `services/pipeline/kickstream/output/service.py`
- Create: `services/pipeline/tests/output_fakes.py`
- Test: `services/pipeline/tests/test_output_service.py`

**Interfaces:**
- Consumes: everything Task 2 produces; `JsonRecordStore` from Task 3 (in tests).
- Produces: `OutputService(store, keys, *, capture, encoder, new_sender, program_url, recordings_dir, now=time.time, sleep=asyncio.sleep, new_token=…, start_timeout_s=20.0, restart_window_s=60.0, buffer_s=10.0)` with:
  - `view() -> Output`, `changes() -> AsyncIterator[Output]`
  - `add_destination(name, platform, url, key)`, `edit_destination(destination_id, *, name, url, enabled, key=None)`, `remove_destination(destination_id)`, `set_quality(quality)` — synchronous, raise `OutputError`
  - `start() -> None` — synchronous, must be called on the event loop; raises `OutputError`
  - `async stop() -> None`
  - `accepts(token: str) -> bool`, `async feed(token: str, chunks: AsyncIterator[bytes]) -> None`
- Produces, in `tests/output_fakes.py`: `FakeCapture`, `FakeEncoder`, `FakeSender`, `Sleeps`, `FakeNow`, `until(check)`.

- [ ] **Step 1: Write the fakes**

`services/pipeline/tests/output_fakes.py`:

```python
"""Stand-ins for the browser, the encoder and the senders, driven by the test."""

import asyncio
import time
from pathlib import Path

from kickstream.ports.output import OutputFailure


class FakeNow:
    def __init__(self, at: float = 5_000.0) -> None:
        self.at = at

    def __call__(self) -> float:
        return self.at


class Sleeps:
    """Records each wait and returns at once, unless the test holds it."""

    def __init__(self) -> None:
        self.asked: list[float] = []
        self.gate = asyncio.Event()
        self.gate.set()

    async def __call__(self, seconds: float) -> None:
        self.asked.append(seconds)
        await asyncio.sleep(0)
        await self.gate.wait()


class FakeCapture:
    def __init__(self) -> None:
        self.started: list[tuple[str, int, int]] = []
        self.stopped = 0
        self.missing: str | None = None
        self.fails: str | None = None
        self._gone = asyncio.Event()

    def available(self) -> str | None:
        return self.missing

    async def start(self, url: str, width: int, height: int) -> None:
        if self.fails:
            raise OutputFailure(self.fails)
        self._gone = asyncio.Event()
        self.started.append((url, width, height))

    async def wait(self) -> None:
        await self._gone.wait()

    async def stop(self) -> None:
        self.stopped += 1

    def die(self) -> None:
        self._gone.set()

    @property
    def token(self) -> str:
        return self.started[-1][0].split("capture=")[1]


class FakeEncoder:
    def __init__(self) -> None:
        self.started: list = []
        self.written: list[bytes] = []
        self.stopped = 0
        self.missing: str | None = None
        self._out: asyncio.Queue = asyncio.Queue()

    def available(self) -> str | None:
        return self.missing

    async def start(self, quality) -> None:
        self._out = asyncio.Queue()
        self.started.append(quality)

    async def write(self, data: bytes) -> None:
        self.written.append(data)

    async def output(self):
        while (chunk := await self._out.get()) is not None:
            yield chunk

    async def stop(self) -> None:
        self.stopped += 1

    def emit(self, chunk: bytes = b"stream") -> None:
        self._out.put_nowait(chunk)

    def die(self) -> None:
        self._out.put_nowait(None)


class FakeSender:
    def __init__(self, made: list, *, exits_with: str | None = None, blocked: bool = False) -> None:
        made.append(self)
        self.target = None
        self.written: list[bytes] = []
        self.stopped = False
        self._exits_with = exits_with
        self._unblocked = asyncio.Event()
        if not blocked:
            self._unblocked.set()

    async def start(self, target, on_live) -> None:
        self.target = target
        self._on_live = on_live
        self._end = asyncio.get_running_loop().create_future()
        if target.kind == "file":
            path = Path(target.location)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"x" * 2048)
        if self._exits_with is not None:
            self._end.set_result(self._exits_with)

    async def write(self, data: bytes) -> None:
        await self._unblocked.wait()
        self.written.append(data)

    async def wait(self) -> str:
        return await asyncio.shield(self._end)

    async def stop(self) -> None:
        self.stopped = True

    def go_live(self) -> None:
        self._on_live()

    def exit(self, reason: str) -> None:
        self._end.set_result(reason)


async def until(check, timeout: float = 2.0) -> None:
    end = time.monotonic() + timeout
    while not check():
        if time.monotonic() > end:
            raise AssertionError("the condition was not reached")
        await asyncio.sleep(0.005)
```

- [ ] **Step 2: Write the failing tests**

`services/pipeline/tests/test_output_service.py`:

```python
import asyncio
import itertools

import pytest
from tests.output_fakes import FakeCapture, FakeEncoder, FakeNow, FakeSender, Sleeps, until

from kickstream.adapters.json_record_store import JsonRecordStore
from kickstream.output.rules import OutputError
from kickstream.output.service import OutputService
from kickstream.ports.output import Quality, Target

KEY = "sk-live-abcd-1234-wxyz"


class Kit:
    def __init__(self, tmp_path, **over) -> None:
        self.tmp_path = tmp_path
        self.capture, self.encoder, self.sleeps, self.now = FakeCapture(), FakeEncoder(), Sleeps(), FakeNow()
        self.senders: list[FakeSender] = []
        self.sender_options: dict = {}
        tokens = (f"token-{n}" for n in itertools.count(1))
        self.options = {
            "capture": self.capture,
            "encoder": self.encoder,
            "new_sender": lambda: FakeSender(self.senders, **self.sender_options),
            "program_url": "http://web.test/program",
            "recordings_dir": tmp_path / "recordings",
            "now": self.now,
            "sleep": self.sleeps,
            "new_token": lambda: next(tokens),
            **over,
        }
        self.service = self.build()

    def build(self) -> OutputService:
        return OutputService(
            JsonRecordStore(self.tmp_path / "output.json"),
            JsonRecordStore(self.tmp_path / "output-keys.json", private=True),
            **self.options,
        )

    def doc(self):
        return self.service.view()

    def status(self, index=0):
        return self.doc().destinations[index].status

    async def live(self) -> None:
        """Start, and let the encoder produce its first piece of stream."""
        self.service.start()
        await until(lambda: self.capture.started)
        self.encoder.emit(b"first")
        await until(lambda: self.doc().state == "live")


@pytest.fixture
def kit(tmp_path):
    return Kit(tmp_path)


def refused(change):
    with pytest.raises(OutputError) as caught:
        change()
    return caught.value.status, caught.value.field


def add_youtube(kit, name="YouTube"):
    kit.service.add_destination(name, "youtube", "", KEY)
    return kit.doc().destinations[-1].id


async def test_start_is_refused_with_nothing_enabled_or_something_missing(kit):
    assert refused(kit.service.start) == (409, "destinations")
    add_youtube(kit)
    kit.encoder.missing = "ffmpeg was not found."
    with pytest.raises(OutputError) as caught:
        kit.service.start()
    assert (caught.value.status, caught.value.message) == (503, "ffmpeg was not found.")
    kit.encoder.missing, kit.capture.missing = None, "No browser was found."
    assert refused(kit.service.start) == (503, "output")
    assert kit.doc().state == "idle" and kit.encoder.started == []


async def test_going_live_starts_the_encoder_then_the_page_then_a_sender_per_enabled_destination(kit):
    first = add_youtube(kit)
    kit.service.add_destination("Recording", "file", "", "")
    kit.service.add_destination("Spare", "custom", "rtmp://spare.example/app", "spare-key-000000")
    spare = kit.doc().destinations[2]
    kit.service.edit_destination(spare.id, name="Spare", url=spare.url, enabled=False)

    kit.service.start()
    assert kit.doc().state == "starting"
    assert refused(kit.service.start) == (409, "output")
    await until(lambda: kit.capture.started)
    assert kit.encoder.started == [Quality(1280, 720, 3000)]
    assert kit.capture.started == [("http://web.test/program?capture=token-1", 1280, 720)]
    assert kit.senders == []

    kit.encoder.emit(b"first")
    await until(lambda: len(kit.senders) == 2 and all(s.written for s in kit.senders))
    assert (kit.doc().state, kit.doc().started_at) == ("live", 5_000.0)
    assert kit.senders[0].target == Target("rtmp", f"rtmp://a.rtmp.youtube.com/live2/{KEY}")
    assert kit.senders[1].target.kind == "file"
    assert str(kit.tmp_path / "recordings") in kit.senders[1].target.location
    assert [s.written for s in kit.senders] == [[b"first"], [b"first"]]
    assert [d.status for d in kit.doc().destinations] == ["connecting", "connecting", "idle"]

    kit.now.at = 5_010.0
    kit.senders[0].go_live()
    assert (kit.status(0), kit.doc().destinations[0].live_since) == ("live", 5_010.0)
    assert kit.doc().destinations[0].id == first
    await kit.service.stop()


async def test_the_chosen_quality_sizes_the_encoder_and_the_page(kit):
    add_youtube(kit)
    kit.service.set_quality("1080p30")
    await kit.live()
    assert kit.encoder.started == [Quality(1920, 1080, 6000)]
    assert kit.capture.started[0][1:] == (1920, 1080)
    await kit.service.stop()


async def test_one_destination_failing_is_retried_without_touching_another(kit):
    add_youtube(kit)
    kit.service.add_destination("Other", "custom", "rtmp://other.example/app", "other-key-00000000")
    await kit.live()
    await until(lambda: len(kit.senders) == 2)
    for sender in kit.senders:
        sender.go_live()
    kit.sleeps.gate.clear()
    kit.senders[0].exit(f"Error opening rtmp://a.rtmp.youtube.com/live2/{KEY}: refused")
    await until(lambda: kit.status(0) == "retrying")
    reason = kit.doc().destinations[0].reason
    assert "refused" in reason and KEY not in reason
    assert kit.senders[0].stopped
    assert kit.status(1) == "live" and not kit.senders[1].stopped
    assert kit.sleeps.asked == [2]
    kit.sleeps.gate.set()
    await until(lambda: len(kit.senders) == 3 and kit.status(0) == "connecting")
    kit.encoder.emit(b"more")
    await until(lambda: kit.senders[2].written == [b"more"] and kit.senders[1].written[-1] == b"more")
    await kit.service.stop()


async def test_a_destination_that_keeps_failing_is_left_alone_after_ten_tries(kit):
    add_youtube(kit)
    kit.sender_options = {"exits_with": "Connection refused"}
    await kit.live()
    await until(lambda: kit.status() == "failed")
    assert len(kit.senders) == 10
    assert kit.sleeps.asked == [2, 4, 8, 16, 30, 30, 30, 30, 30]
    assert kit.doc().destinations[0].reason == "Connection refused"
    assert kit.doc().state == "live"
    await kit.service.stop()
    assert kit.status() == "failed"


async def test_time_live_resets_the_count_of_failures(kit):
    add_youtube(kit)
    await kit.live()
    for round_number in range(3):
        await until(lambda n=round_number: len(kit.senders) == n + 1)
        kit.senders[-1].go_live()
        kit.senders[-1].exit("dropped")
    await until(lambda: len(kit.senders) == 4)
    assert kit.sleeps.asked == [2, 2, 2]
    await kit.service.stop()


async def test_a_destination_that_falls_too_far_behind_is_restarted(tmp_path):
    kit = Kit(tmp_path, buffer_s=0.0001)  # room for about 39 bytes
    add_youtube(kit)
    kit.sender_options = {"blocked": True}
    await kit.live()
    await until(lambda: len(kit.senders) == 1)
    kit.sender_options = {}
    kit.sleeps.gate.clear()
    for _ in range(4):
        kit.encoder.emit(b"p" * 30)
    await until(lambda: kit.status() == "retrying")
    assert "behind" in kit.doc().destinations[0].reason
    assert kit.senders[0].stopped
    kit.sleeps.gate.set()
    await kit.service.stop()


async def test_the_browser_dying_restarts_the_whole_run_once(kit):
    add_youtube(kit)
    await kit.live()
    await until(lambda: len(kit.senders) == 1)
    kit.capture.die()
    await until(lambda: len(kit.capture.started) == 2)
    assert kit.doc().state == "starting" and kit.status() == "connecting"
    assert kit.capture.token == "token-2"
    assert len(kit.encoder.started) == 2 and kit.senders[0].stopped
    kit.encoder.emit(b"again")
    await until(lambda: kit.doc().state == "live" and len(kit.senders) == 2)

    kit.now.at += 59
    kit.capture.die()
    await until(lambda: kit.doc().state == "idle")
    assert kit.doc().problem == "The hidden browser stopped."
    assert len(kit.capture.started) == 2 and kit.senders[1].stopped
    assert not kit.service.accepts("token-2")


async def test_a_failure_long_after_the_last_one_restarts_again(kit):
    add_youtube(kit)
    await kit.live()
    kit.encoder.die()
    await until(lambda: len(kit.encoder.started) == 2)
    kit.encoder.emit(b"again")
    await until(lambda: kit.doc().state == "live")
    kit.now.at += 61
    kit.encoder.die()
    await until(lambda: len(kit.encoder.started) == 3)
    assert kit.doc().state == "starting" and kit.doc().problem is None
    await kit.service.stop()


async def test_no_video_within_the_start_limit_stops_the_run(tmp_path):
    kit = Kit(tmp_path, start_timeout_s=0.05)
    add_youtube(kit)
    kit.service.start()
    await until(lambda: kit.doc().state == "idle")
    assert "did not start" in kit.doc().problem
    assert len(kit.capture.started) == 1 and kit.capture.stopped == 1 and kit.encoder.stopped == 1


async def test_a_page_that_cannot_capture_stops_the_run_with_its_reason(kit):
    add_youtube(kit)
    kit.capture.fails = "The program page did not start."
    kit.service.start()
    await until(lambda: kit.doc().state == "idle")
    assert kit.doc().problem == "The program page did not start."
    assert len(kit.encoder.started) == 1 and kit.encoder.stopped == 1


async def test_stop_ends_everything_and_lists_the_recording(kit):
    add_youtube(kit)
    kit.service.add_destination("Recording", "file", "", "")
    await kit.live()
    await until(lambda: len(kit.senders) == 2)
    kit.senders[1].go_live()
    await kit.service.stop()
    assert kit.doc().state == "idle" and kit.doc().problem is None
    assert [d.status for d in kit.doc().destinations] == ["idle", "idle"]
    assert all(sender.stopped for sender in kit.senders)
    assert kit.capture.stopped == 1 and kit.encoder.stopped == 1
    [recording] = kit.doc().recordings
    assert recording.file.endswith(".mp4") and recording.size_bytes == 2048 and recording.made_at == 5_000.0
    await kit.service.stop()  # stopping when idle does nothing
    kit.service.start()  # and a new run can begin
    await kit.service.stop()


async def test_only_the_current_run_s_page_may_send_video(kit):
    add_youtube(kit)
    assert not kit.service.accepts("")
    await kit.live()
    assert kit.service.accepts("token-1")
    assert not kit.service.accepts("token-0") and not kit.service.accepts("")

    async def chunks(*pieces):
        for piece in pieces:
            yield piece

    await kit.service.feed("token-0", chunks(b"stale"))
    assert kit.encoder.written == []
    await kit.service.feed("token-1", chunks(b"one", b"two"))
    assert kit.encoder.written == [b"one", b"two"]
    # The page's socket closing while live means the page stopped: the run restarts.
    await until(lambda: len(kit.capture.started) == 2)
    assert not kit.service.accepts("token-1") and kit.service.accepts("token-2")
    await kit.service.stop()


async def test_an_old_page_finishing_does_not_disturb_the_run_that_replaced_it(kit):
    add_youtube(kit)
    await kit.live()
    release = asyncio.Event()

    async def old_page():
        yield b"old"
        await release.wait()
        yield b"late"

    feeding = asyncio.create_task(kit.service.feed("token-1", old_page()))
    await until(lambda: kit.encoder.written == [b"old"])
    kit.capture.die()
    await until(lambda: len(kit.capture.started) == 2)
    kit.encoder.emit(b"again")
    await until(lambda: kit.doc().state == "live")

    release.set()
    await feeding
    assert kit.encoder.written == [b"old"]  # the late piece never reached the new encoder
    kit.encoder.emit(b"still")
    await until(lambda: kit.senders[-1].written[-1:] == [b"still"])
    assert kit.doc().state == "live" and len(kit.capture.started) == 2
    await kit.service.stop()


async def test_destinations_survive_a_restart_with_their_keys_and_nothing_running(kit):
    dest_id = add_youtube(kit)
    kit.service.set_quality("1080p30")
    await kit.live()
    assert KEY not in kit.doc().model_dump_json()
    assert KEY not in (kit.tmp_path / "output.json").read_text(encoding="utf-8")
    again = kit.build()
    assert again.view().state == "idle" and again.view().quality == "1080p30"
    assert (again.view().destinations[0].id, again.view().destinations[0].key_hint) == (dest_id, "wxyz")
    again.start()  # the key came back with it
    await again.stop()
    await kit.service.stop()


async def test_a_corrupt_file_is_set_aside_and_the_output_starts_empty(tmp_path):
    (tmp_path / "output.json").write_text('{"doc": {"revision": "x"}}', encoding="utf-8")
    kit = Kit(tmp_path)
    assert kit.doc().destinations == []
    assert (tmp_path / "output.json.corrupt").exists()


async def test_a_change_that_cannot_be_saved_is_refused_and_not_applied(kit, monkeypatch):
    def fail(self, record):
        raise OSError("disk full")

    monkeypatch.setattr(JsonRecordStore, "save", fail)
    assert refused(lambda: add_youtube(kit)) == (503, "output")
    assert kit.doc().destinations == [] and kit.doc().revision == 0


async def test_pages_get_the_document_now_and_after_each_change(kit):
    stream = kit.service.changes()
    assert (await anext(stream)).revision == 0
    add_youtube(kit)
    assert [d.name for d in (await anext(stream)).destinations] == ["YouTube"]
    await stream.aclose()
```

- [ ] **Step 3: Run them to verify they fail**

Run: `uv run pytest tests/test_output_service.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'kickstream.output.service'`

- [ ] **Step 4: Write the service**

`services/pipeline/kickstream/output/service.py`:

```python
"""Holds the output state and runs a stream: the hidden browser, the encoder, and a sender per destination."""

import asyncio
import logging
import secrets
import time
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import replace
from pathlib import Path

from kickstream.contracts import Output
from kickstream.output import rules
from kickstream.output.rules import OutputError, OutputState
from kickstream.ports.output import Encoder, OutputFailure, ProgramCapture, Quality, RecordStore, Sender, Target

log = logging.getLogger(__name__)


class _Ended(Exception):
    """The run ended by itself. The message is what the streamer is told."""

    def __init__(self, message: str, *, retry: bool = True) -> None:
        super().__init__(message)
        self.retry = retry


class _Buffer:
    """Stream waiting for one sender. Bounded, so a slow destination cannot grow memory."""

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._chunks: deque[bytes] = deque()
        self._size = 0
        self._ready = asyncio.Event()
        self.overflowed = False

    def put(self, chunk: bytes) -> None:
        if self._size + len(chunk) > self._limit:
            self.overflowed = True
            self._chunks.clear()
            self._size = 0
        self._chunks.append(chunk)
        self._size += len(chunk)
        self._ready.set()

    async def get(self) -> bytes:
        while not self._chunks:
            self._ready.clear()
            await self._ready.wait()
        chunk = self._chunks.popleft()
        self._size -= len(chunk)
        return chunk

    def clear(self) -> None:
        self._chunks.clear()
        self._size = 0
        self.overflowed = False


class OutputService:
    def __init__(
        self,
        store: RecordStore,
        keys: RecordStore,
        *,
        capture: ProgramCapture,
        encoder: Encoder,
        new_sender: Callable[[], Sender],
        program_url: str,
        recordings_dir: Path,
        now: Callable[[], float] = time.time,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        new_token: Callable[[], str] = lambda: secrets.token_urlsafe(24),
        start_timeout_s: float = 20.0,
        restart_window_s: float = 60.0,
        buffer_s: float = 10.0,
    ) -> None:
        self._store = store
        self._keys = keys
        self._capture = capture
        self._encoder = encoder
        self._new_sender = new_sender
        self._program_url = program_url
        self._recordings_dir = Path(recordings_dir)
        self._now = now
        self._sleep = sleep
        self._new_token = new_token
        self._start_timeout_s = start_timeout_s
        self._restart_window_s = restart_window_s
        self._buffer_s = buffer_s
        self._state = self._load()
        self._listeners: set[asyncio.Event] = set()
        self._run: asyncio.Task | None = None
        self._token: str | None = None  # the page allowed to send video, one per attempt
        self._video = asyncio.Event()
        self._feed_lost = asyncio.Event()
        self._buffers: dict[str, _Buffer] = {}

    def _load(self) -> OutputState:
        record = self._store.load()
        if record is None:
            return rules.empty_state()
        try:
            return rules.load(record, self._keys.load())
        except (ValueError, TypeError, KeyError) as exc:
            log.warning("the saved output record cannot be used (%s); starting empty", type(exc).__name__)
            self._store.set_aside()
            return rules.empty_state()

    # --- reading and changing ---------------------------------------------------------------------

    def view(self) -> Output:
        return rules.view(self._state, self._now())

    def _apply(self, change: Callable[[OutputState], OutputState], *, save: bool = True) -> None:
        """Apply one rule. What a run does to the state is not saved: a restart begins idle anyway."""
        changed = change(self._state)
        if changed is self._state:
            return
        candidate = replace(changed, doc=changed.doc.model_copy(update={"revision": self._state.doc.revision + 1}))
        if save:
            try:
                if candidate.keys != self._state.keys:
                    self._keys.save(rules.dump_keys(candidate))
                self._store.save(rules.dump(candidate))
            except OSError as exc:
                raise OutputError(503, "output", "The change could not be saved. Nothing was changed.") from exc
        self._state = candidate
        for listener in self._listeners:
            listener.set()

    def add_destination(self, name: str, platform: str, url: str, key: str) -> None:
        self._apply(lambda state: rules.add_destination(state, name, platform, url, key))

    def edit_destination(
        self, destination_id: str, *, name: str, url: str, enabled: bool, key: str | None = None
    ) -> None:
        self._apply(
            lambda state: rules.edit_destination(
                state, destination_id, name=name, url=url, enabled=enabled, key=key
            )
        )

    def remove_destination(self, destination_id: str) -> None:
        self._apply(lambda state: rules.remove_destination(state, destination_id))

    def set_quality(self, quality: str) -> None:
        self._apply(lambda state: rules.set_quality(state, quality))

    async def changes(self) -> AsyncIterator[Output]:
        """The current document, then the latest one after each change."""
        listener = asyncio.Event()
        self._listeners.add(listener)
        try:
            yield self.view()
            while True:
                await listener.wait()
                listener.clear()
                yield self.view()
        finally:
            self._listeners.discard(listener)

    # --- a run --------------------------------------------------------------------------------------

    def start(self) -> None:
        begun = rules.begin(self._state)
        missing = self._encoder.available() or self._capture.available()
        if missing:
            raise OutputError(503, "output", missing)
        self._apply(lambda _: begun, save=False)
        self._run = asyncio.create_task(self._supervise())

    async def stop(self) -> None:
        run = self._run
        if run is None:
            return
        self._apply(rules.stopping, save=False)
        run.cancel()
        await asyncio.gather(run, return_exceptions=True)

    async def _supervise(self) -> None:
        """Run until stopped. A run that ends by itself is restarted once, then given up on."""
        problem: str | None = None
        last_failure: float | None = None
        try:
            while True:
                try:
                    await self._run_once()
                except _Ended as ended:
                    reason, retry = str(ended), ended.retry
                now = self._now()
                if not retry or (last_failure is not None and now - last_failure < self._restart_window_s):
                    problem = reason
                    return
                last_failure = now
                log.warning("the stream stopped (%s); restarting it", reason)
                self._apply(rules.restarting, save=False)
        finally:
            self._token = None
            self._run = None
            self._apply(lambda state: rules.finish(state, problem), save=False)

    async def _run_once(self) -> None:
        """One attempt: start everything, wait for something to end, then end the rest. Always raises."""
        quality = rules.QUALITIES[self._state.doc.quality]
        self._token = self._new_token()
        self._video = asyncio.Event()
        self._feed_lost = asyncio.Event()
        self._buffers = {}
        relays: list[asyncio.Task] = []
        watchers: list[asyncio.Task] = []
        try:
            await self._encoder.start(quality)
            fan = asyncio.create_task(self._fan_out(quality, relays))
            watchers.append(fan)
            await self._capture.start(
                f"{self._program_url}?capture={self._token}", quality.width, quality.height
            )
            gone = asyncio.create_task(self._capture.wait())
            lost = asyncio.create_task(self._feed_lost.wait())
            first = asyncio.create_task(self._video.wait())
            watchers += [gone, lost, first]
            endings = {fan, gone, lost}
            done, _ = await asyncio.wait(
                {*endings, first}, timeout=self._start_timeout_s, return_when=asyncio.FIRST_COMPLETED
            )
            if not done:
                raise _Ended("The program page did not start sending video in time.", retry=False)
            if not done & endings:
                done, _ = await asyncio.wait(endings, return_when=asyncio.FIRST_COMPLETED)
            if fan in done:
                if fan.exception() is not None:
                    log.error("the stream could not be passed on", exc_info=fan.exception())
                raise _Ended("The encoder stopped.")
            if gone in done:
                raise _Ended("The hidden browser stopped.")
            raise _Ended("The program page stopped sending video.")
        except OutputFailure as exc:
            raise _Ended(str(exc), retry=False) from exc
        finally:
            for task in [*watchers, *relays]:
                task.cancel()
            await asyncio.gather(*watchers, *relays, return_exceptions=True)
            await self._capture.stop()
            await self._encoder.stop()

    async def _fan_out(self, quality: Quality, relays: list[asyncio.Task]) -> None:
        """Hand every piece of the encoded stream to every destination's buffer."""
        limit = int((quality.video_kbps + quality.audio_kbps) * 1000 / 8 * self._buffer_s)
        async for chunk in self._encoder.output():
            if not self._video.is_set():
                self._video.set()
                self._apply(lambda state: rules.went_live(state, self._now()), save=False)
                for destination in self._state.doc.destinations:
                    if destination.enabled:
                        buffer = self._buffers[destination.id] = _Buffer(limit)
                        relays.append(asyncio.create_task(self._relay(destination.id, buffer)))
            for buffer in self._buffers.values():
                buffer.put(chunk)

    def _mark(self, destination_id: str, status: str, reason: str | None = None) -> None:
        now = self._now() if status == "live" else None
        self._apply(lambda state: rules.mark(state, destination_id, status, reason, now), save=False)

    async def _relay(self, destination_id: str, buffer: _Buffer) -> None:
        """Keep one destination supplied, starting its sender again when it ends."""
        failures = 0
        while True:
            was_live, reason = await self._attempt(destination_id, buffer)
            failures = 1 if was_live else failures + 1
            if failures >= rules.MAX_FAILURES:
                self._mark(destination_id, "failed", reason)
                return
            self._mark(destination_id, "retrying", reason)
            await self._sleep(rules.retry_delay(failures))

    async def _attempt(self, destination_id: str, buffer: _Buffer) -> tuple[bool, str]:
        """Run one sender until it ends. Returns whether it was ever live, and why it ended."""
        destination = next(d for d in self._state.doc.destinations if d.id == destination_id)
        key = self._state.keys.get(destination_id, "")
        target = rules.target_for(destination, key, self._recordings_dir, self._now())
        sender = self._new_sender()
        was_live = False

        def on_live() -> None:
            nonlocal was_live
            was_live = True
            self._mark(destination_id, "live")

        self._mark(destination_id, "connecting")
        buffer.clear()
        reason = ""
        try:
            await sender.start(target, on_live)
            reason = await self._deliver(buffer, sender)
        except OutputFailure as exc:
            reason = str(exc)
        finally:
            await sender.stop()
            self._list_recording(target)
        return was_live, rules.redact(reason or "The connection closed.", key)

    async def _deliver(self, buffer: _Buffer, sender: Sender) -> str:
        """Pass the stream on until the sender ends or falls too far behind. Returns why."""

        async def pump() -> None:
            while True:
                chunk = await buffer.get()
                if buffer.overflowed:
                    return
                await sender.write(chunk)

        pumping = asyncio.create_task(pump())
        ended = asyncio.create_task(sender.wait())
        try:
            done, _ = await asyncio.wait({pumping, ended}, return_when=asyncio.FIRST_COMPLETED)
            return ended.result() if ended in done else "It fell too far behind and was restarted."
        finally:
            pumping.cancel()
            ended.cancel()
            await asyncio.gather(pumping, ended, return_exceptions=True)

    def _list_recording(self, target: Target) -> None:
        if target.kind != "file":
            return
        path = Path(target.location)
        try:
            size = path.stat().st_size
        except OSError:
            return
        if size == 0:
            return
        try:
            self._apply(lambda state: rules.add_recording(state, path.name, size, self._now()))
        except OutputError as exc:
            log.warning("the recording %s could not be listed: %s", path.name, exc.message)

    # --- video from the program page --------------------------------------------------------------

    def accepts(self, token: str) -> bool:
        """Whether a page presenting this token is the one this run opened."""
        return self._token is not None and secrets.compare_digest(token, self._token)

    async def feed(self, token: str, chunks: AsyncIterator[bytes]) -> None:
        """Pass a page's recording to the encoder, for as long as that page is the current one."""
        if not self.accepts(token):
            return
        lost = self._feed_lost  # this attempt's, so an old page ending cannot stop a newer attempt
        try:
            async for chunk in chunks:
                if token != self._token:
                    return
                await self._encoder.write(chunk)
        finally:
            lost.set()
```

- [ ] **Step 5: Run the tests**

Run: `uv run pytest tests/test_output_service.py -q`
Expected: PASS

- [ ] **Step 6: Run the whole suite and the linter**

Run: `uv run ruff check . && uv run ruff format . && uv run pytest -q`
Expected: no lint findings; every test passes.

- [ ] **Step 7: Commit**

```bash
git add services/pipeline/kickstream/output/service.py services/pipeline/tests/output_fakes.py services/pipeline/tests/test_output_service.py
git commit -m "feat: add the output service that supervises a stream"
```

---

### Task 5: The ffmpeg encoder and sender

**Files:**
- Create: `services/pipeline/kickstream/adapters/ffmpeg.py`
- Test: `services/pipeline/tests/test_output_ffmpeg.py`

**Interfaces:**
- Consumes: `Quality`, `Target`, `OutputFailure` from `kickstream.ports.output`.
- Produces: `FfmpegEncoder(binary="ffmpeg")` and `FfmpegSender(binary="ffmpeg", grace_s=3.0)`, satisfying the `Encoder` and `Sender` protocols; `encoder_args(quality) -> list[str]`; `sender_args(target) -> list[str]`.

- [ ] **Step 1: Write the failing tests**

`services/pipeline/tests/test_output_ffmpeg.py`:

```python
import asyncio
import json
import shutil
import socket
import subprocess

import pytest
from tests.output_fakes import until

from kickstream.adapters.ffmpeg import FfmpegEncoder, FfmpegSender, encoder_args, sender_args
from kickstream.ports.output import Quality, Target

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is not installed")
QUALITY = Quality(1280, 720, 3000)


def test_the_encoder_is_asked_for_the_chosen_size_rate_and_a_keyframe_every_two_seconds():
    args = encoder_args(QUALITY)
    assert "scale=1280:720,fps=30" in args
    assert args[args.index("-b:v") + 1] == "3000k" and args[args.index("-g") + 1] == "60"
    assert args[args.index("-b:a") + 1] == "128k"
    assert args[-3:] == ["-f", "mpegts", "pipe:1"]


def test_a_sender_copies_without_encoding_to_flv_or_to_a_file_that_plays_if_cut_short():
    rtmp = sender_args(Target("rtmp", "rtmp://host/app/key"))
    assert rtmp[rtmp.index("-c") + 1] == "copy" and rtmp[-3:] == ["-f", "flv", "rtmp://host/app/key"]
    file = sender_args(Target("file", "out.mp4"))
    assert "+frag_keyframe+empty_moov+default_base_moof" in file and file[-1] == "out.mp4"
    assert file[file.index("-c") + 1] == "copy"


def test_a_missing_ffmpeg_is_reported_in_words():
    assert FfmpegEncoder("no-such-ffmpeg-binary").available().startswith("ffmpeg was not found")


@pytest.fixture(scope="module")
def recording(tmp_path_factory):
    """Three seconds of test picture and tone, in the format the program page records."""
    path = tmp_path_factory.mktemp("sample") / "sample.webm"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440",
         "-t", "3", "-c:v", "libvpx", "-b:v", "600k", "-c:a", "libopus", "-f", "webm", str(path)],
        check=True,
    )  # fmt: skip
    return path.read_bytes()


def probe(path) -> list[dict]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    )  # fmt: skip
    return json.loads(out.stdout)["streams"]


@needs_ffmpeg
async def test_a_recording_becomes_an_mp4_at_the_chosen_size_with_sound(tmp_path, recording):
    assert FfmpegEncoder().available() is None
    encoder, sender = FfmpegEncoder(), FfmpegSender()
    target = Target("file", str(tmp_path / "recordings" / "out.mp4"))
    live = []
    await encoder.start(QUALITY)
    await sender.start(target, lambda: live.append(True))

    async def pass_on():
        async for chunk in encoder.output():
            assert len(chunk) % 188 == 0
            await sender.write(chunk)

    passing = asyncio.create_task(pass_on())
    for start in range(0, len(recording), 32_000):
        await encoder.write(recording[start : start + 32_000])
    await until(lambda: live, timeout=30)
    await asyncio.sleep(1)
    await encoder.stop()
    await asyncio.wait_for(passing, 5)
    await sender.stop()
    await asyncio.wait_for(sender.wait(), 5)

    streams = {stream["codec_name"]: stream for stream in probe(target.location)}
    assert (streams["h264"]["width"], streams["h264"]["height"]) == (1280, 720)
    assert "aac" in streams
    await encoder.write(b"late")  # writing to a stopped encoder is dropped, not an error
    await sender.write(b"late")


@needs_ffmpeg
async def test_a_destination_that_refuses_the_connection_ends_the_sender_with_a_reason(recording):
    with socket.socket() as probe_socket:
        probe_socket.bind(("127.0.0.1", 0))
        port = probe_socket.getsockname()[1]
    encoder, sender = FfmpegEncoder(), FfmpegSender()
    live = []
    await encoder.start(QUALITY)
    await sender.start(Target("rtmp", f"rtmp://127.0.0.1:{port}/live/secret-key"), lambda: live.append(True))

    async def pass_on():
        async for chunk in encoder.output():
            await sender.write(chunk)

    passing = asyncio.create_task(pass_on())
    await encoder.write(recording)
    reason = await asyncio.wait_for(sender.wait(), 30)
    assert reason and not live
    await sender.stop()
    await encoder.stop()
    await asyncio.wait_for(passing, 5)


@needs_ffmpeg
async def test_stopping_ends_a_sender_that_will_not_finish_by_itself(tmp_path):
    sender = FfmpegSender(grace_s=0.5)
    await sender.start(Target("file", str(tmp_path / "never.mp4")), lambda: None)
    await asyncio.wait_for(sender.stop(), 5)
    await asyncio.wait_for(sender.wait(), 5)
    await sender.stop()  # twice is harmless
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_output_ffmpeg.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'kickstream.adapters.ffmpeg'`

- [ ] **Step 3: Write the adapters**

`services/pipeline/kickstream/adapters/ffmpeg.py`:

```python
"""The encoder and the senders, as ffmpeg processes fed through their standard input.

Each reads from a pipe, so it ends by itself when this process dies, however it dies.
"""

import asyncio
import contextlib
import shutil
from collections.abc import AsyncIterator, Callable
from pathlib import Path

from kickstream.ports.output import OutputFailure, Quality, Target

_TS_PACKET = 188  # MPEG-TS packets are this long; whole packets let a sender start anywhere
_READ = 64 * 1024
_QUIET = ["-hide_banner", "-loglevel", "error", "-nostats"]
_PROGRESS = (b"total_size=", b"out_time_us=")


def encoder_args(quality: Quality) -> list[str]:
    keyframe_every = str(quality.fps * 2)
    video = f"{quality.video_kbps}k"
    return [
        *_QUIET, "-fflags", "+genpts", "-analyzeduration", "2000000", "-i", "pipe:0",
        "-vf", f"scale={quality.width}:{quality.height},fps={quality.fps}",
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
        "-g", keyframe_every, "-keyint_min", keyframe_every, "-sc_threshold", "0",
        "-b:v", video, "-maxrate", video, "-bufsize", f"{2 * quality.video_kbps}k",
        "-c:a", "aac", "-b:a", f"{quality.audio_kbps}k", "-ar", "44100", "-ac", "2",
        "-f", "mpegts", "pipe:1",
    ]  # fmt: skip


def sender_args(target: Target) -> list[str]:
    copy = [*_QUIET, "-progress", "pipe:1", "-f", "mpegts", "-i", "pipe:0", "-c", "copy", "-bsf:a", "aac_adtstoasc"]
    if target.kind == "file":
        # Fragmented, so the file plays even if the recording is cut short.
        return [*copy, "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "-y", target.location]
    return [*copy, "-f", "flv", target.location]


async def _spawn(binary: str, args: list[str], **pipes) -> asyncio.subprocess.Process:
    try:
        return await asyncio.create_subprocess_exec(binary, *args, **pipes)
    except FileNotFoundError as exc:
        raise OutputFailure("ffmpeg was not found. Install it, or set KICKSTREAM_FFMPEG to its path.") from exc
    except NotImplementedError as exc:
        # Windows starts processes only from its default event loop, which `--reload` replaces.
        raise OutputFailure("The pipeline cannot start ffmpeg when it is run with --reload.") from exc


async def _write(process: asyncio.subprocess.Process | None, data: bytes) -> None:
    stdin = process.stdin if process is not None else None
    if stdin is None or stdin.is_closing():
        return
    with contextlib.suppress(OSError):  # the process has gone; its exit is reported elsewhere
        stdin.write(data)
        await stdin.drain()


async def _end(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        with contextlib.suppress(ProcessLookupError):
            process.kill()
    await process.wait()


class FfmpegEncoder:
    def __init__(self, binary: str = "ffmpeg") -> None:
        self._binary = binary
        self._process: asyncio.subprocess.Process | None = None

    def available(self) -> str | None:
        if shutil.which(self._binary) is None:
            return "ffmpeg was not found. Install it, or set KICKSTREAM_FFMPEG to its path."
        return None

    async def start(self, quality: Quality) -> None:
        self._process = await _spawn(
            self._binary, encoder_args(quality), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE
        )

    async def write(self, data: bytes) -> None:
        await _write(self._process, data)

    async def output(self) -> AsyncIterator[bytes]:
        process = self._process
        if process is None or process.stdout is None:
            return
        carry = b""
        while data := await process.stdout.read(_READ):
            carry += data
            whole = len(carry) - len(carry) % _TS_PACKET
            if whole:
                yield carry[:whole]
                carry = carry[whole:]

    async def stop(self) -> None:
        process, self._process = self._process, None
        if process is not None:
            await _end(process)  # nothing to finish: what it has not yet produced is not wanted


class FfmpegSender:
    def __init__(self, binary: str = "ffmpeg", *, grace_s: float = 3.0) -> None:
        self._binary = binary
        self._grace_s = grace_s
        self._process: asyncio.subprocess.Process | None = None
        self._following: asyncio.Task | None = None
        self._last_words = ""

    async def start(self, target: Target, on_live: Callable[[], None]) -> None:
        if target.kind == "file":
            Path(target.location).parent.mkdir(parents=True, exist_ok=True)
        self._process = await _spawn(
            self._binary,
            sender_args(target),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,  # kept here and never logged: it can contain the key
        )
        self._following = asyncio.create_task(self._follow(self._process, on_live))

    async def _follow(self, process: asyncio.subprocess.Process, on_live: Callable[[], None]) -> None:
        async def progress() -> None:
            live = False
            async for line in process.stdout:
                for field in _PROGRESS:
                    amount = line[len(field) :].strip()
                    if not live and line.startswith(field) and amount.isdigit() and int(amount) > 0:
                        live = True
                        on_live()

        async def errors() -> None:
            async for line in process.stderr:
                text = line.decode("utf-8", "replace").strip()
                if text:
                    self._last_words = text

        await asyncio.gather(progress(), errors())

    async def write(self, data: bytes) -> None:
        await _write(self._process, data)

    async def wait(self) -> str:
        if self._process is not None:
            await self._process.wait()
        if self._following is not None:
            await asyncio.gather(self._following, return_exceptions=True)
        return self._last_words

    async def stop(self) -> None:
        process = self._process
        if process is None:
            return
        if process.stdin is not None and not process.stdin.is_closing():
            with contextlib.suppress(OSError):
                process.stdin.close()  # the end of its input: it finishes what it has and exits
        try:
            await asyncio.wait_for(process.wait(), self._grace_s)
        except TimeoutError:
            await _end(process)
```

- [ ] **Step 4: Run the tests**

Run: `uv run pytest tests/test_output_ffmpeg.py -q`
Expected: PASS (6 tests; 3 skipped where ffmpeg is absent)

- [ ] **Step 5: Lint, run the suite, commit**

Run: `uv run ruff check . && uv run ruff format . && uv run pytest -q`
Expected: clean and green.

```bash
git add services/pipeline/kickstream/adapters/ffmpeg.py services/pipeline/tests/test_output_ffmpeg.py
git commit -m "feat: add the ffmpeg encoder and sender"
```

---

### Task 6: The hidden browser

**Files:**
- Create: `services/pipeline/kickstream/adapters/process_group.py`
- Create: `services/pipeline/kickstream/adapters/chromium_capture.py`
- Test: `services/pipeline/tests/test_output_browser.py`

**Interfaces:**
- Consumes: `OutputFailure` from `kickstream.ports.output`; the `websockets` package.
- Produces: `KillOnExit()` with `add(pid)` and `close()`; `find_browser(configured: str | None) -> str | None`; `browser_args(profile: Path, width: int, height: int) -> list[str]`; `ChromiumCapture(browser: str | None = None, *, ready_timeout_s: float = 15.0)` satisfying `ProgramCapture`.
- Contract with the program page (Task 8): once it is ready, the page defines `window.__kickstreamStartCapture`, a function returning a promise that resolves when recording has begun and rejects with an `Error` otherwise.

- [ ] **Step 1: Write the failing tests**

`services/pipeline/tests/test_output_browser.py`:

```python
import asyncio
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from kickstream.adapters.chromium_capture import ChromiumCapture, browser_args, find_browser
from kickstream.adapters.process_group import KillOnExit
from kickstream.ports.output import OutputFailure

needs_browser = pytest.mark.skipif(find_browser(None) is None, reason="no Chromium-based browser is installed")
SLEEPER = [sys.executable, "-c", "import time; time.sleep(120)"]

CAPTURES = """<!doctype html><title>t</title><script>
window.__kickstreamStartCapture = async () => {
  if (window.innerWidth !== 1280 || window.innerHeight !== 720) throw new Error(`size ${innerWidth}x${innerHeight}`);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true, audio: false, preferCurrentTab: true, selfBrowserSurface: "include" });
  const surface = stream.getVideoTracks()[0].getSettings().displaySurface;
  if (surface !== "browser") throw new Error(`surface ${surface}`);
};
</script>"""
REFUSES = "<!doctype html><script>window.__kickstreamStartCapture = async () => { throw new Error('no camera here'); };</script>"
NEVER_READY = "<!doctype html><title>nothing</title>"


@pytest.fixture
def pages():
    """A local web server with the three pages above."""
    bodies = {"/captures": CAPTURES, "/refuses": REFUSES, "/never": NEVER_READY}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = bodies.get(self.path.split("?")[0], "").encode()
            self.send_response(200 if body else 404)
            self.send_header("content-type", "text/html")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def test_the_browser_is_never_told_to_pick_a_screen_by_itself(tmp_path):
    args = browser_args(tmp_path, 1280, 720)
    assert "--use-fake-ui-for-media-stream" not in args
    assert "--auto-accept-this-tab-capture" in args and "--headless=new" in args
    assert "--window-size=1280,720" in args and f"--user-data-dir={tmp_path}" in args


def test_a_configured_browser_that_does_not_exist_is_not_found():
    assert find_browser("no-such-browser-binary") is None
    capture = ChromiumCapture("no-such-browser-binary")
    assert capture.available().startswith("No Chromium-based browser was found")


def test_closing_the_group_ends_the_processes_in_it():
    process = subprocess.Popen(SLEEPER)
    group = KillOnExit()
    group.add(process.pid)
    group.close()
    assert process.wait(timeout=10) is not None
    group.close()  # twice is harmless


@pytest.mark.skipif(sys.platform != "win32", reason="only Windows can tie a process to its parent's life")
def test_a_process_in_the_group_dies_when_its_owner_is_killed():
    owner = subprocess.Popen(
        [sys.executable, "-c",
         "import subprocess, sys, time\n"
         "from kickstream.adapters.process_group import KillOnExit\n"
         f"child = subprocess.Popen({SLEEPER!r})\n"
         "group = KillOnExit(); group.add(child.pid)\n"
         "print(child.pid, flush=True); time.sleep(120)\n"],
        stdout=subprocess.PIPE, text=True,
    )  # fmt: skip
    child_pid = int(owner.stdout.readline())
    owner.kill()
    owner.wait(timeout=10)

    def alive() -> bool:
        listed = subprocess.run(["tasklist", "/FI", f"PID eq {child_pid}", "/NH"], capture_output=True, text=True)
        return str(child_pid) in listed.stdout

    for _ in range(50):
        if not alive():
            break
        threading.Event().wait(0.1)
    assert not alive()


@needs_browser
async def test_the_page_records_its_own_tab_at_the_asked_size_and_stop_ends_the_browser(pages):
    capture = ChromiumCapture()
    assert capture.available() is None
    await capture.start(f"{pages}/captures", 1280, 720)
    waiting = asyncio.create_task(capture.wait())
    await asyncio.sleep(0.2)
    assert not waiting.done()
    await capture.stop()
    await asyncio.wait_for(waiting, 10)
    await capture.stop()  # twice is harmless


@needs_browser
async def test_a_page_that_cannot_capture_reports_why_and_leaves_no_browser(pages):
    capture = ChromiumCapture()
    with pytest.raises(OutputFailure, match="no camera here"):
        await capture.start(f"{pages}/refuses", 1280, 720)
    await asyncio.wait_for(capture.wait(), 10)


@needs_browser
async def test_a_page_that_never_becomes_ready_is_given_up_on(pages):
    capture = ChromiumCapture(ready_timeout_s=1.0)
    with pytest.raises(OutputFailure, match="did not start"):
        await capture.start(f"{pages}/never?capture=secret-token", 1280, 720)
    await asyncio.wait_for(capture.wait(), 10)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_output_browser.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'kickstream.adapters.chromium_capture'`

- [ ] **Step 3: Write the process group**

`services/pipeline/kickstream/adapters/process_group.py`:

```python
"""Processes that must not outlive this one.

A browser does not exit when the program that started it dies. On Windows a job object ends
its processes when the last handle to it closes, which the system does when this process dies
for any reason. Elsewhere the processes are ended only when `close` is called.
"""

import contextlib
import os
import signal
import sys

if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    _KILL_ON_JOB_CLOSE = 0x2000
    _EXTENDED_LIMIT_INFORMATION = 9
    _SET_QUOTA_AND_TERMINATE = 0x0100 | 0x0001

    class _BasicLimits(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class _ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _BasicLimits),
            ("IoInfo", ctypes.c_uint64 * 6),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    _kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel.CreateJobObjectW.restype = wintypes.HANDLE
    _kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    _kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    _kernel.OpenProcess.restype = wintypes.HANDLE
    _kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    _kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    _kernel.CloseHandle.argtypes = [wintypes.HANDLE]


class KillOnExit:
    """Ends every process added to it when closed and, on Windows, when this process dies."""

    def __init__(self) -> None:
        self._pids: list[int] = []
        self._job = None
        if sys.platform == "win32":
            self._job = _kernel.CreateJobObjectW(None, None)
            limits = _ExtendedLimits()
            limits.BasicLimitInformation.LimitFlags = _KILL_ON_JOB_CLOSE
            _kernel.SetInformationJobObject(
                self._job, _EXTENDED_LIMIT_INFORMATION, ctypes.byref(limits), ctypes.sizeof(limits)
            )

    def add(self, pid: int) -> None:
        self._pids.append(pid)
        if self._job:
            handle = _kernel.OpenProcess(_SET_QUOTA_AND_TERMINATE, False, pid)
            if handle:
                _kernel.AssignProcessToJobObject(self._job, handle)
                _kernel.CloseHandle(handle)

    def close(self) -> None:
        if self._job:
            _kernel.TerminateJobObject(self._job, 1)
            _kernel.CloseHandle(self._job)
            self._job = None
        elif sys.platform != "win32":
            for pid in self._pids:
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.kill(pid, signal.SIGKILL)
        self._pids = []
```

- [ ] **Step 4: Write the capture adapter**

`services/pipeline/kickstream/adapters/chromium_capture.py`:

```python
"""The program page in a hidden Chromium, told over the DevTools protocol to record itself."""

import asyncio
import contextlib
import itertools
import json
import os
import shutil
import tempfile
import urllib.request
from pathlib import Path

import websockets

from kickstream.adapters.process_group import KillOnExit
from kickstream.ports.output import OutputFailure

_MISSING = "No Chromium-based browser was found. Install Microsoft Edge, or set KICKSTREAM_BROWSER to a browser's path."
_NAMES = ("msedge", "microsoft-edge", "google-chrome", "chromium", "chromium-browser", "chrome")
_START = "window.__kickstreamStartCapture()"
_READY = "typeof window.__kickstreamStartCapture === 'function'"


def _installed() -> list[Path]:
    roots = [os.environ.get(name) for name in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA")]
    windows = [
        Path(root) / vendor
        for root in roots
        if root
        for vendor in ("Microsoft/Edge/Application/msedge.exe", "Google/Chrome/Application/chrome.exe")
    ]
    mac = [
        Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ]
    return [*windows, *mac]


def find_browser(configured: str | None) -> str | None:
    """The browser to use: the configured one, else Edge, else another Chromium."""
    if configured:
        return configured if Path(configured).is_file() else shutil.which(configured)
    for path in _installed():
        if path.is_file():
            return str(path)
    return next((found for name in _NAMES if (found := shutil.which(name))), None)


def browser_args(profile: Path, width: int, height: int) -> list[str]:
    # `--use-fake-ui-for-media-stream` must never appear here: with it the browser offers the
    # whole screen, and the streamer's desktop would go on air.
    return [
        "--headless=new",
        f"--user-data-dir={profile}",
        "--remote-debugging-port=0",
        "--auto-accept-this-tab-capture",
        "--autoplay-policy=no-user-gesture-required",
        f"--window-size={width},{height}",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "about:blank",
    ]


def _page_socket(port: int) -> str:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5) as response:
        targets = json.load(response)
    address = next((target["webSocketDebuggerUrl"] for target in targets if target.get("type") == "page"), None)
    if address is None:
        raise OSError("the browser opened no page")
    return address


class ChromiumCapture:
    def __init__(self, browser: str | None = None, *, ready_timeout_s: float = 15.0) -> None:
        self._configured = browser
        self._ready_timeout_s = ready_timeout_s
        self._process: asyncio.subprocess.Process | None = None
        self._group: KillOnExit | None = None
        self._devtools = None
        self._profile: Path | None = None
        self._ids = itertools.count(1)

    def available(self) -> str | None:
        return None if find_browser(self._configured) else _MISSING

    async def start(self, url: str, width: int, height: int) -> None:
        binary = find_browser(self._configured)
        if binary is None:
            raise OutputFailure(_MISSING)
        self._profile = Path(tempfile.mkdtemp(prefix="kickstream-browser-"))
        try:
            self._process = await asyncio.create_subprocess_exec(
                binary,
                *browser_args(self._profile, width, height),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            self._group = KillOnExit()
            self._group.add(self._process.pid)
            port = await self._debugging_port()
            address = await asyncio.to_thread(_page_socket, port)
            # Kept open for the life of the capture: the page size set below lasts only as long as it.
            self._devtools = await websockets.connect(address, max_size=None, ping_interval=None)
            await self._call(
                "Emulation.setDeviceMetricsOverride", width=width, height=height, deviceScaleFactor=1, mobile=False
            )
            await self._call("Page.navigate", url=url)
            await self._until_ready(url)
            # A page may only ask to be captured in answer to a user's action; this stands in for one.
            started = await self._call("Runtime.evaluate", expression=_START, awaitPromise=True, userGesture=True)
            if "exceptionDetails" in started:
                why = started["exceptionDetails"].get("exception", {}).get("description", "unknown reason")
                raise OutputFailure(f"The program page could not record itself: {why.splitlines()[0]}")
        except OutputFailure:
            await self.stop()
            raise
        except (OSError, TimeoutError, NotImplementedError, websockets.WebSocketException) as exc:
            await self.stop()
            raise OutputFailure(f"The hidden browser could not be started ({type(exc).__name__}).") from exc

    async def _debugging_port(self) -> int:
        """The browser writes the port it chose into its profile once it is listening."""
        port_file = self._profile / "DevToolsActivePort"
        for _ in range(100):
            with contextlib.suppress(OSError, ValueError, IndexError):
                return int(port_file.read_text(encoding="utf-8").splitlines()[0])
            if self._process.returncode is not None:
                raise OSError("the browser exited at once")
            await asyncio.sleep(0.1)
        raise TimeoutError

    async def _call(self, method: str, **params) -> dict:
        call_id = next(self._ids)
        await self._devtools.send(json.dumps({"id": call_id, "method": method, "params": params}))
        while True:
            message = json.loads(await asyncio.wait_for(self._devtools.recv(), 30))
            if message.get("id") == call_id:
                if "error" in message:
                    raise OutputFailure(f"The hidden browser refused {method}.")
                return message.get("result", {})

    async def _until_ready(self, url: str) -> None:
        deadline = asyncio.get_running_loop().time() + self._ready_timeout_s
        while asyncio.get_running_loop().time() < deadline:
            answer = await self._call("Runtime.evaluate", expression=_READY, returnByValue=True)
            if answer.get("result", {}).get("value") is True:
                return
            await asyncio.sleep(0.25)
        # The address is shown without its query, which carries the run's token.
        raise OutputFailure(f"The program page did not start. Check that it opens at {url.split('?')[0]}")

    async def wait(self) -> None:
        if self._process is not None:
            await self._process.wait()

    async def stop(self) -> None:
        devtools, self._devtools = self._devtools, None
        if devtools is not None:
            with contextlib.suppress(Exception):
                await devtools.close()
        group, self._group = self._group, None
        if group is not None:
            group.close()
        process = self._process
        if process is not None and process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()
        profile, self._profile = self._profile, None
        if profile is not None:
            await asyncio.to_thread(shutil.rmtree, profile, True)
```

- [ ] **Step 5: Run the tests**

Run: `uv run pytest tests/test_output_browser.py -q`
Expected: PASS (8 tests; the browser tests are skipped where no browser is installed, and one test only runs on Windows)

- [ ] **Step 6: Lint, run the suite, commit**

Run: `uv run ruff check . && uv run ruff format . && uv run pytest -q`
Expected: clean and green.

```bash
git add services/pipeline/kickstream/adapters/process_group.py services/pipeline/kickstream/adapters/chromium_capture.py services/pipeline/tests/test_output_browser.py
git commit -m "feat: add the hidden browser that records the program page"
```

---

### Task 7: Routes and wiring

**Files:**
- Create: `services/pipeline/kickstream/output/api.py`
- Modify: `services/pipeline/kickstream/app.py`
- Test: `services/pipeline/tests/test_output_api.py`

**Interfaces:**
- Consumes: `OutputService` (Task 4), `FfmpegEncoder`, `FfmpegSender` (Task 5), `ChromiumCapture` (Task 6), `JsonRecordStore(private=)` (Task 3), `pump`, `refuse`, `same_host`, `REFUSED` from `kickstream.domain.sockets`.
- Produces: `build_output_router(*, service, socket_hosts=())`; `Settings.program_url` (`KICKSTREAM_PROGRAM_URL`, default `http://127.0.0.1:5173/program`), `Settings.browser` (`KICKSTREAM_BROWSER`), `Settings.ffmpeg` (`KICKSTREAM_FFMPEG`, default `ffmpeg`); `create_app(..., capture=None, encoder=None, new_sender=None)`; `Pipeline.output`.
- Routes: `GET /api/studio/output`, `GET /api/studio/output/stream`, `WS /api/studio/output/socket`, `POST /api/studio/output/destinations`, `PUT` and `DELETE /api/studio/output/destinations/{id}`, `PUT /api/studio/output/quality`, `POST /api/studio/output/start`, `POST /api/studio/output/stop`, `WS /api/output/capture/socket?token=`.

- [ ] **Step 1: Write the failing tests**

`services/pipeline/tests/test_output_api.py`:

```python
import json
import time

import pytest
from fastapi.testclient import TestClient
from tests.output_fakes import FakeCapture, FakeEncoder, FakeNow, FakeSender
from starlette.websockets import WebSocketDisconnect

from kickstream.adapters.clocks import InstantClock
from kickstream.app import Settings, create_app

BASE = "/api/studio/output"
KEY = "sk-live-abcd-1234-wxyz"
YOUTUBE = {"name": "YouTube", "platform": "youtube", "key": KEY}


class Rig:
    def __init__(self, tmp_path) -> None:
        self.capture, self.encoder, self.senders = FakeCapture(), FakeEncoder(), []
        settings = Settings(
            None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data", program_url="http://web.test/program"
        )
        self.app = create_app(
            settings,
            clock_factory=lambda speed: InstantClock(),
            match_prefix="m",
            now=FakeNow(),
            capture=self.capture,
            encoder=self.encoder,
            new_sender=lambda: FakeSender(self.senders),
        )


@pytest.fixture
def rig(tmp_path):
    return Rig(tmp_path)


@pytest.fixture
def client(rig):
    with TestClient(rig.app) as test_client:
        yield test_client


def field(response):
    return response.json()["detail"][0]["loc"][-1]


def wait_for(check, timeout=3.0):
    end = time.monotonic() + timeout
    while not check():
        assert time.monotonic() < end, "the condition was not reached"
        time.sleep(0.01)


def test_settings_read_the_program_address_the_browser_and_ffmpeg_from_the_environment():
    defaults = Settings.from_env({})
    assert (defaults.program_url, defaults.browser, defaults.ffmpeg) == ("http://127.0.0.1:5173/program", None, "ffmpeg")
    custom = Settings.from_env(
        {"KICKSTREAM_PROGRAM_URL": "http://h:1/program", "KICKSTREAM_BROWSER": "C:/edge.exe", "KICKSTREAM_FFMPEG": "C:/ff.exe"}
    )
    assert (custom.program_url, custom.browser, custom.ffmpeg) == ("http://h:1/program", "C:/edge.exe", "C:/ff.exe")


def test_a_destination_is_added_and_its_key_never_comes_back(client):
    assert client.get(BASE).json()["destinations"] == []
    added = client.post(f"{BASE}/destinations", json=YOUTUBE)
    assert added.status_code == 200
    [dest] = added.json()["destinations"]
    assert (dest["name"], dest["url"], dest["key_hint"]) == ("YouTube", "rtmp://a.rtmp.youtube.com/live2", "wxyz")
    assert KEY not in added.text and KEY not in client.get(BASE).text


def test_refusals_name_the_field(client):
    assert field(client.post(f"{BASE}/destinations", json={**YOUTUBE, "key": "two words"})) == "key"
    custom = {"name": "Mine", "platform": "custom", "url": "http://nope", "key": KEY}
    refused = client.post(f"{BASE}/destinations", json=custom)
    assert (refused.status_code, field(refused)) == (422, "url")
    assert client.post(f"{BASE}/destinations", json={**YOUTUBE, "platform": "tiktok"}).status_code == 422
    assert client.post(f"{BASE}/destinations", json={**YOUTUBE, "extra": 1}).status_code == 422
    assert client.put(f"{BASE}/quality", json={"quality": "4k"}).status_code == 422
    missing = client.put(f"{BASE}/destinations/nope", json={"name": "x", "url": "", "enabled": True})
    assert (missing.status_code, field(missing)) == (404, "destination")
    assert client.delete(f"{BASE}/destinations/nope").status_code == 404
    start = client.post(f"{BASE}/start")
    assert (start.status_code, field(start)) == (409, "destinations")


def test_a_destination_is_changed_and_removed(client):
    dest = client.post(f"{BASE}/destinations", json=YOUTUBE).json()["destinations"][0]
    changed = client.put(f"{BASE}/destinations/{dest['id']}", json={"name": "Second", "url": dest["url"], "enabled": False})
    assert (changed.json()["destinations"][0]["name"], changed.json()["destinations"][0]["enabled"]) == ("Second", False)
    assert changed.json()["destinations"][0]["key_hint"] == "wxyz"
    assert client.put(f"{BASE}/quality", json={"quality": "1080p30"}).json()["quality"] == "1080p30"
    assert client.delete(f"{BASE}/destinations/{dest['id']}").json()["destinations"] == []


def test_go_live_and_stop(client, rig):
    client.post(f"{BASE}/destinations", json=YOUTUBE)
    started = client.post(f"{BASE}/start")
    assert (started.status_code, started.json()["state"]) == (200, "starting")
    wait_for(lambda: rig.capture.started)
    rig.encoder.emit(b"first")
    wait_for(lambda: client.get(BASE).json()["state"] == "live")
    busy = client.post(f"{BASE}/destinations", json={"name": "More", "platform": "file"})
    assert (busy.status_code, field(busy)) == (409, "output")
    assert client.post(f"{BASE}/start").status_code == 409
    stopped = client.post(f"{BASE}/stop")
    assert (stopped.status_code, stopped.json()["state"]) == (200, "idle")
    assert rig.capture.stopped == 1 and rig.encoder.stopped == 1
    assert client.post(f"{BASE}/stop").json()["state"] == "idle"


def test_something_missing_is_a_503_that_says_what(client, rig):
    client.post(f"{BASE}/destinations", json=YOUTUBE)
    rig.encoder.missing = "ffmpeg was not found. Install it."
    refused = client.post(f"{BASE}/start")
    assert refused.status_code == 503
    assert refused.json()["detail"][0]["msg"] == "ffmpeg was not found. Install it."


def test_the_document_is_followed_over_a_socket_and_as_events(client):
    with client.websocket_connect(f"{BASE}/socket") as socket:
        assert json.loads(socket.receive_text())["revision"] == 0
        client.post(f"{BASE}/destinations", json=YOUTUBE)
        after = json.loads(socket.receive_text())
        assert after["destinations"][0]["name"] == "YouTube" and KEY not in json.dumps(after)
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect(f"{BASE}/socket", headers={"origin": "http://evil.example"}) as socket:
            socket.receive_text()
    assert refused.value.code == 1008


def test_only_the_page_with_the_run_s_token_may_send_video(client, rig):
    client.post(f"{BASE}/destinations", json=YOUTUBE)
    client.post(f"{BASE}/start")
    wait_for(lambda: rig.capture.started)
    for query in ("", "?token=wrong"):
        with pytest.raises(WebSocketDisconnect) as refused:
            with client.websocket_connect(f"/api/output/capture/socket{query}") as socket:
                socket.receive_bytes()
        assert refused.value.code == 1008
    with client.websocket_connect(f"/api/output/capture/socket?token={rig.capture.token}") as socket:
        socket.send_bytes(b"one")
        socket.send_bytes(b"two")
        wait_for(lambda: rig.encoder.written == [b"one", b"two"])
    client.post(f"{BASE}/stop")


def test_shutting_the_pipeline_down_stops_a_stream(rig):
    with TestClient(rig.app) as client:
        client.post(f"{BASE}/destinations", json=YOUTUBE)
        client.post(f"{BASE}/start")
        wait_for(lambda: rig.capture.started)
    assert rig.capture.stopped == 1 and rig.encoder.stopped == 1
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_output_api.py -q`
Expected: FAIL with `TypeError: Settings.__init__() got an unexpected keyword argument 'program_url'`

- [ ] **Step 3: Write the router**

`services/pipeline/kickstream/output/api.py`:

```python
from collections.abc import Collection
from typing import Literal

from fastapi import APIRouter, WebSocket
from pydantic import BaseModel, ConfigDict, Field
from sse_starlette.sse import EventSourceResponse
from starlette.websockets import WebSocketDisconnect

from kickstream.contracts import Output
from kickstream.domain.sockets import REFUSED, pump, refuse, same_host
from kickstream.output.service import OutputService

_TEXT = 2000  # generous bound on request text; the rules give each field its real limit and message
BASE = "/api/studio/output"


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NewDestination(_Body):
    name: str = Field(max_length=_TEXT)
    platform: Literal["youtube", "x", "facebook", "twitch", "custom", "file"]
    url: str = Field(default="", max_length=_TEXT)
    key: str = Field(default="", max_length=_TEXT)


class ChangedDestination(_Body):
    name: str = Field(max_length=_TEXT)
    url: str = Field(default="", max_length=_TEXT)
    enabled: bool
    key: str | None = Field(default=None, max_length=_TEXT)


class NewQuality(_Body):
    quality: str = Field(max_length=20)


def build_output_router(*, service: OutputService, socket_hosts: Collection[str] = ()) -> APIRouter:
    router = APIRouter()

    # Every route is async: the service belongs to the event loop and starts tasks on it.

    @router.get(BASE)
    async def get_output() -> Output:
        return service.view()

    @router.get(f"{BASE}/stream")
    async def get_output_stream() -> EventSourceResponse:
        async def documents():
            async for doc in service.changes():
                yield {"id": str(doc.revision), "data": doc.model_dump_json()}

        return EventSourceResponse(documents())

    @router.websocket(f"{BASE}/socket")
    async def output_socket(websocket: WebSocket) -> None:
        async def documents():
            async for doc in service.changes():
                yield doc.model_dump_json()

        await pump(websocket, documents(), socket_hosts)

    @router.post(f"{BASE}/destinations")
    async def post_destination(body: NewDestination) -> Output:
        service.add_destination(body.name, body.platform, body.url, body.key)
        return service.view()

    @router.put(f"{BASE}/destinations/{{destination_id}}")
    async def put_destination(destination_id: str, body: ChangedDestination) -> Output:
        service.edit_destination(
            destination_id, name=body.name, url=body.url, enabled=body.enabled, key=body.key
        )
        return service.view()

    @router.delete(f"{BASE}/destinations/{{destination_id}}")
    async def delete_destination(destination_id: str) -> Output:
        service.remove_destination(destination_id)
        return service.view()

    @router.put(f"{BASE}/quality")
    async def put_quality(body: NewQuality) -> Output:
        service.set_quality(body.quality)
        return service.view()

    @router.post(f"{BASE}/start")
    async def post_start() -> Output:
        service.start()
        return service.view()

    @router.post(f"{BASE}/stop")
    async def post_stop() -> Output:
        await service.stop()
        return service.view()

    @router.websocket("/api/output/capture/socket")
    async def capture_socket(websocket: WebSocket, token: str = "") -> None:
        """The program page in the hidden browser sends its recording here."""
        if not same_host(websocket, socket_hosts) or not service.accepts(token):
            await refuse(websocket, REFUSED)
            return
        await websocket.accept()

        async def chunks():
            try:
                while True:
                    yield await websocket.receive_bytes()
            except (WebSocketDisconnect, KeyError):  # gone, or sent text where a recording belongs
                return

        await service.feed(token, chunks())

    return router
```

- [ ] **Step 4: Wire it into the app**

In `services/pipeline/kickstream/app.py`:

Add to the imports, in alphabetical position:

```python
from kickstream.adapters.chromium_capture import ChromiumCapture
from kickstream.adapters.ffmpeg import FfmpegEncoder, FfmpegSender
from kickstream.output.api import build_output_router
from kickstream.output.service import OutputService
from kickstream.ports.output import Encoder, ProgramCapture, Sender
```

Add three fields to `Settings`, after `allowed_hosts`:

```python
    program_url: str = "http://127.0.0.1:5173/program"  # where the hidden browser finds the program page
    browser: str | None = None  # a Chromium-based browser; Microsoft Edge is looked for when unset
    ffmpeg: str = "ffmpeg"
```

and to `from_env`, after `allowed_hosts=…`:

```python
            program_url=env.get("KICKSTREAM_PROGRAM_URL") or "http://127.0.0.1:5173/program",
            browser=env.get("KICKSTREAM_BROWSER") or None,
            ffmpeg=env.get("KICKSTREAM_FFMPEG") or "ffmpeg",
```

Add `output: OutputService` to `Pipeline` after `tracker`, and make `stop` end a stream first:

```python
    async def stop(self) -> None:
        await self.output.stop()
        await self.controller.stop()
```

Give `build_pipeline` three more keyword parameters, `capture: ProgramCapture | None = None`, `encoder: Encoder | None = None`, `new_sender: Callable[[], Sender] | None = None`, and build the service before `stages`:

```python
    output = OutputService(
        JsonRecordStore(settings.data_dir / "output.json"),
        JsonRecordStore(settings.data_dir / "output-keys.json", private=True),
        capture=capture or ChromiumCapture(settings.browser),
        encoder=encoder or FfmpegEncoder(settings.ffmpeg),
        new_sender=new_sender or (lambda: FfmpegSender(settings.ffmpeg)),
        program_url=settings.program_url,
        recordings_dir=settings.data_dir / "recordings",
        now=now,
    )
```

and return `Pipeline(bus, store, broadcaster, controller, studio, audience, tracker, output, stages)`.

Give `create_app` the same three keyword parameters, pass them to `build_pipeline`, and include the router after the audience router:

```python
    app.include_router(build_output_router(service=pipeline.output, socket_hosts=settings.allowed_hosts))
```

- [ ] **Step 5: Run the tests**

Run: `uv run pytest tests/test_output_api.py tests/test_architecture.py -q`
Expected: PASS

- [ ] **Step 6: Lint, run the suite, commit**

Run: `uv run ruff check . && uv run ruff format . && uv run pytest -q`
Expected: clean and green.

```bash
git add services/pipeline/kickstream/output/api.py services/pipeline/kickstream/app.py services/pipeline/tests/test_output_api.py
git commit -m "feat: add the output routes and wire the stage into the app"
```

---

### Task 8: The program page records itself

**Files:**
- Create: `apps/web/src/studio/capture.ts`
- Modify: `apps/web/src/studio/ProgramPage.tsx`
- Test: `apps/web/src/studio/capture.test.ts`; add to `apps/web/src/studio/ProgramPage.test.tsx`

**Interfaces:**
- Consumes: the capture socket and the `window.__kickstreamStartCapture` contract from Tasks 6 and 7.
- Produces: `programAudio(): { context: AudioContext; input: AudioNode; stream: MediaStream }` (what later sub-projects connect sound to); `captureSocketUrl(token, place)`; `startCapture(token, size, deps?) => Promise<() => void>`; `ProgramPage` gains an optional `capture` prop for tests.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/studio/capture.test.ts`:

```ts
import { type CaptureDeps, captureSocketUrl, startCapture } from "./capture";

class FakeTrack {
  stopped = false;
  constructor(public kind: string, private surface = "browser") {}
  getSettings() {
    return { displaySurface: this.surface };
  }
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  constructor(public tracks: FakeTrack[]) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}

class FakeRecorder {
  static supported = ["video/webm;codecs=h264,opus"];
  static last: FakeRecorder;
  static isTypeSupported = (type: string) => FakeRecorder.supported.includes(type);
  state = "inactive";
  every = 0;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  constructor(public stream: FakeStream, public options: { mimeType: string }) {
    FakeRecorder.last = this;
  }
  start(every: number) {
    this.state = "recording";
    this.every = every;
  }
  stop() {
    this.state = "inactive";
  }
}

class FakeSocket {
  static last: FakeSocket;
  static opens = true;
  readyState = 0;
  binaryType = "";
  sent: Blob[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => {
      if (FakeSocket.opens) {
        this.readyState = 1;
        this.onopen?.();
      } else {
        this.readyState = 3;
        this.onclose?.();
      }
    });
  }
  send(data: Blob) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

function deps(surface = "browser") {
  const video = new FakeTrack("video", surface);
  const sound = new FakeTrack("audio");
  const asked: unknown[] = [];
  const made: CaptureDeps = {
    display: async (constraints) => {
      asked.push(constraints);
      return new FakeStream([video]) as unknown as MediaStream;
    },
    audio: () => new FakeStream([sound]) as unknown as MediaStream,
    Stream: FakeStream as unknown as typeof MediaStream,
    Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    Socket: FakeSocket as unknown as typeof WebSocket,
  };
  return { made, video, sound, asked };
}

const SIZE = { width: 1280, height: 720 };

beforeEach(() => {
  FakeSocket.opens = true;
  FakeRecorder.supported = ["video/webm;codecs=h264,opus"];
});

test("the capture socket is on this page's host and carries the token", () => {
  expect(captureSocketUrl("a b", { protocol: "http:", host: "127.0.0.1:5173" })).toBe("ws://127.0.0.1:5173/api/output/capture/socket?token=a%20b");
  expect(captureSocketUrl("t", { protocol: "https:", host: "kick.example" })).toBe("wss://kick.example/api/output/capture/socket?token=t");
});

test("the page records its own tab with the program's sound and sends it in quarter-second pieces", async () => {
  const { made, video, sound, asked } = deps();
  await startCapture("tok", SIZE, made);
  expect(asked[0]).toMatchObject({ audio: false, preferCurrentTab: true, selfBrowserSurface: "include", video: { width: 1280, height: 720, frameRate: 30 } });
  expect(FakeSocket.last.url).toMatch(/\/api\/output\/capture\/socket\?token=tok$/);
  expect(FakeRecorder.last.stream.tracks).toEqual([video, sound]);
  expect(FakeRecorder.last.options.mimeType).toBe("video/webm;codecs=h264,opus");
  expect([FakeRecorder.last.state, FakeRecorder.last.every]).toEqual(["recording", 250]);
  const piece = new Blob(["abc"]);
  FakeRecorder.last.ondataavailable?.({ data: piece });
  FakeRecorder.last.ondataavailable?.({ data: new Blob([]) });
  expect(FakeSocket.last.sent).toEqual([piece]);
});

test.each(["monitor", "window", ""])("anything but this tab (%s) is refused, so the desktop cannot go on air", async (surface) => {
  const { made, video } = deps(surface);
  await expect(startCapture("tok", SIZE, made)).rejects.toThrow("Only the program tab may be recorded.");
  expect(video.stopped).toBe(true);
});

test("a browser that cannot record the program says so", async () => {
  FakeRecorder.supported = [];
  const { made, video } = deps();
  await expect(startCapture("tok", SIZE, made)).rejects.toThrow("This browser cannot record the program.");
  expect(video.stopped).toBe(true);
});

test("a socket the pipeline refuses fails the capture and releases the tab", async () => {
  FakeSocket.opens = false;
  const { made, video } = deps();
  await expect(startCapture("tok", SIZE, made)).rejects.toThrow("The pipeline did not accept the recording.");
  expect(video.stopped).toBe(true);
});

test("the socket closing later stops the recording, and so does the returned stop", async () => {
  const first = deps();
  await startCapture("tok", SIZE, first.made);
  FakeSocket.last.onclose?.();
  expect(FakeRecorder.last.state).toBe("inactive");
  expect(first.video.stopped).toBe(true);

  const second = deps();
  const stop = await startCapture("tok", SIZE, second.made);
  stop();
  expect([FakeRecorder.last.state, second.video.stopped, FakeSocket.last.closed]).toEqual(["inactive", true, true]);
});
```

Append to `apps/web/src/studio/ProgramPage.test.tsx` (it already imports `act`, `FakeEventSource`, `FakeEventSourceCtor`, `studio` and `renderUi`; add any that are missing):

```tsx
test("the page offers to record itself only when opened with a capture token, and only once it has the studio", async () => {
  const page = window as unknown as { __kickstreamStartCapture?: () => Promise<void> };
  const capture = vi.fn(async () => () => {});
  window.history.pushState({}, "", "/program?capture=run-token");
  try {
    renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10_000} capture={capture} />);
    expect(page.__kickstreamStartCapture).toBeUndefined();
    const studioSource = FakeEventSource.instances.find((source) => source.url === "/api/studio/stream")!;
    act(() => {
      studioSource.open();
      studioSource.emitRaw(JSON.stringify(studio()));
    });
    expect(typeof page.__kickstreamStartCapture).toBe("function");
    await page.__kickstreamStartCapture!();
    expect(capture).toHaveBeenCalledWith("run-token", { width: window.innerWidth, height: window.innerHeight });
  } finally {
    window.history.pushState({}, "", "/program");
  }
});

test("without a capture token the page never offers to record itself", () => {
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10_000} />);
  const studioSource = FakeEventSource.instances.find((source) => source.url === "/api/studio/stream")!;
  act(() => {
    studioSource.open();
    studioSource.emitRaw(JSON.stringify(studio()));
  });
  expect((window as unknown as { __kickstreamStartCapture?: unknown }).__kickstreamStartCapture).toBeUndefined();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/studio/capture.test.ts src/studio/ProgramPage.test.tsx`
Expected: FAIL: `capture.test.ts` cannot resolve `./capture`; the first new `ProgramPage` test fails on `expected undefined to be 'function'`.

- [ ] **Step 3: Write the capture module**

`apps/web/src/studio/capture.ts`:

```ts
/**
 * The program page recording itself for the pipeline's hidden browser.
 *
 * Sound captured from a tab arrives silent in a hidden browser, so the page owns one audio mix
 * and records that beside the picture. Anything that should be heard on the stream connects to
 * `programAudio().input`.
 */

export interface ProgramAudio {
  context: AudioContext;
  /** Connect a source here to put it on the stream. */
  input: AudioNode;
  stream: MediaStream;
}

let shared: ProgramAudio | null = null;

export function programAudio(): ProgramAudio {
  if (shared) return shared;
  const context = new AudioContext();
  const output = context.createMediaStreamDestination();
  const input = context.createGain();
  input.connect(output);
  // An inaudible source keeps the track producing sound, so the recording always has audio to carry.
  const quiet = context.createConstantSource();
  const off = context.createGain();
  off.gain.value = 0;
  quiet.connect(off).connect(output);
  quiet.start();
  shared = { context, input, stream: output.stream };
  return shared;
}

interface Place {
  protocol: string;
  host: string;
}

export function captureSocketUrl(token: string, place: Place): string {
  const scheme = place.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${place.host}/api/output/capture/socket?token=${encodeURIComponent(token)}`;
}

/** What capture needs from the browser. Tests pass stand-ins. */
export interface CaptureDeps {
  display(constraints: object): Promise<MediaStream>;
  audio(): MediaStream;
  Stream: typeof MediaStream;
  Recorder: typeof MediaRecorder;
  Socket: typeof WebSocket;
}

const browser = (): CaptureDeps => ({
  display: (constraints) => navigator.mediaDevices.getDisplayMedia(constraints as DisplayMediaStreamOptions),
  audio: () => programAudio().stream,
  Stream: MediaStream,
  Recorder: MediaRecorder,
  Socket: WebSocket,
});

const FORMATS = ["video/webm;codecs=h264,opus", "video/webm;codecs=vp8,opus"];
const PIECE_MS = 250;
const OPEN = 1;

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onclose = () => reject(new Error("The pipeline did not accept the recording."));
  });
}

/** Record this tab with the program's sound and send it to the pipeline. Resolves to a function that stops it. */
export async function startCapture(token: string, size: { width: number; height: number }, deps: CaptureDeps = browser()): Promise<() => void> {
  const shown = await deps.display({
    video: { width: size.width, height: size.height, frameRate: 30 },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
  });
  const release = () => shown.getTracks().forEach((track) => track.stop());
  try {
    const [picture] = shown.getVideoTracks();
    // Anything but this tab would put the streamer's screen on air.
    if (picture?.getSettings().displaySurface !== "browser") throw new Error("Only the program tab may be recorded.");
    const mimeType = FORMATS.find((format) => deps.Recorder.isTypeSupported(format));
    if (!mimeType) throw new Error("This browser cannot record the program.");

    const socket = new deps.Socket(captureSocketUrl(token, window.location));
    socket.binaryType = "arraybuffer";
    await opened(socket);

    const recorder = new deps.Recorder(new deps.Stream([picture, ...deps.audio().getAudioTracks()]), { mimeType, videoBitsPerSecond: 8_000_000 });
    const stop = () => {
      if (recorder.state !== "inactive") recorder.stop();
      release();
      socket.close();
    };
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0 && socket.readyState === OPEN) socket.send(event.data);
    };
    // The pipeline closing the socket means the run is over.
    socket.onclose = stop;
    recorder.start(PIECE_MS);
    return stop;
  } catch (problem) {
    release();
    throw problem;
  }
}
```

- [ ] **Step 4: Offer capture from the program page**

In `apps/web/src/studio/ProgramPage.tsx`, add the import:

```ts
import { startCapture } from "./capture";
```

change the component's signature and add the effect after `const size = useWindowSize();`:

```tsx
/** The clean output: the active scene, scaled to the window, with no controls. */
export function ProgramPage({ eventSource, retryMs, pollMs, capture = startCapture }: CurrentMatchOptions & { capture?: typeof startCapture }) {
```

```tsx
  // Opened by the pipeline's hidden browser with a token, the page offers to record itself. It
  // waits for the studio document, so the stream never begins on an empty frame. The pipeline
  // calls the function; a page may only ask to be captured in answer to an action.
  const token = useMemo(() => new URLSearchParams(window.location.search).get("capture"), []);
  const ready = Boolean(studio);
  useEffect(() => {
    if (!token || !ready) return;
    const page = window as unknown as { __kickstreamStartCapture?: () => Promise<void> };
    page.__kickstreamStartCapture = async () => {
      await capture(token, { width: window.innerWidth, height: window.innerHeight });
    };
    return () => {
      delete page.__kickstreamStartCapture;
    };
  }, [token, ready, capture]);
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run src/studio && pnpm typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/studio/capture.ts apps/web/src/studio/capture.test.ts apps/web/src/studio/ProgramPage.tsx apps/web/src/studio/ProgramPage.test.tsx
git commit -m "feat: let the program page record itself for the pipeline"
```

---

### Task 9: The Output tab

**Files:**
- Create: `apps/web/src/output/api.ts`, `apps/web/src/output/OutputTab.tsx`
- Modify: `apps/web/src/studio/StudioPage.tsx`
- Test: `apps/web/src/output/api.test.ts`, `apps/web/src/output/OutputTab.test.tsx`; add to `apps/web/src/studio/StudioPage.test.tsx`

**Interfaces:**
- Consumes: the routes from Task 7; `Output`, `Destination` and the fixtures from Task 1; `send` from `../studio/api`; `useLiveDocument`.
- Produces: `OUTPUT_STREAM`, `addDestination`, `setDestinationEnabled`, `removeDestination`, `setQuality`, `goLive`, `stopOutput`; `OutputTab({ output, now, onRun })`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/output/api.test.ts`:

```ts
import { destination, output } from "../test/fixtures";
import { addDestination, goLive, removeDestination, setDestinationEnabled, setQuality, stopOutput } from "./api";

function serve() {
  const mock = vi.fn(async () => new Response(JSON.stringify(output({ revision: 4 })), { status: 200 }));
  vi.stubGlobal("fetch", mock);
  return () => {
    const [url, init] = mock.mock.calls[mock.mock.calls.length - 1] as unknown as [string, RequestInit];
    return { url, method: init.method, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
  };
}

test("each call goes to its route with its body", async () => {
  const last = serve();
  expect((await addDestination({ name: "YouTube", platform: "youtube", url: "", key: "sk-1" })).revision).toBe(4);
  expect(last()).toEqual({ url: "/api/studio/output/destinations", method: "POST", body: { name: "YouTube", platform: "youtube", url: "", key: "sk-1" } });
  await setDestinationEnabled(destination({ id: "d 1", name: "Main", url: "rtmp://h/app" }), false);
  expect(last()).toEqual({ url: "/api/studio/output/destinations/d%201", method: "PUT", body: { name: "Main", url: "rtmp://h/app", enabled: false } });
  await removeDestination("d 1");
  expect(last()).toMatchObject({ url: "/api/studio/output/destinations/d%201", method: "DELETE" });
  await setQuality("1080p30");
  expect(last()).toEqual({ url: "/api/studio/output/quality", method: "PUT", body: { quality: "1080p30" } });
  await goLive();
  expect(last()).toMatchObject({ url: "/api/studio/output/start", method: "POST" });
  await stopOutput();
  expect(last()).toMatchObject({ url: "/api/studio/output/stop", method: "POST" });
});
```

`apps/web/src/output/OutputTab.test.tsx`:

```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Output } from "../contracts";
import { destination, output } from "../test/fixtures";
import { renderUi } from "../test/render";
import { OutputTab } from "./OutputTab";

interface Call {
  url: string;
  method: string;
  body: any;
}

function setup(doc: Output | null = output(), accepted = true) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(doc ?? output()), { status: 200 });
  }));
  const onRun = vi.fn(async (request: () => Promise<Output>) => {
    await request();
    return accepted;
  });
  renderUi(<OutputTab output={doc} now={1100} onRun={onRun} />);
  return { calls };
}

const last = (calls: Call[]) => calls[calls.length - 1];
const KEY = "sk-live-abcd-1234-wxyz";

test("before the output arrives the tab says it is connecting", () => {
  setup(null);
  expect(screen.getByText("Connecting to the output…")).toBeTruthy();
});

test("with no destinations it says how to begin and cannot go live", () => {
  setup();
  expect(screen.getByText("Add a destination to go live.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Go live" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Off air")).toBeTruthy();
});

test("a destination is added with its key, and the key box is emptied afterwards", async () => {
  const { calls } = setup();
  fireEvent.change(screen.getByLabelText("Platform"), { target: { value: "youtube" } });
  expect((screen.getByLabelText("Server address") as HTMLInputElement).placeholder).toBe("rtmp://a.rtmp.youtube.com/live2");
  const key = screen.getByLabelText("Stream key") as HTMLInputElement;
  expect(key.type).toBe("password");
  fireEvent.change(key, { target: { value: KEY } });
  fireEvent.click(screen.getByRole("button", { name: "Add destination" }));
  await waitFor(() => expect(last(calls)).toEqual({
    url: "/api/studio/output/destinations", method: "POST", body: { name: "YouTube", platform: "youtube", url: "", key: KEY },
  }));
  await waitFor(() => expect(key.value).toBe(""));
});

test("a refused destination keeps what was typed", async () => {
  setup(output(), false);
  const key = screen.getByLabelText("Stream key") as HTMLInputElement;
  fireEvent.change(key, { target: { value: KEY } });
  fireEvent.click(screen.getByRole("button", { name: "Add destination" }));
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
  expect(key.value).toBe(KEY);
});

test("recording to a file asks for no address or key", async () => {
  const { calls } = setup();
  fireEvent.change(screen.getByLabelText("Platform"), { target: { value: "file" } });
  expect(screen.queryByLabelText("Stream key")).toBeNull();
  expect(screen.queryByLabelText("Server address")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add destination" }));
  await waitFor(() => expect(last(calls).body).toEqual({ name: "Record to file", platform: "file", url: "", key: "" }));
});

test("idle destinations can be switched, removed and sent live", async () => {
  const doc = output({ destinations: [destination(), destination({ id: "d2", name: "Recording", platform: "file", url: "", key_hint: "", enabled: false })] });
  const { calls } = setup(doc);
  const first = within(screen.getByTestId("destination-d1"));
  expect(first.getByText("Key ending wxyz")).toBeTruthy();
  fireEvent.click(first.getByRole("switch", { name: "Send to YouTube" }));
  await waitFor(() => expect(last(calls)).toMatchObject({ url: "/api/studio/output/destinations/d1", method: "PUT", body: { enabled: false } }));
  fireEvent.click(within(screen.getByTestId("destination-d2")).getByRole("button", { name: "Remove Recording" }));
  await waitFor(() => expect(last(calls)).toMatchObject({ url: "/api/studio/output/destinations/d2", method: "DELETE" }));
  fireEvent.change(screen.getByLabelText("Quality"), { target: { value: "1080p30" } });
  await waitFor(() => expect(last(calls).body).toEqual({ quality: "1080p30" }));
  fireEvent.click(screen.getByRole("button", { name: "Go live" }));
  await waitFor(() => expect(last(calls).url).toBe("/api/studio/output/start"));
});

test("while live it shows how long, each destination's status, and only Stop", async () => {
  const doc = output({
    state: "live", started_at: 1000 - 75,
    destinations: [
      destination({ status: "live", live_since: 930 }),
      destination({ id: "d2", name: "X", platform: "x", status: "retrying", reason: "Connection refused" }),
      destination({ id: "d3", name: "Facebook", platform: "facebook", status: "failed", reason: "Bad key" }),
    ],
  });
  const { calls } = setup(doc);
  const stream = within(screen.getByRole("region", { name: "Stream" }));
  expect(stream.getByText("Live")).toBeTruthy();
  expect(stream.getByText("2:55")).toBeTruthy();
  expect(within(screen.getByTestId("destination-d1")).getByText("Live")).toBeTruthy();
  expect(within(screen.getByTestId("destination-d2")).getByText("Retrying")).toBeTruthy();
  expect(within(screen.getByTestId("destination-d2")).getByText("Connection refused")).toBeTruthy();
  expect(within(screen.getByTestId("destination-d3")).getByText("Failed")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Go live" })).toBeNull();
  expect((screen.getByRole("switch", { name: "Send to YouTube" }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText("Quality") as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Add destination" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(last(calls).url).toBe("/api/studio/output/stop"));
});

test("starting and stopping are shown, and Stop cannot be pressed twice", () => {
  setup(output({ state: "stopping", destinations: [destination()] }));
  expect(screen.getByText("Stopping")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true);
});

test("a run that ended by itself says why, and recordings are listed with their size", () => {
  setup(output({ problem: "The hidden browser stopped.", recordings: [{ file: "2026-10-13-101500.mp4", size_bytes: 5_400_000, made_at: 900 }] }));
  expect(screen.getByText("The hidden browser stopped.")).toBeTruthy();
  expect(screen.getByText("2026-10-13-101500.mp4")).toBeTruthy();
  expect(screen.getByText("5.4 MB")).toBeTruthy();
});
```

Append to `apps/web/src/studio/StudioPage.test.tsx` (render the page the way the tests above it do; the test below calls that `opened()`):

```tsx
test("the Output tab follows the output document", () => {
  opened();
  fireEvent.click(screen.getByRole("tab", { name: "Output" }));
  expect(screen.getByText("Connecting to the output…")).toBeTruthy();
  const source = FakeEventSource.instances.find((candidate) => candidate.url === "/api/studio/output/stream")!;
  act(() => {
    source.open();
    source.emitRaw(JSON.stringify(output({ destinations: [destination()] })));
  });
  expect(screen.getByRole("switch", { name: "Send to YouTube" })).toBeTruthy();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/output src/studio/StudioPage.test.tsx`
Expected: FAIL: the `output` files cannot resolve `./api` and `./OutputTab`; the studio test finds no tab named Output.

- [ ] **Step 3: Write the client**

`apps/web/src/output/api.ts`:

```ts
import type { Destination, Output } from "../contracts";
import { send } from "../studio/api";

export const OUTPUT_STREAM = "/api/studio/output/stream";

const id = encodeURIComponent;
const call = (method: string, path: string, body?: unknown) => send<Output>(method, `/api/studio/output${path}`, body);

export const addDestination = (added: { name: string; platform: Destination["platform"]; url: string; key: string }) => call("POST", "/destinations", added);
/** The key is left out, so the stored one is kept. */
export const setDestinationEnabled = (changed: Destination, enabled: boolean) =>
  call("PUT", `/destinations/${id(changed.id)}`, { name: changed.name, url: changed.url, enabled });
export const removeDestination = (destinationId: string) => call("DELETE", `/destinations/${id(destinationId)}`);
export const setQuality = (quality: Output["quality"]) => call("PUT", "/quality", { quality });
export const goLive = () => call("POST", "/start");
export const stopOutput = () => call("POST", "/stop");
```

- [ ] **Step 4: Write the tab**

`apps/web/src/output/OutputTab.tsx`:

```tsx
import { Badge, Button, Field, Input, makeStyles, MessageBar, MessageBarBody, Select, Switch, Text, tokens } from "@fluentui/react-components";
import { useState } from "react";
import type { Destination, Output } from "../contracts";
import { addDestination, goLive, removeDestination, setDestinationEnabled, setQuality, stopOutput } from "./api";

type Platform = Destination["platform"];

const PLATFORMS: Record<Platform, { label: string; address: string }> = {
  youtube: { label: "YouTube", address: "rtmp://a.rtmp.youtube.com/live2" },
  x: { label: "X", address: "" },
  facebook: { label: "Facebook", address: "rtmps://live-api-s.facebook.com:443/rtmp/" },
  twitch: { label: "Twitch", address: "rtmp://live.twitch.tv/app" },
  custom: { label: "Custom RTMP", address: "" },
  file: { label: "Record to file", address: "" },
};
const STATE = {
  idle: { label: "Off air", color: "subtle" },
  starting: { label: "Starting", color: "warning" },
  live: { label: "Live", color: "danger" },
  stopping: { label: "Stopping", color: "warning" },
} as const;
const STATUS = {
  idle: { label: "Off", color: "subtle" },
  connecting: { label: "Connecting", color: "warning" },
  live: { label: "Live", color: "success" },
  retrying: { label: "Retrying", color: "warning" },
  failed: { label: "Failed", color: "danger" },
} as const;

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
  section: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalS },
  grow: { flexGrow: 1, minWidth: 0, overflowWrap: "anywhere" },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
});

/** Minutes and seconds, or hours too once there are any. */
function elapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(whole % 60)}` : `${minutes}:${pad(whole % 60)}`;
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

interface OutputTabProps {
  output: Output | null;
  /** Server time, in seconds. */
  now: number;
  /** Sends one change and applies the answer. Resolves to true when it was accepted. */
  onRun(request: () => Promise<Output>): Promise<boolean>;
}

/** Where the program is sent, and the button that sends it. */
export function OutputTab({ output, now, onRun }: OutputTabProps) {
  const styles = useStyles();
  const [platform, setPlatform] = useState<Platform>("youtube");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [key, setKey] = useState("");

  if (!output) return <Text>Connecting to the output…</Text>;

  const idle = output.state === "idle";
  const toFile = platform === "file";
  const add = async () => {
    const added = { name: name.trim() || PLATFORMS[platform].label, platform, url: toFile ? "" : address.trim(), key: toFile ? "" : key };
    if (await onRun(() => addDestination(added))) {
      setName("");
      setAddress("");
      setKey("");
    }
  };

  return (
    <div className={styles.root}>
      <section className={styles.section} aria-label="Stream">
        <div className={styles.row}>
          <Badge color={STATE[output.state].color}>{STATE[output.state].label}</Badge>
          {output.state === "live" && typeof output.started_at === "number" && <Text>{elapsed(now - output.started_at)}</Text>}
          <span className={styles.grow} />
          {idle ? (
            <Button appearance="primary" disabled={!output.destinations.some((item) => item.enabled)} onClick={() => void onRun(goLive)}>Go live</Button>
          ) : (
            <Button disabled={output.state === "stopping"} onClick={() => void onRun(stopOutput)}>Stop</Button>
          )}
        </div>
        {output.problem && (
          <MessageBar intent="error">
            <MessageBarBody>{output.problem}</MessageBarBody>
          </MessageBar>
        )}
        <Field label="Quality">
          <Select value={output.quality} disabled={!idle} onChange={(_, data) => void onRun(() => setQuality(data.value as Output["quality"]))}>
            <option value="720p30">720p, 30 frames per second</option>
            <option value="1080p30">1080p, 30 frames per second</option>
          </Select>
        </Field>
      </section>

      <section className={styles.section} aria-label="Destinations">
        <Text weight="semibold">Destinations</Text>
        {output.destinations.length === 0 && <Text size={200}>Add a destination to go live.</Text>}
        <ul className={styles.list}>
          {output.destinations.map((item) => (
            <li key={item.id} data-testid={`destination-${item.id}`}>
              <div className={styles.row}>
                <Text weight="semibold" className={styles.grow}>{item.name}</Text>
                <Badge color={STATUS[item.status].color}>{STATUS[item.status].label}</Badge>
              </div>
              <Text size={200} block>
                {PLATFORMS[item.platform].label}
                {item.platform !== "file" && ` · ${item.key_hint ? `Key ending ${item.key_hint}` : "Key saved"}`}
              </Text>
              {item.reason && <Text size={200} block className={styles.grow}>{item.reason}</Text>}
              <div className={styles.row}>
                <Switch label={`Send to ${item.name}`} checked={item.enabled} disabled={!idle}
                  onChange={(_, data) => void onRun(() => setDestinationEnabled(item, data.checked))} />
                <Button size="small" disabled={!idle} aria-label={`Remove ${item.name}`} onClick={() => void onRun(() => removeDestination(item.id))}>Remove</Button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.section} aria-label="Add a destination">
        <Text weight="semibold">Add a destination</Text>
        <Field label="Platform">
          <Select value={platform} onChange={(_, data) => setPlatform(data.value as Platform)}>
            {(Object.keys(PLATFORMS) as Platform[]).map((option) => (
              <option key={option} value={option}>{PLATFORMS[option].label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Name">
          <Input value={name} maxLength={40} placeholder={PLATFORMS[platform].label} onChange={(_, data) => setName(data.value)} />
        </Field>
        {!toFile && (
          <>
            <Field label="Server address" hint={platform === "x" ? "X shows your address in Media Studio." : undefined}>
              <Input value={address} maxLength={300} placeholder={PLATFORMS[platform].address} onChange={(_, data) => setAddress(data.value)} />
            </Field>
            <Field label="Stream key" hint="Kept on this machine and never shown again.">
              <Input type="password" autoComplete="off" value={key} maxLength={300} onChange={(_, data) => setKey(data.value)} />
            </Field>
          </>
        )}
        <Button disabled={!idle} onClick={() => void add()}>Add destination</Button>
      </section>

      {output.recordings.length > 0 && (
        <section className={styles.section} aria-label="Recordings">
          <Text weight="semibold">Recordings</Text>
          <ul className={styles.list}>
            {output.recordings.map((item) => (
              <li key={item.file} className={styles.row}>
                <Text className={styles.grow}>{item.file}</Text>
                <Text size={200}>{megabytes(item.size_bytes)}</Text>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Add the tab to the studio page**

In `apps/web/src/studio/StudioPage.tsx`:

- add `"Output"` to the `TABS` list, after `"Audience"`;
- add `Output` to the `import type { … } from "../contracts"` line, and import `OUTPUT_STREAM` from `"../output/api"` and `OutputTab` from `"../output/OutputTab"`;
- after the `audience` live document line, add:

```tsx
  const { doc: output, accept: acceptOutput } = useLiveDocument<Output>(OUTPUT_STREAM, eventSource, retryMs);
```

- after `runAudience`, add:

```tsx
  const runOutput = async (request: () => Promise<Output>): Promise<boolean> => {
    try {
      acceptOutput(await request());
      setProblem(null);
      return true;
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The change was not made.");
      return false;
    }
  };
```

- after the Audience tab's line in the tab panel, add:

```tsx
            {tab === "Output" && <OutputTab output={output} now={now} onRun={runOutput} />}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: every test passes; typecheck and build clean. If an existing studio test addresses a `FakeEventSource` by position, change it to find its source by URL, since the page now opens one more.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/output apps/web/src/studio/StudioPage.tsx apps/web/src/studio/StudioPage.test.tsx
git commit -m "feat: add the studio Output tab"
```

---

### Task 10: End to end, and the README

**Files:**
- Modify: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/output.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above, running for real: Edge, ffmpeg, the test pipeline on 8010 and the test dev server on 5183.

- [ ] **Step 1: Point the test pipeline's hidden browser at the test dev server**

In `apps/web/playwright.config.ts`, change `TEST_SERVER` to:

```ts
// The hidden browser must open the program page on the tests' own dev server, not a developer's.
const TEST_SERVER = { ...NO_MODEL, KICKSTREAM_DATA_DIR: `.data-e2e/${Date.now()}`, KICKSTREAM_PROGRAM_URL: `${WEB}/program` };
```

- [ ] **Step 2: Write the test**

`apps/web/e2e/output.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

// The test pipeline; see playwright.config.ts.
const OUTPUT = "http://127.0.0.1:8010/api/studio/output";

test("the streamer records the program to a file, changes it while live, and stops", async ({ page, request }) => {
  await page.goto("/studio");
  await page.getByRole("tab", { name: "Output" }).click();
  await page.getByLabel("Platform").selectOption("file");
  await page.getByRole("button", { name: "Add destination" }).click();
  await expect(page.getByRole("switch", { name: "Send to Record to file" })).toBeVisible();

  try {
    await page.getByRole("button", { name: "Go live" }).click();
    // On a machine with no ffmpeg or no Chromium there is nothing to test.
    const missing = page.getByText(/was not found/);
    const stream = page.getByRole("region", { name: "Stream" });
    await expect(stream.getByText("Starting").or(stream.getByText("Live")).or(missing)).toBeVisible();
    test.skip(await missing.isVisible(), "ffmpeg or a Chromium-based browser is not installed");

    await expect(stream.getByText("Live")).toBeVisible({ timeout: 40_000 });
    const destination = page.getByRole("region", { name: "Destinations" });
    await expect(destination.getByText("Live")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Add destination" })).toBeDisabled();

    // What the streamer does while live reaches the stream: the banner is a change to the program.
    await page.getByRole("tab", { name: "Banner" }).click();
    await page.getByLabel("Banner text").fill("Recorded by the output test");
    await page.getByRole("button", { name: "Show banner" }).click();
    await page.waitForTimeout(4000);

    await page.getByRole("tab", { name: "Output" }).click();
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(stream.getByText("Off air")).toBeVisible({ timeout: 15_000 });

    const recordings = page.getByRole("region", { name: "Recordings" });
    await expect(recordings.getByText(/\.mp4$/)).toBeVisible();
    const doc = await (await request.get(OUTPUT)).json();
    expect(doc.state).toBe("idle");
    expect(doc.problem).toBeNull();
    expect(doc.recordings[0].size_bytes).toBeGreaterThan(20_000);
  } finally {
    await request.post(`${OUTPUT}/stop`);
    const doc = await (await request.get(OUTPUT)).json();
    for (const item of doc.destinations) await request.delete(`${OUTPUT}/destinations/${item.id}`);
  }
});
```

- [ ] **Step 3: Run it**

Run: `pnpm e2e`
Expected: 4 passed. If the output test fails, read the pipeline's lines in the output: a `problem` in the document says which part stopped.

- [ ] **Step 4: Check a recording by eye**

Run, from `apps/web`: `ffprobe -v error -show_entries stream=codec_name,width,height -of compact "$(ls -t .data-e2e/*/recordings/*.mp4 | head -1)"` and `ffmpeg -loglevel error -y -sseof -2 -i "$(ls -t .data-e2e/*/recordings/*.mp4 | head -1)" -frames:v 1 <scratchpad>/last-frame.png`
Expected: `h264` at `1280x720` and `aac`. Open the frame: it shows the program with the banner text.

- [ ] **Step 5: Document it**

In `README.md`, replace the sentence `Kickstream does not send video anywhere itself yet. To go live, capture `/program` with a streaming tool.` with:

```markdown
## Going live

The studio's **Output** tab sends the program to several platforms at once.

1. On the platform (YouTube Studio, X Media Studio, Facebook Live Producer, Twitch), create a live stream. It shows a server address and a stream key.
2. In the Output tab, choose the platform and paste the key. YouTube, Facebook and Twitch addresses are filled in; X gives each account its own, so paste that too. **Record to file** needs neither and writes an MP4 to `.data/recordings/`, which is a good first test.
3. Press **Go live**. Each destination shows connecting, live, retrying or failed. One failing does not stop the others.

Kickstream opens the program page in a hidden browser, encodes it once with ffmpeg, and copies that stream to every destination. It needs [ffmpeg](https://ffmpeg.org) and a Chromium-based browser (Microsoft Edge is used when present).

| Variable | Meaning |
|---|---|
| `KICKSTREAM_PROGRAM_URL` | Where the hidden browser opens the program page (default `http://127.0.0.1:5173/program`) |
| `KICKSTREAM_BROWSER` | Path to a Chromium-based browser, when Edge is not wanted or not found |
| `KICKSTREAM_FFMPEG` | Path to ffmpeg, when it is not on the `PATH` |

Stream keys are kept in `.data/output-keys.json` and are never sent back to a page. The studio has no sign-in, so anyone who can reach it can stream to your channels: keep the pipeline reachable from your machine only. The stream carries no sound yet. Do not run the pipeline with `--reload` when going live; on Windows it cannot start ffmpeg that way.
```

- [ ] **Step 6: Run everything**

Run: `uv run ruff check . && uv run pytest -q` (from `services/pipeline`), then `pnpm typecheck && pnpm test && pnpm build && pnpm e2e` (from `apps/web`).
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/playwright.config.ts apps/web/e2e/output.spec.ts README.md
git commit -m "test: add the output end-to-end test and document going live"
```
