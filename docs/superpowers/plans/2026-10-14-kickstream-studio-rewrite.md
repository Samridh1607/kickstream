# Studio Rewrite Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tabbed studio control page with a StreamYard-style stage-first layout so every existing feature is one click away, nothing important sits below the fold at 1536 × 864, and every feature still works end to end.

**Architecture:** `StudioPage.tsx` becomes a thin shell that owns studio/output/people/fans documents and wires small focused components: `TopBar`, `Stage`, `Backstage`, `SceneStrip`, `ToolRail` (+ one panel file per tool), and `EditLayout`. The scene renderer (`SceneCanvas`, `elements`, `widgets`) and `ProgramPage` stay unchanged. Call mute and leave lifecycle move into `calls/useHostCall.ts` for both the studio and the guest page. Snapping gains a pure `snapToGuides` helper in `geometry.ts`. No pipeline route changes in this phase.

**Tech Stack:** React 19, Fluent UI v9, Vitest, Playwright. No new dependencies. Pipeline untouched except if a comment or README mentions the old studio layout.

**Spec:** `docs/superpowers/specs/2026-10-14-kickstream-studio-overhaul-design.md` (Phase 1).

**Baseline on this branch:** Commit `8d8bbe2` already has match agents, Ask Copilot, the fan zone (`FanPanel`), and studio widgets (`widgets.tsx`). The Comments tool reuses `FanPanel`. The Elements gallery already includes the 11 widgets; Edit layout must keep them.

Two deliberate refinements of the spec:

1. **Live mode has no side-by-side "Editor" + "Program preview".** The Stage always shows the on-air scene (what goes out). Scene editing happens only in **Edit layout** mode, which replaces the stage area. Existing unit/e2e tests that use region `"Editor"` and `"Program preview"` are rewritten to `"Stage"` and `"Edit layout"`.
2. **Click a scene thumbnail to put it on the program** (today's Switch). **Edit** is on the thumbnail's menu and opens Edit layout for that scene. Aria labels keep the verbs streamers and tests already know where possible (`Switch to X` becomes the thumbnail's primary name; menu items keep `Edit X`, `Duplicate X`, etc.).

## Global Constraints

- Secrets (`KICKSTREAM_*`, stream keys) stay in the git-ignored root `.env` or `.data/`. Never log, print, commit or echo them. Never set `KICKSTREAM_*` in a shared shell.
- Never stage `.playwright-mcp/`, `apps/web/tsconfig.tsbuildinfo`, `.data/`, `.data-e2e/`, `test-results/` or `playwright-report/`. Stage exact paths.
- The studio has no sign-in. Studio routes stay local; on a public host only `/api/guest/*` answers (plus a valid co-host cookie).
- Keep: `SceneCanvas.tsx`, `elements.tsx`, `widgets.tsx`, `ProgramPage.tsx`, all of `studio/api.ts`, every pipeline studio route.
- Replace: `StudioPage.tsx` and `panels.tsx` (split into the new files; delete `panels.tsx` only after every import moves).
- UI text is English and in sentence case. Comments only for constraints the code cannot show.
- Match surrounding code: Fluent `makeStyles`, `aria-label` on regions and actions, optimistic `pending` scene edits, one shared `problem` string shown as a toast.
- Responsive: below 1280 px the rail collapses to icons; below 1100 px backstage and the scene strip scroll horizontally; at 1536 × 864 nothing important is below the fold.
- Commands:
  - Web, in `apps/web`: `pnpm exec vitest run`, `pnpm exec tsc -b`, `pnpm e2e --reporter=line`.
  - Pipeline, in `services/pipeline` (sanity only; no expected code change): `uv run pytest -q`, `uv run ruff check .`.

## Review Focus

1. **The call must survive tool switches.** Opening Banners must not tear down the host camera. `useHostCall` lives in `StudioPage` (or a provider it mounts once) and is passed into Backstage and Guests; it must not remount when the open tool changes.
2. **Edit layout must not interrupt the stream.** While Edit layout is open, the program page and capture keep showing the on-air scene. The Stage is replaced in the control page only.
3. **Editing an off-air scene.** The streamer opens Edit on Break while Live match is on air; changes save to Break only; Put on the program / activating from the strip cuts over.
4. **Label continuity.** Prefer keeping existing aria-labels (`Show banner`, `Invite`, `Add me to stage`, `Replay 23' Goal`, element labels) so unit and e2e updates stay mechanical.

## Label map (old → new)

| Old | New |
|---|---|
| region `"Editor"` | region `"Edit layout"` (only while editing) |
| region `"Program preview"` | region `"Stage"` (always the on-air scene in live mode) |
| region `"Output"` | tool `"Stream"`; inside it OutputTab's own region `"Stream"` (the StreamTool adds no region of its own) |
| (new) the open tool's panel | region `"{Tool} tool"`, e.g. `"Banners tool"`, `"Stream tool"`, so it never shares a name with a region inside it |
| region `"People"` | region `"Backstage"` (tiles) + tool `"Guests"` (invites) |
| tab `"Fans"` | tool `"Comments"` (still mounts `FanPanel`) |
| tab `"Banner"` / `"Ticker"` | tool `"Banners"` (banner + ticker) |
| tab `"Highlights"` | tool `"Replays"` |
| tab `"Countdown"` | tool `"Timer"` |
| tab `"Settings"` | tool `"Settings"` |
| tab `"Elements"` | Edit layout's library + layers + inspector |
| `"Edit X"` (scene list button) | menu item `"Edit X"` on the thumbnail |
| `"Switch to X"` | activate by clicking the thumbnail (aria-label `"Switch to X"`) |
| `"On air: X"` in AppNav | Top bar shows on-air scene name; keep text for tests where easy |
| full-width `MessageBar` for errors | toast region `"Studio errors"` above the stage |

## File structure

Create under `apps/web/src/`:

```
calls/useHostCall.ts              host/guest mute + leave lifecycle
studio/TopBar.tsx                 broadcast, LIVE timer, Edit layout, Go live / End
studio/Stage.tsx                  on-air SceneCanvas + Program tag
studio/Backstage.tsx              host + guest tiles, stage toggles, Invite opens Guests
studio/SceneStrip.tsx             thumbnails 1–9, menus, + Scene picker
studio/ToolRail.tsx               icon rail; one tool open
studio/EditLayout.tsx             library, canvas, layers, inspector; Put on program
studio/tools/BannersTool.tsx      from BannerPanel + TickerPanel
studio/tools/CommentsTool.tsx     wraps FanPanel
studio/tools/GuestsTool.tsx       invites from PeoplePanel
studio/tools/ReplaysTool.tsx      from HighlightsPanel
studio/tools/TimerTool.tsx        from CountdownPanel
studio/tools/StreamTool.tsx       wraps OutputTab
studio/tools/SettingsTool.tsx     from SettingsPanel
studio/toast.tsx                  small error toast helper (optional; can live in StudioPage)
```

Modify:

```
studio/geometry.ts                + snapToGuides
studio/geometry.test.ts           new or extend
studio/StudioPage.tsx             rewrite as shell
studio/StudioPage.test.tsx        new regions / tools
studio/SceneCanvas.tsx            only if Edit layout needs a snap callback (prefer geometry only)
people/PeoplePanel.tsx            thin wrappers or delete after Backstage + GuestsTool + useHostCall
people/GuestPage.tsx              use useHostCall
people/PeoplePanel.test.tsx       update for extraction
people/GuestPage.test.tsx         update if needed
shell/AppNav.tsx                  TopBar may absorb LiveStatus; keep AppNav for non-studio pages
broadcasts/StudioBroadcast.tsx    TopBar reuses useStudioBroadcast; StudioBroadcastBar can go unused
```

Delete after imports move:

```
studio/panels.tsx                 SceneList, ElementPanel, BannerPanel, … all migrated
```

E2E update (do not delete):

```
e2e/studio.spec.ts
e2e/agents.spec.ts                (fan zone / studio parts)
e2e/output.spec.ts
e2e/home.spec.ts
e2e/broadcast.spec.ts
e2e/guests.spec.ts
e2e/broadcasts.ts                 openStudio helper if labels change
e2e/studio-layout.spec.ts         NEW: 1536×864 fold check
```

---

### Task 1: Snap to guides (pure)

**Files:**
- Modify: `apps/web/src/studio/geometry.ts`
- Create or modify: `apps/web/src/studio/geometry.test.ts`

**Interfaces:**
- Produces: `snapToGuides(rect: Rect, others: Rect[], threshold?: number): Rect`
  - Guides: canvas left/right/top/bottom (0, CANVAS.width, 0, CANVAS.height), canvas centre lines (CANVAS.width/2, CANVAS.height/2), and every other element's left/right/top/bottom/centreX/centreY.
  - For the moving rect, candidate edges are left (`x`), right (`x+width`), centreX (`x+width/2`), top (`y`), bottom (`y+height`), centreY (`y+height/2`).
  - When the absolute distance from a candidate to a guide is ≤ threshold (default 8), shift `x` or `y` so that edge lands on the guide.
  - If several guides qualify on one axis, pick the closest.
  - Then run `clampRect` on the result. Do not change width/height.
  - Grid snapping (`snap`) still applies in `moveBy` / `resizeBy` as today; Edit layout calls `snapToGuides` after a drag delta is applied (see Task 8).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "vitest";
import { CANVAS, clampRect, snapToGuides, type Rect } from "./geometry";

const box = (x: number, y: number, width = 100, height = 80): Rect => ({ x, y, width, height });

test("a rect near the left edge snaps to 0", () => {
  expect(snapToGuides(box(6, 100), []).x).toBe(0);
});

test("a rect near the canvas centre snaps its centre to the midline", () => {
  const width = 200;
  const moved = snapToGuides(box(CANVAS.width / 2 - width / 2 + 5, 40, width, 80), []);
  expect(moved.x + moved.width / 2).toBe(CANVAS.width / 2);
});

test("a rect near another element's right edge snaps its left to that edge", () => {
  const other = box(100, 100, 200, 100); // right edge at 300
  const moved = snapToGuides(box(305, 100), [other]);
  expect(moved.x).toBe(300);
});

test("when two guides compete, the closer one wins", () => {
  const other = box(400, 400, 100, 100); // left 400, centre 450, right 500
  // The moving left edge at 494 is 6 from 500 and 44 from 450 → snaps to 500.
  expect(snapToGuides(box(494, 50, 60, 60), [other], 8).x).toBe(500);
});

test("an edge already on a guide stays put rather than jumping to a farther one", () => {
  const other = box(400, 400, 100, 100); // left 400
  // Left edge already at 400; the right edge (460) is 10 from nothing in reach.
  expect(snapToGuides(box(400, 50, 60, 60), [other], 8).x).toBe(400);
});

test("snapping never leaves the canvas", () => {
  const huge = { x: -50, y: -50, width: 100, height: 80 };
  expect(snapToGuides(huge, [])).toEqual(clampRect({ ...huge, x: 0, y: 0 }));
});
```

- [ ] **Step 2: Run the tests — expect fail**

```bash
pnpm exec vitest run src/studio/geometry.test.ts
```

- [ ] **Step 3: Implement `snapToGuides` in `geometry.ts`**

```ts
const SNAP_THRESHOLD = 8;

/** The smallest shift that puts one of `edges` on one of `guides`, or 0 when none is within reach. */
function nearestShift(edges: number[], guides: number[], threshold: number): number {
  let best: number | null = null;
  for (const edge of edges) {
    for (const guide of guides) {
      const shift = guide - edge;
      if (Math.abs(shift) <= threshold && (best === null || Math.abs(shift) < Math.abs(best))) best = shift;
    }
  }
  return best ?? 0;
}

/** Pulls a rectangle onto nearby canvas edges, centre lines or other elements' edges. Its size is unchanged. */
export function snapToGuides(rect: Rect, others: Rect[], threshold = SNAP_THRESHOLD): Rect {
  const xGuides = [0, CANVAS.width / 2, CANVAS.width];
  const yGuides = [0, CANVAS.height / 2, CANVAS.height];
  for (const other of others) {
    xGuides.push(other.x, other.x + other.width / 2, other.x + other.width);
    yGuides.push(other.y, other.y + other.height / 2, other.y + other.height);
  }
  const dx = nearestShift([rect.x, rect.x + rect.width / 2, rect.x + rect.width], xGuides, threshold);
  const dy = nearestShift([rect.y, rect.y + rect.height / 2, rect.y + rect.height], yGuides, threshold);
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy });
}
```

An edge already on a guide gives a shift of 0, which beats every other candidate, so it stays put.

- [ ] **Step 4: Run the tests — expect pass**

```bash
pnpm exec vitest run src/studio/geometry.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/studio/geometry.ts apps/web/src/studio/geometry.test.ts
git commit -m "Snap scene elements to canvas and sibling edges while editing"
```

---

### Task 2: `useHostCall` shared hook

**Files:**
- Create: `apps/web/src/calls/useHostCall.ts`
- Modify: `apps/web/src/people/PeoplePanel.tsx` (use the hook; keep UI until Task 5/7 delete it)
- Modify: `apps/web/src/people/GuestPage.tsx`
- Modify: `apps/web/src/people/PeoplePanel.test.tsx` (must still pass)

**Interfaces:**
- Produces `useHostCall(options)`:
  - Inputs: `{ service: CallSeat["service"] | null | undefined; mutedLive: boolean; newCall?: (service) => RoomCall }`
  - Returns: `{ call: RoomCall | null; problem: string | null; setProblem; devices; join(seat: CallSeat): Promise<void>; leave(): Promise<void>; toggleMute(): Promise<void> }`
  - On unmount or when `call` is replaced: `leave().catch(() => undefined)`.
  - When `mutedLive` becomes true while joined: `setMuted(true)` and surface failures via `problem`.
  - `join` creates the call via `newCall(service)`, sets it, applies `setMuted(mutedLive)`, then `call.join(seat)` — match today's PeoplePanel `joinHost` / GuestPage join order.
  - GuestPage may still create the call eagerly when `service` is set (today's behaviour); either:
    - (A) expose `attach(call)` / `ensureCall()` for GuestPage, or
    - (B) GuestPage keeps creating the RoomCall and only uses the hook for mute + leave lifecycle.
  - Prefer (B) if (A) thrashes tests: extract `useCallMuteLifecycle(call, mutedLive, setProblem)` plus shared `muteProblem`. The spec name is `useHostCall`; if you split helpers, keep `useHostCall` as the PeoplePanel-facing API that wraps them.

- [ ] **Step 1: Extract without changing behaviour**

Move the mute/leave/`useCallUpdates`/`useDevices` block from PeoplePanel into `useHostCall`. PeoplePanel calls `join` with `hostSeat(...)`. Re-run:

```bash
pnpm exec vitest run src/people/PeoplePanel.test.tsx src/people/GuestPage.test.tsx
```

- [ ] **Step 2: Point GuestPage at the shared mute lifecycle**

GuestPage must still pass all existing tests.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/calls/useHostCall.ts apps/web/src/people/PeoplePanel.tsx apps/web/src/people/GuestPage.tsx apps/web/src/people/PeoplePanel.test.tsx apps/web/src/people/GuestPage.test.tsx
git commit -m "Share host and guest call mute lifecycle in useHostCall"
```

