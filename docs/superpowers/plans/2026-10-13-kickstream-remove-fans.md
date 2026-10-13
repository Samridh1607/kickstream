# Remove the fan audience — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the fan page (`/join`) and everything that only served it: polls, fan questions, the expert's answers, their scene elements, and their broadcast stats.

**Architecture:** Pure deletion across the web app, the pipeline and the shared schema, in three tasks that each leave every suite green: the web pages first (the schema still has the types, unused), then the pipeline and the schema together (regenerating both sets of types), then the end-to-end suite and the docs. Saved data keeps loading: `studio.json` already drops unknown element types, and `broadcasts.json` forgets the removed stats on load.

**Tech Stack:** FastAPI + pydantic (uv, pytest, ruff) in `services/pipeline`; React 19 + Fluent UI v9 (pnpm, vitest, Playwright) in `apps/web`; JSON Schema in `packages/contracts`.

Spec: `docs/superpowers/specs/2026-10-13-kickstream-guests-design.md`, section 1.

## Global Constraints

- Windows / PowerShell. Edit files with the editor tools, not shell redirection. Never set `KICKSTREAM_*` variables in a shared shell.
- Pipeline commands run in `services/pipeline`: `uv run pytest -q`, `uv run ruff check .`, `uv run ruff format --check .`.
- Web commands run in `apps/web`: `pnpm test`, `pnpm typecheck`; end to end: kill anything listening on ports 8010 and 5183 first, then `pnpm e2e --reporter=line`.
- Generated types: `pnpm gen:contracts` (in `apps/web`) and `uv run python -m kickstream.tools.gen_contracts` (in `services/pipeline`). Never hand-edit `apps/web/src/contracts.ts` or `services/pipeline/kickstream/contracts.py`.
- Never commit `.playwright-mcp/` or `apps/web/tsconfig.tsbuildinfo`.
- Comments only for constraints the code cannot show. Match the surrounding style.

---

### Task 1: Web — no fan page, no polls or questions anywhere in the app

**Files:**
- Delete: `apps/web/src/audience/` (all of `api.ts`, `api.test.ts`, `AudienceTab.tsx`, `AudienceTab.test.tsx`, `JoinPage.tsx`, `JoinPage.test.tsx`, `JoinPanel.tsx`, `JoinPanel.test.tsx`, `program.test.tsx`, `voter.ts`, `voter.test.ts`)
- Modify: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/shell/AppNav.tsx`, `apps/web/src/i18n.ts`
- Modify: `apps/web/src/studio/ProgramPage.tsx`, `apps/web/src/studio/elements.tsx`, `apps/web/src/studio/panels.tsx`, `apps/web/src/studio/StudioPage.tsx`
- Modify: `apps/web/src/home/HomePage.tsx`, `apps/web/src/broadcasts/BroadcastPage.tsx`, `apps/web/src/broadcasts/BroadcastList.tsx`, `apps/web/src/broadcasts/format.ts`
- Modify tests: `apps/web/src/home/HomePage.test.tsx`, `apps/web/src/broadcasts/BroadcastPage.test.tsx`, `apps/web/src/stream/useLiveDocument.test.tsx`, `apps/web/src/stream/SocketSource.test.ts`, `apps/web/src/broadcasts/format.test.ts`, `apps/web/src/test/fixtures.ts`
- Create test: `apps/web/src/studio/ProgramPage.fallbacks.test.ts`

**Interfaces:**
- Produces: `withFallbacks(scene: Scene, studio: Studio): Scene` in `studio/ProgramPage.tsx` (the audience parameter is gone). `ProgramData` in `studio/elements.tsx` no longer has `audience`. Sub-project B adds its Cameras fallback inside `withFallbacks`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/studio/ProgramPage.fallbacks.test.ts`:

```ts
import { scene, studio } from "../test/fixtures";
import { withFallbacks } from "./ProgramPage";

const REPLAY = { match_id: "m-1", moment_id: "m-1-k1", minute: 23, started_at: 1000, duration_s: 20 };

test("a replay on air gets a box when the scene has none", () => {
  const shown = withFallbacks(scene({ elements: [] }), studio({ replay: REPLAY }));
  expect(shown.elements.map((element) => element.type)).toEqual(["replay"]);
});

test("with nothing extra on air the scene is unchanged", () => {
  const plain = scene({ elements: [] });
  expect(withFallbacks(plain, studio())).toBe(plain);
});
```

In `apps/web/src/home/HomePage.test.tsx`, replace the test `"the audience box shares the fan page and sums the poll"` with:

```ts
test("home has no fan page or audience box", () => {
  renderHome();
  expect(screen.queryByRole("region", { name: "Audience" })).toBeNull();
  expect(screen.queryByText(/\/join$/)).toBeNull();
  expect(screen.queryByRole("link", { name: /Fan page/ })).toBeNull();
});
```

Use the file's existing render helper in place of `renderHome()` (read the top of the file for its name), and drop `audience` and `poll` from its fixtures import.

In `apps/web/src/broadcasts/BroadcastPage.test.tsx`, replace the two `tile("Audience")` assertions (lines 50–51) with:

```ts
  expect(screen.queryByText("Audience")).toBeNull();
```

- [ ] **Step 2: Run them to see them fail**

Run (in `apps/web`): `pnpm exec vitest run src/studio/ProgramPage.fallbacks.test.ts src/home/HomePage.test.tsx src/broadcasts/BroadcastPage.test.tsx`
Expected: FAIL — the Home test finds the Audience region and the broadcast test finds "Audience". (The fallback tests may already pass: vitest does not type-check, and they pin the behaviour the refactor must keep.)

- [ ] **Step 3: Remove the fan page and its links**

`apps/web/src/main.tsx`: delete `import { JoinPage } from "./audience/JoinPage";` and the line `if (path === "/join") return <JoinPage />;`.

`apps/web/src/shell/AppNav.tsx`: delete the entry `{ page: null, href: "/join", label: "Fan page", icon: <PeopleCommunityRegular />, newTab: true },` and `PeopleCommunityRegular` from the icon import. If `newTab` is now unused by every entry, remove the field from the entry type and the code that reads it.

`apps/web/src/App.tsx`:
- delete `import { JoinLive } from "./audience/JoinPage";`
- change `type View = "match" | "overlay" | "join";` to `type View = "match" | "overlay";`
- delete `<Tab value="join">{t(language, "joinTab")}</Tab>`
- delete the whole `{view === "join" && ( … )}` block.
- If `eventSource` / `retryMs` are now unused in `App`, leave the props in place only if other code still passes them; otherwise remove them and their passing site in `MatchPage.tsx`.

`apps/web/src/i18n.ts`: delete these keys from `en`, `es` and `hi`: `joinTab`, `pollTitle`, `noPoll`, `pollOpen`, `pollClosed`, `votes`, `yourVote`, `voteToSee`, `askTitle`, `joinTagline`, `yourQuestion`, `nickname`, `send`, `questionsTitle`, `noQuestions`, `upvote`, `yours`, `expertAnswer`, `asks`, `notRemembered`, `sendFailed`. Before deleting each, run `rg -n "\"<key>\"" apps/web/src --glob "!**/audience/**"` and keep any key that something outside `audience/` still uses.

Delete the directory `apps/web/src/audience/`.

- [ ] **Step 4: Remove polls and Q&A from the program and the studio**

`apps/web/src/studio/ProgramPage.tsx`:
- delete the imports of `AUDIENCE_STREAM` and the `Audience` type (keep `Scene, Studio, ViewerProfile`), and `useLiveDocument` if unused.
- replace the `POLL_BOX`/`QA_BOX` constants and `withFallbacks` with:

```ts
/** Whatever is on air must be visible: add a default box for each thing the scene has no element for. */
export function withFallbacks(scene: Scene, studio: Studio): Scene {
  return withReplayFallback(scene, studio);
}
```

- delete `const { doc: audience } = useLiveDocument<Audience>(AUDIENCE_STREAM, eventSource, retryMs);`
- render with `scene={withFallbacks(active, studio)}` and `data={{ match, studio, now, language: studio.settings.language }}`.