---

### Task 3: Top bar

**Files:**
- Create: `apps/web/src/studio/TopBar.tsx`
- Create: `apps/web/src/studio/TopBar.test.tsx`

**Interfaces:**
- Props:
  ```ts
  {
    broadcast: Broadcast | null;           // null when not in a broadcast studio
    liveElsewhere: Broadcast | null;
    output: Output | null;
    connected: boolean;
    onAirName: string;
    editing: boolean;                     // Edit layout open?
    onToggleEdit(): void;
    onGoLive?(): void;                    // undefined when not ready
    onEnd?(): void;                       // when live
    busy?: boolean;
    now: number;                          // for elapsed LIVE timer
  }
  ```
- Region: `aria-label="Studio top bar"`.
- Shows: Trail/breadcrumb when `broadcast` is set (reuse `Trail` from shell), broadcast title, state badge (`Ready` / `LIVE` + `HH:MM:SS` from `broadcast.started_at` / `now`, `Ended`), recording badge when `broadcast.record`, connection badge, destination lights from `output.destinations` that are enabled (name + status text, same idea as today's `LiveStatus`), button `"Edit layout"` / `"Exit layout"` (`aria-pressed={editing}`), primary `"Go live"` or `"End broadcast"`.
- Shortcuts button may be a disabled placeholder with title `"Coming in a later phase"` (phase 5).
- Do not mount a second `StudioBroadcastBar`; TopBar replaces it.
- The part of the top bar that names the broadcast keeps `aria-label="Studio broadcast"` and a link to `/broadcasts/{id}` whose text is the broadcast title: `e2e/broadcasts.ts` (`openStudio`) waits for exactly that. It also keeps today's "This broadcast no longer exists" warning and the `liveElsewhere` / `refusal` messages from `StudioBroadcastBar`.

- [ ] **Step 1: Failing tests for LIVE timer, Go live / End, Edit layout toggle**

```ts
test("while the broadcast is live the top bar shows an elapsed timer and End broadcast", () => {
  // broadcast.state === "live", started_at = now - 3661 → "01:01:01"
  // button End broadcast present; Go live absent
});

test("Edit layout toggles the pressed state", () => {
  // click Edit layout → onToggleEdit called
});
```

- [ ] **Step 2: Implement TopBar**

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/studio/TopBar.tsx apps/web/src/studio/TopBar.test.tsx
git commit -m "Add the studio top bar with live timer and primary actions"
```

---

### Task 4: Stage

**Files:**
- Create: `apps/web/src/studio/Stage.tsx`
- Create: `apps/web/src/studio/Stage.test.tsx`

**Interfaces:**
- Props: `{ scene: Scene; data: SceneData; live: boolean; scale?: number }` — `data` is whatever `SceneCanvas` already takes (match, studio, now, language, fans, cameras).
- Region `aria-label="Stage"`.
- Renders `SceneCanvas` with `withFallbacks(scene, …)` so cameras and fan spotlights appear like today's program preview.
- Red outline + visible `"Program"` tag when `live` is true.
- Scales with the same ResizeObserver approach as today's `useStageScale` (move that helper into Stage or a tiny `useStageScale.ts`).

- [ ] **Step 1: Test that the stage shows the scoreboard from the given scene and a Program tag when live**

- [ ] **Step 2: Implement**

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/studio/Stage.tsx apps/web/src/studio/Stage.test.tsx
git commit -m "Add the studio stage that shows the on-air program"
```

---

### Task 5: Backstage row

**Files:**
- Create: `apps/web/src/studio/Backstage.tsx`
- Create: `apps/web/src/studio/Backstage.test.tsx`

**Interfaces:**
- Props:
  ```ts
  {
    broadcastId: string;
    people: People | null;
    live: boolean;
    call: ReturnType<typeof useHostCall>; // or the fields it needs
    onPeople(doc: People): void;
    onInvite(): void; // opens Guests tool
  }
  ```
- Region `aria-label="Backstage"`.
- Host tile: Join with camera / VideoBox + mute + device pickers + `"Add me to stage"` / `"Remove me from stage"` (same labels as PeoplePanel).
- One tile per invite that is present (or every invite with presence badge): role, name via `inviteLabel`, Add/Remove from stage. Members show `"Backstage only"` and no stage button.
- Last tile: button `"Invite"` that calls `onInvite`.
- When `people.service` is null, show the existing SETUP message.
- Horizontal scroll below 1100 px (`overflowX: auto` on the row).

- [ ] **Step 1: Port the PeoplePanel tests that cover stage toggles and Join with camera into Backstage.test.tsx (subset)**

- [ ] **Step 2: Implement Backstage using useHostCall from props (do not create a second call)**

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/studio/Backstage.tsx apps/web/src/studio/Backstage.test.tsx
git commit -m "Add the backstage row for host and guest camera tiles"
```

---

### Task 6: Scene strip

**Files:**
- Create: `apps/web/src/studio/SceneStrip.tsx`
- Create: `apps/web/src/studio/SceneStrip.test.tsx`

**Interfaces:**
- Props mirror today's `SceneList` callbacks, plus `data` for thumbnails and `onRename(sceneId, name)`.
- Region `aria-label="Scenes"`.
- Each scene: small non-editable `SceneCanvas` (scale ~0.08), index badge `1`…`9` (scenes after 9 show no number or `·`), red outline when on air, brand outline when being edited in Edit layout.
- Primary control: button `aria-label={`Switch to ${scene.name}`}` — clicking activates unless already on air (then no-op or focus only).
- Menu button `aria-label={`Scene menu for ${scene.name}`}` with items:
  - `Edit ${name}` → `onEdit`
  - `Rename ${name}` → prompt or inline field; commit via `onRename` → parent calls `saveScene({ id, name, elements })`
  - `Duplicate ${name}` → `onCreate("scene", id)`
  - Commentary submenu or select: Studio default / Fan / Analyst → `setSceneMode` via callback `onMode(sceneId, mode)`
  - `Save ${name} as template`
  - `Delete ${name}` (disabled when on air or only scene)
- Last tile: `+ Scene` opens a dialog/popover listing built-ins (`BUILTIN` from today's panels) and saved templates; choosing one calls `onCreate`.
- Saved templates list with `Delete template X` remains reachable from the + Scene dialog footer or a small link.

- [ ] **Step 1: Tests for Switch, Edit menu, Duplicate, Delete disabled on air, Add scene from builtin**

- [ ] **Step 2: Implement**

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/studio/SceneStrip.tsx apps/web/src/studio/SceneStrip.test.tsx
git commit -m "Add the scene strip with thumbnails and per-scene menus"
```

---

### Task 7: Tool panels (port from panels.tsx)

**Files:**
- Create each under `apps/web/src/studio/tools/`:
  - `BannersTool.tsx` — move `BannerPanel` + `TickerPanel` body; keep labels (`Banner text`, `Show banner`, `Clear banner`, `Save ticker`, …).
  - `CommentsTool.tsx` — `export function CommentsTool(props: { fans; onRun }) { return <FanPanel …/> }`
  - `GuestsTool.tsx` — invite form + list from PeoplePanel (`Name (optional)`, `Role`, `Invite`, `Invite link for X`, `Revoke invite for X`). No camera join UI here (that's Backstage). Accept `call` only if needed for display; prefer invites-only.
  - `ReplaysTool.tsx` — move `HighlightsPanel` (keep `Replay ${label}`, `Show ${label} on banner`, `Stop replay`).
  - `TimerTool.tsx` — move `CountdownPanel`.
  - `StreamTool.tsx` — region `aria-label="Stream"` wrapping `OutputTab`.
  - `SettingsTool.tsx` — move `SettingsPanel`.
- Optional tiny tests per tool, or rely on StudioPage tests in Task 10.

- [ ] **Step 1: Move code; re-export temporarily from `panels.tsx` if needed so StudioPage still builds mid-migration**

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/studio/tools apps/web/src/studio/panels.tsx
git commit -m "Split studio tool panels into one file per rail tool"
```

---

### Task 8: Tool rail

**Files:**
- Create: `apps/web/src/studio/ToolRail.tsx`
- Create: `apps/web/src/studio/ToolRail.test.tsx`

**Interfaces:**
- Tools (phase 1): `Banners | Comments | Guests | Replays | Timer | Stream | Settings`
- Guests only listed when `broadcastId` is defined (same rule as today's People tab).
- Props: `{ open: ToolName | null; onOpen(tool: ToolName | null); broadcastId?: string; children for the open panel }` or render panels via a render prop / switch in StudioPage.
- Each tool is a toggle button with `aria-label` equal to the tool name (`"Banners"`, …). Pressing the open tool again closes it (`onOpen(null)`).
- Below 1280 px: collapse labels (icons only) via CSS `@media (max-width: 1280px)`.
- Region `aria-label="Tools"`.

- [ ] **Step 1: Test that choosing Banners shows its panel and choosing it again closes it; Guests absent without broadcastId**

- [ ] **Step 2: Implement**

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/studio/ToolRail.tsx apps/web/src/studio/ToolRail.test.tsx
git commit -m "Add the studio tool rail with one open panel at a time"
```

---

### Task 9: Edit layout mode

**Files:**
- Create: `apps/web/src/studio/EditLayout.tsx`
- Create: `apps/web/src/studio/EditLayout.test.tsx`
- Modify: `apps/web/src/studio/SceneCanvas.tsx` only if needed to accept an optional `snapRect?: (rect, others) => Rect` used at end of drag/resize; prefer applying `snapToGuides` inside a wrapper callback in EditLayout that maps `onChange`.

**Interfaces:**
- Props: scene being edited, selectedId, studio, data, onSelect, onChange, onUpload, onActivate (Put on program), onMode, onRename, status (match status for player picker), onClose.
- Region `aria-label="Edit layout"`.
- Header: `Editing: ${name}`, badge On the program / Not on the program, button `Put ${name} on the program` when off air, Commentary select (same as today), Close / Exit.
- Left: widget gallery + element type add (from `ElementPanel` / `WIDGETS`), layers list (Show / Select / Bring forward / Send back / Remove — **keep these aria-labels**).
- Centre: editable `SceneCanvas`. After each drag/resize commit, snap the moved element with `snapToGuides(rect, others)` before `onChange`.
- Right: inspector for selected element props (all branches from today's `ElementPanel`).
- Must support every widget type already in `WIDGETS`.

- [ ] **Step 1: Port ElementPanel behaviour tests into EditLayout.test.tsx (add widget, hide, reorder, text edit, graph metric)**

- [ ] **Step 2: Implement**

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/studio/EditLayout.tsx apps/web/src/studio/EditLayout.test.tsx apps/web/src/studio/SceneCanvas.tsx
git commit -m "Add edit layout with element library, layers and guide snapping"
```

---

### Task 10: Wire `StudioPage`

**Files:**
- Rewrite: `apps/web/src/studio/StudioPage.tsx`
- Rewrite: `apps/web/src/studio/StudioPage.test.tsx`
- Delete: `apps/web/src/studio/panels.tsx` once nothing imports it
- Optionally stop rendering `StudioBroadcastBar` (TopBar covers it)

**Layout (CSS grid):**

```
[ TopBar full width ]
[ toast ]
[ Stage or EditLayout  |  ToolRail + open tool ]
[ Backstage (if broadcastId) spanning stage column ]
[ SceneStrip spanning stage column ]
```

At max-width 1100px stack tools under the stage.

**State to keep from today:**
- `useStudio`, `useStudioBroadcast`, output/people/fans live docs, `useCurrentMatch`, `useMatch`, `editingId` / `selectedId` / `pending` / `problem` / `run` / `runOutput` / `runFans` / `changeElements` / `upload` / go live / end.
- New: `editingLayout: boolean`, `openTool: ToolName | null`.
- Mount **one** `useHostCall` when `broadcastId` is set; pass into Backstage. Keep the call mounted even when Guests tool is closed (Backstage stays mounted; do not `hidden`-unmount the call owner).
- `problem` renders inside region `"Studio errors"` as a dismissible toast above the stage (not a full-width MessageBar).
- AppNav: keep for Copilot / theme / main nav, or slim it — do not lose AskCopilot if AppNav currently hosts it.

- [ ] **Step 1: Update StudioPage.test.tsx to the label map**

Mechanical replacements:
- `region "Editor"` → when testing edits, open Edit layout first (`getByRole("button", { name: "Edit layout" })` or scene menu `Edit Break`).
- `region "Program preview"` → `region "Stage"`.
- `openTab("Banner")` → open tool Banners.
- `openTab("Fans")` → Comments.
- `openTab("People")` → Guests tool (invites) / Backstage (stage).
- `openTab("Highlights")` → Replays; Countdown → Timer; Output region → Stream tool.
- People panel hidden-while-other-tab test → switch tools; assert call still joined (mock).

All 30 behaviours must remain covered (scene edit off-air, drag save, widgets, banners, ticker, highlights, countdown, settings, refusals, SSE replace, selection isolation, pending race, output box, live stream status, people+cameras, fans spotlight).

- [ ] **Step 2: Implement StudioPage shell**

- [ ] **Step 3: Run unit tests**

```bash
pnpm exec vitest run src/studio src/people src/fans src/calls
pnpm exec tsc -b
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/studio apps/web/src/people apps/web/src/calls apps/web/src/shell
git commit -m "Rewrite the studio page as a stage-first layout with a tool rail"
```

---

### Task 11: End-to-end specs

**Files:**
- Modify: `apps/web/e2e/studio.spec.ts`, `agents.spec.ts`, `output.spec.ts`, `home.spec.ts`, `broadcast.spec.ts`, `guests.spec.ts`, and `e2e/broadcasts.ts` if needed.
- Create: `apps/web/e2e/studio-layout.spec.ts`

**studio.spec.ts flow (update selectors):**
1. Open studio via `openStudio`.
2. `Switch to E2E scene` via scene strip thumbnail.
3. Expect on-air text / Stage scoreboard; program page unchanged (`/studio?output`).
4. `Edit E2E scene` from menu → Edit layout → drag scoreboard → expect program page left style change (editing on-air scene still pushes to program).
5. Open tool Banners → Show banner → program shows it.
6. Replays tool → Replay goal.
7. Timer tool → Take a break / End break.

**guests.spec.ts:** Invite via Guests tool; Backstage for stage buttons; keep invite link labels.

**studio-layout.spec.ts:**

```ts
test("at 1536×864 the stage, backstage, scenes and tools are in the first viewport", async ({ page, request }) => {
  await page.setViewportSize({ width: 1536, height: 864 });
  await openStudio(page, request, `Layout ${Date.now()}`);
  for (const name of ["Stage", "Scenes", "Tools"]) {
    const box = await page.getByRole("region", { name }).boundingBox();
    expect(box).toBeTruthy();
    expect(box!.y + box!.height).toBeLessThanOrEqual(864);
  }
  // Backstage only when broadcast studio — openStudio should create one
  const backstage = await page.getByRole("region", { name: "Backstage" }).boundingBox();
  expect(backstage!.y + backstage!.height).toBeLessThanOrEqual(864);
});
```

- [ ] **Step 1: Update specs**

- [ ] **Step 2: Run e2e**

```bash
pnpm e2e --reporter=line
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e
git commit -m "Point studio end-to-end tests at the stage-first layout"
```

---

### Task 12: README and final check

**Files:**
- Modify: `README.md` — studio screenshots / control descriptions if they mention tabs.
- Run full web unit + typecheck + e2e; pipeline pytest/ruff sanity (expect no code changes).

- [ ] **Step 1: Update README studio section briefly**

- [ ] **Step 2: Verify**

```bash
# apps/web
pnpm exec tsc -b
pnpm exec vitest run
pnpm e2e --reporter=line
# services/pipeline
uv run ruff check .
uv run pytest -q
```

- [ ] **Step 3: Commit any README fixes**

```bash
git add README.md
git commit -m "Describe the stage-first studio in the README"
```

---

## Self-review (plan author)

| Spec requirement | Task |
|---|---|
| Top bar with broadcast, LIVE, Edit layout, Go live/End | 3, 10 |
| Stage = on-air program | 4, 10 |
| Backstage tiles + Invite | 5, 10 |
| Scene strip thumbnails, 1–9, menus, + Scene | 6 |
| Tool rail: Banners, Comments, Guests, Replays, Timer, Stream, Settings | 7, 8 |
| Edit layout: library, layers, inspector, guide snap | 1, 9 |
| useHostCall shared | 2 |
| Responsive 1280 / 1100 / 1536×864 | 8, 5, 6, 11 |
| Error toast | 10 |
| Keep SceneCanvas / widgets / ProgramPage / APIs | (constraint) |
| FanPanel as Comments; widgets in Edit layout | 7, 9 |
| E2E + layout test | 11 |
| Every old StudioPage behaviour covered | 10 |

**Gaps deliberately deferred (later phases):** Brand / Match / Rundown / Chat / Media tools, health metrics beyond destination lights, keyboard shortcuts, transitions, audio mixer, screen share, backstage chat.

**Placeholder scan:** Shortcuts button is explicitly disabled with a title pointing at phase 5 — allowed. No `TODO` left in production paths for phase 1 features.

**Type consistency:** `Scene`, `SceneElement`, `People`, `FanZone`, `Output`, `Broadcast` as in `contracts.ts`. Tool names are a local union type in `ToolRail.tsx`.

---

## Execution handoff

Plan complete and saved at `docs/superpowers/plans/2026-10-14-kickstream-studio-rewrite.md`.

**Two execution options:**

1. **Subagent-driven (recommended)** — a fresh subagent per task, reviewed between tasks.
2. **Inline** — execute tasks in this session sequentially.

Which do you prefer?