`apps/web/src/studio/elements.tsx`: remove `Audience` from the contracts import, the `audience?: Audience | null;` field (and its doc comment) from `ProgramData`, the `PollView` and `QaView` components, and the `case "poll":` / `case "qa":` branches. Change the doc comment `/** Draws one scene element from the match, the studio document and the audience. */` to `/** Draws one scene element from the match and the studio document. */`. The switch is exhaustive over `SceneElement["type"]`, which still includes `"poll"` and `"qa"` until Task 2; until then add a single branch `case "poll": case "qa": return null;` so it compiles. Task 2 deletes that branch.

`apps/web/src/studio/panels.tsx`: remove `"poll", "qa",` from `ELEMENT_TYPES`.

`apps/web/src/studio/StudioPage.tsx`:
- delete the imports of `STUDIO_AUDIENCE_STREAM` and `AudienceTab`, `Audience` from the contracts import, and `PeopleCommunityRegular` from the icons import.
- `const TABS = ["Elements", "Banner", "Ticker", "Highlights", "Countdown", "Settings"] as const;` and remove `Audience: <PeopleCommunityRegular />,` from `TAB_ICONS`.
- delete the `useLiveDocument<Audience>(STUDIO_AUDIENCE_STREAM, …)` line, the `runAudience` function, and `{tab === "Audience" && <AudienceTab … />}`.
- `const data = { match, studio, now, language: studio.settings.language };`
- `<SceneCanvas scene={withFallbacks(onAir, studio)} data={data} scale={PREVIEW_SCALE} />`

- [ ] **Step 5: Remove the audience from Home and the broadcast pages**

`apps/web/src/home/HomePage.tsx`:
- delete the `STUDIO_AUDIENCE_STREAM` import, `Audience` from the contracts import, and the icons `ChatRegular`, `CopyRegular`, `PeopleCommunityRegular`, `PollRegular` and `Tooltip` if nothing else uses them (check with search).
- delete the `useLiveDocument<Audience>` line, `const [copied, setCopied] = useState(false);`, and the `openQuestions`, `votes` and `joinUrl` constants.
- `const data = studio ? { match, studio, now, language: studio.settings.language } : null;`
- `<SceneCanvas scene={withFallbacks(onAir, studio)} data={data} scale={HERO_SCALE} />`
- delete the `<Tile … label="Audience" … />` and the whole `<Card … title="Your audience" label="Audience"> … </Card>`.
- delete the `share` style from `useStyles` if it is now unused.

`apps/web/src/broadcasts/BroadcastPage.tsx`: delete the `<Tile … label="Audience" … />` and the `<Card icon={<PollRegular />} title="Audience"> … </Card>`; remove `votes` from the `./format` import and `PeopleCommunityRegular`, `PollRegular`, `ChatRegular` from the icon import if unused.

`apps/web/src/broadcasts/BroadcastList.tsx`: delete the line `{broadcast.stats.polls.length > 0 && <Fact icon={<PollRegular />}>…</Fact>}` and `PollRegular` from its imports if unused.

`apps/web/src/broadcasts/format.ts`: delete the `votes` function. In `format.test.ts`, change `plural(0, "poll")` to `plural(0, "session")` and `"0 polls"` to `"0 sessions"`.

- [ ] **Step 6: Move the stream tests off the audience stream**

`apps/web/src/stream/useLiveDocument.test.tsx`: use the broadcasts document instead.

```ts
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Broadcasts } from "../contracts";
import { broadcasts, FakeEventSource, FakeEventSourceCtor } from "../test/fixtures";
import { newer, useLiveDocument } from "./useLiveDocument";

beforeEach(() => {
  FakeEventSource.instances = [];
});

const hook = () => renderHook(() => useLiveDocument<Broadcasts>("/api/broadcasts/stream", FakeEventSourceCtor, 10));
const push = (doc: Broadcasts) => act(() => FakeEventSource.last.emitRaw(JSON.stringify(doc)));

test("newer works for any document with a revision", () => {
  const two = broadcasts({ revision: 2 });
  expect(newer(null, two)).toBe(two);
  expect(newer(two, broadcasts({ revision: 1 }))).toBe(two);
  expect(newer(two, broadcasts({ revision: 3 })).revision).toBe(3);
});

test("it follows the given stream and ignores stale documents", () => {
  const { result } = hook();
  expect(FakeEventSource.last.url).toBe("/api/broadcasts/stream");
  act(() => FakeEventSource.last.open());
  push(broadcasts({ revision: 4, current_id: "b4" }));
  push(broadcasts({ revision: 3, current_id: "b3" }));
  expect(result.current.doc).toMatchObject({ revision: 4, current_id: "b4" });
  expect(result.current.connected).toBe(true);
});

test("the first document after a reconnect is taken even with a lower revision", () => {
  const { result } = hook();
  act(() => FakeEventSource.last.open());
  push(broadcasts({ revision: 40 }));
  act(() => FakeEventSource.last.fail(0));
  act(() => FakeEventSource.last.open());
  push(broadcasts({ revision: 0 }));
  expect(result.current.doc?.revision).toBe(0);
});

test("a refused stream is reopened, and accept applies an answer at once", async () => {
  const { result } = hook();
  const first = FakeEventSource.last;
  act(() => first.fail(2));
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
  act(() => result.current.accept(broadcasts({ revision: 9 })));
  expect(result.current.doc?.revision).toBe(9);
});

test("offset is the server clock minus this machine's clock", () => {
  vi.spyOn(Date, "now").mockReturnValue(2_000_000);
  const { result } = hook();
  act(() => FakeEventSource.last.open());
  push(broadcasts({ server_time: 2_030 }));
  expect(result.current.offset).toBe(30);
});
```

`apps/web/src/stream/SocketSource.test.ts` line 42: replace `/api/audience/stream` with `/api/broadcasts/stream` and `wss://kick.example/api/audience/socket` with `wss://kick.example/api/broadcasts/socket`.

`apps/web/src/test/fixtures.ts`: delete the `poll`, `fanQuestion` and `audience` fixtures and `Audience`, `Poll`, `Question` from the type import. Leave `stats` with `polls`/`questions` for now (the type still requires them until Task 2), but change the `endedBroadcast` doc comment to `/** A broadcast that was live for two minutes, recorded, with a goal and a reel. */`.

- [ ] **Step 7: Run the web suite and the typecheck**

Run (in `apps/web`): `pnpm test` then `pnpm typecheck`
Expected: all test files pass; `tsc` prints nothing. Then `rg -n "audience|/join|JoinLive|PollView|QaView" apps/web/src` — expected: no matches except the generated `contracts.ts`.

- [ ] **Step 8: Commit**

```bash
git add -A apps/web/src
git commit -m "Remove the fan page, polls and fan questions from the web app"
```

---

### Task 2: Pipeline and schema — no audience package, no audience stats

**Files:**
- Delete: `services/pipeline/kickstream/audience/` (whole package), `services/pipeline/kickstream/ports/audience_store.py`, `services/pipeline/kickstream/ports/expert.py`, `services/pipeline/kickstream/adapters/agent_expert.py`
- Delete tests: `services/pipeline/tests/test_audience_adapters.py`, `test_audience_api.py`, `test_audience_contracts.py`, `test_audience_limits.py`, `test_audience_rules.py`, `test_audience_service.py`
- Modify: `services/pipeline/kickstream/app.py`, `services/pipeline/kickstream/broadcasts/rules.py`, `services/pipeline/kickstream/broadcasts/service.py`
- Modify: `packages/contracts/kickstream.schema.json`; regenerate `services/pipeline/kickstream/contracts.py` and `apps/web/src/contracts.ts`
- Modify tests: `services/pipeline/tests/test_broadcast_rules.py`, `test_broadcast_service.py`, `test_reels.py`, `test_sockets.py`, `test_sockets_real.py`, `test_architecture.py`, `tests/fake_llm.py`
- Modify web: `apps/web/src/studio/elements.tsx` (drop the temporary branch), `apps/web/src/test/fixtures.ts` (stats)
- Modify any studio test that lists element types (search for `"poll"`)

**Interfaces:**
- Produces: `rules.observe_output(state, output, now, new_id)` (no audience argument). `BroadcastService(store, *, output, producer, fallback, cutter, recordings_dir, reels_dir, now, new_id, producer_timeout_s)` (no `audience_view` / `audience_changes`). `BroadcastStats` is `{live_s, score}`. `SceneElement.type` no longer includes `poll` or `qa`. `create_app` / `build_pipeline` no longer take `expert`.

- [ ] **Step 1: Write the failing tests**

Add to `services/pipeline/tests/test_broadcast_rules.py`:

```python
def test_broadcasts_saved_with_audience_stats_still_load():
    state = rules.create(rules.empty_state(ai=False), "b1", "Derby", "", False, T0)
    record = rules.dump(state)
    record["doc"]["broadcasts"][0]["stats"].update(
        {"polls": [{"id": "p1", "question": "Who wins?", "votes": 7}], "questions": 3}
    )
    loaded = rules.load(record, ai=False)
    assert rules.get(loaded, "b1").stats.live_s == 0.0
```

Add to `services/pipeline/tests/test_sockets.py`:

```python
def test_the_fan_routes_are_gone(client):
    assert client.get("/api/audience").status_code == 404
    assert client.get("/api/studio/audience").status_code == 404
```

Add to the studio rules tests (`services/pipeline/tests/test_studio_rules.py`, next to the existing unknown-type test that uses `"webcam"`):

```python
def test_poll_and_qa_elements_from_an_older_studio_are_dropped():
    raw = {"scenes": [{"id": "s1", "elements": [{"type": "poll"}, {"type": "qa"}, {"type": "text"}]}], "templates": []}
    assert [e["type"] for e in rules.sanitize_raw(raw)["scenes"][0]["elements"]] == ["text"]
```

(Match the module's import of `rules`; it is `from kickstream.studio import rules` or similar — read the top of the file.)

- [ ] **Step 2: Run them to see them fail**

Run (in `services/pipeline`): `uv run pytest -q tests/test_broadcast_rules.py::test_broadcasts_saved_with_audience_stats_still_load tests/test_sockets.py::test_the_fan_routes_are_gone tests/test_studio_rules.py::test_poll_and_qa_elements_from_an_older_studio_are_dropped`
Expected: the socket test FAILS (200, not 404) and the studio test FAILS (`poll` and `qa` are kept). The load test passes for now; it guards the next step.

- [ ] **Step 3: Change the schema and regenerate the types**

In `packages/contracts/kickstream.schema.json`:
- `SceneElement.type` enum: remove `"poll"` and `"qa"`.
- delete the `$defs` `PollOption`, `Poll`, `Question`, `Draft`, `QaOnAir`, `Audience`, `BroadcastPoll`.
- `BroadcastStats`:

```json
    "BroadcastStats": {
      "type": "object", "additionalProperties": false,
      "required": ["live_s"],
      "properties": {
        "live_s": { "type": "number", "minimum": 0 },
        "score": { "anyOf": [{ "$ref": "#/$defs/BroadcastScore" }, { "type": "null" }], "default": null }
      }
    },
```

Run: `uv run python -m kickstream.tools.gen_contracts` (in `services/pipeline`) and `pnpm gen:contracts` (in `apps/web`).
Expected: both files regenerate with no `Audience`, `Poll`, `BroadcastPoll`, `"poll"` or `"qa"`.

- [ ] **Step 4: Remove the audience from the broadcasts**

`services/pipeline/kickstream/broadcasts/rules.py`:
- remove `Audience` and `BroadcastPoll` from the contracts import, and `MAX_POLLS`.
- `BroadcastsState` keeps only `doc` and `file_starts`:

```python
@dataclass(frozen=True)
class BroadcastsState:
    doc: Broadcasts
    # What the live session has seen so far. Not saved: a restart closes the session anyway.
    file_starts: Mapping[str, float] = field(default_factory=dict)  # file destination id -> when it began
```

- `_new`: `stats=BroadcastStats(live_s=0.0),`
- `_open(state, output, now, new_id)` drops the `audience` parameter; its last statement becomes `return replace(_doc(state, current_id=target.id), file_starts={})`.
- `_close` ends with `return replace(_put(state, closed), file_starts={})`.
- `observe_output(state, output, now, new_id)` drops `audience` and calls `_open(state, output, now, new_id)`.
- delete `observe_audience` and rename the section comment `# --- following the audience and the match ---…` to `# --- following the match ---…` (keep its dash length).
- `load` forgets stats that older versions kept, before validating:

```python
_FORGOTTEN_STATS = ("polls", "questions")  # kept by versions that had a fan page


def load(record: dict, ai: bool) -> BroadcastsState:
    """A saved state, as it should be after a restart: nothing live, nothing being made."""
    raw = record["doc"]
    for broadcast in raw.get("broadcasts", []):
        for name in _FORGOTTEN_STATS:
            broadcast.get("stats", {}).pop(name, None)
    doc = Broadcasts.model_validate(raw)
```

(keep the rest of `load` as it is.)

`services/pipeline/kickstream/broadcasts/service.py`:
- `from kickstream.contracts import Broadcasts, KeyMoment, MatchStatus, Narrative, Output, Reel`
- delete the `audience_view` and `audience_changes` parameters and attributes, and `observe_audience`.
- `observe_output`: `lambda state: rules.observe_output(state, output, self._now(), new_id)`
- rename the section comment to `# --- following the output and the match ---…`.
- `run`:

```python
    async def run(self) -> None:
        await self._follow(self._output.changes(), self.observe_output)
```

- [ ] **Step 5: Remove the audience package and its wiring**

`services/pipeline/kickstream/app.py`:
- delete the imports `AgentExpertWriter`, `build_audience_router`, `MatchTracker`, `AudienceService`, `AudienceStage`, `ExpertWriter`.
- `Pipeline`: delete the `audience` and `tracker` fields; in `start` delete the audience task line; in `stop` delete `await self.audience.stop()`.
- `build_pipeline` and `create_app`: delete the `expert` parameter and its passing; delete `tracker = MatchTracker()`, the `if expert is None …` block and the `audience = AudienceService(…)` block; delete `audience_view=…` and `audience_changes=…` from `BroadcastService(…)`; delete `AudienceStage(bus, tracker),` from `stages`; `return Pipeline(bus, store, broadcaster, controller, studio, output, broadcasts, stages)`.
- delete the `app.include_router(build_audience_router(…))` block.
- `JsonRecordStore` is still used by output and broadcasts; keep its import.

Delete `services/pipeline/kickstream/audience/`, `ports/audience_store.py`, `ports/expert.py`, `adapters/agent_expert.py`, and the six `tests/test_audience_*.py` files.

`tests/fake_llm.py`: delete `"match_expert",` from the roles tuple and the `if role == "match_expert": …` branch.

`tests/test_architecture.py`: delete `"audience",` from the package list.

- [ ] **Step 6: Update the remaining pipeline tests**

`tests/test_broadcast_rules.py`:
- delete the `poll`, `audience` and `question` helpers and the `Audience`, `Poll`, `PollOption`, `Question` imports.
- in the `go_live`-style helper at line ~70, change `rules.observe_output(state, live, aud, at, "auto")` to `rules.observe_output(state, live, at, "auto")` and drop its `aud` parameter and every caller's argument for it.
- every `rules.observe_output(state, X, None, T, "auto")` becomes `rules.observe_output(state, X, T, "auto")`.
- delete `test_polls_and_questions_while_live_are_counted_and_earlier_ones_are_not` and `test_the_audience_is_ignored_off_air`, and the section comment above them becomes `# --- the match ---…`.

`tests/test_broadcast_service.py`:
- `from tests.test_broadcast_rules import destination, output`
- delete `audience_view=…` from the rig.
- rename `test_the_audience_and_match_are_kept_while_live` to `test_the_match_is_kept_while_live`, delete its `observe_audience` line and its `stats.polls` assertion.

`tests/test_reels.py` lines 39–40: delete `polls=[],` and `questions=0,`.

`tests/test_sockets.py`:
- delete `ANN` and `test_the_fan_socket_never_carries_hidden_questions_or_the_draft`.
- parametrize list becomes `["/api/studio/socket", "/api/broadcasts/socket", "/api/studio/output/socket"]`.
- `test_a_tool_that_sends_no_origin_can_open_a_socket` connects to `/api/broadcasts/socket`.

`tests/test_sockets_real.py`: replace every `/api/audience/socket` with `/api/broadcasts/socket`.

`apps/web/src/studio/elements.tsx`: delete the temporary `case "poll": case "qa": return null;` branch.

`apps/web/src/test/fixtures.ts`: `stats: { live_s: 0, score: null }` in `broadcast`, and in `endedBroadcast` delete `questions: 3,` and the `polls: [...]` line.

Search for leftovers: `rg -n "audience|Audience|BroadcastPoll|\"poll\"|\"qa\"|expert|Expert" services/pipeline apps/web/src --glob "!**/__pycache__/**"` — expected: no matches except unrelated words in comments; fix any real reference.

- [ ] **Step 7: Run every suite**

Run (in `services/pipeline`): `uv run pytest -q`, `uv run ruff check .`, `uv run ruff format --check .`
Expected: all pass; ruff clean (run `uv run ruff format .` if only formatting differs).
Run (in `apps/web`): `pnpm test`, `pnpm typecheck`
Expected: all pass; `tsc` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add -A services/pipeline packages/contracts apps/web/src
git commit -m "Remove the audience package, its routes, scene elements and broadcast stats"
```

---

### Task 3: End to end and docs

**Files:**
- Delete: `apps/web/e2e/audience.spec.ts`
- Modify: `apps/web/playwright.config.ts` (comments on lines 6 and 9), `README.md`
- Modify: `apps/web/e2e/home.spec.ts` (add an assertion)

- [ ] **Step 1: Assert the fan page is gone end to end**

In `apps/web/e2e/home.spec.ts`, in the first test right after `await expect(page.locator('a[href="/program"]')).toHaveCount(0);` on Home, add:

```ts
  await expect(page.locator('a[href="/join"]')).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Fan page" })).toHaveCount(0);
```

- [ ] **Step 2: Remove the audience end-to-end test and fix comments**

Delete `apps/web/e2e/audience.spec.ts`. In `apps/web/playwright.config.ts`, line 6: `// never touch the scenes or match of a developer who has Kickstream running.`; line 9: `// A fresh data directory for every run, so one run's scenes and broadcasts never meet the next.`

- [ ] **Step 3: Run the end-to-end suite**

Run (in `apps/web`, PowerShell):

```powershell
foreach ($p in 8010,5183) { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force } }; pnpm e2e --reporter=line
```

Expected: 6 passed (audience gone; broadcast, two home, output, smoke, studio).

- [ ] **Step 4: Update the README**

In `README.md`:
- the pages table: delete the `/join` row.
- delete the paragraph(s) and table about the fan page, polls, questions and the expert (the section around the `/studio`, **Audience** tab row and the `/api/audience` endpoints), including the reverse-proxy sentence that says to expose only `/join`, `/api/audience` and the match routes; replace that sentence with: "Kickstream has no sign-in: keep the pipeline and the web server reachable from your machine only."
- in "Broadcasts and reels", **Stats** becomes: "time on air, destinations reached, the score, and the key moments with their commentary."
- the first paragraph after the pages table, if it mentions fans voting or asking, drops that clause.
- search the README for `poll`, `question`, `fan page`, `/join`, `Audience` and resolve each remaining mention (the Fan/Analyst commentary mode stays: it is about narration, not the fan page).

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/e2e apps/web/playwright.config.ts README.md
git commit -m "Drop the audience end-to-end test and the fan page from the docs"
```
