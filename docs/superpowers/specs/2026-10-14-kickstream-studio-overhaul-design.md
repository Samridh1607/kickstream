# Kickstream studio overhaul: a stage-first studio, real match data, brands and full stream management

## Goal

Make Kickstream a complete live-production tool, in the spirit of StreamYard, for football shows and
for people talking:

1. A **studio that is easy to use**: what goes out is large and central, every tool is one click away,
   nothing needs page scrolling on a laptop (1536 × 864), and every feature works end to end.
2. **Real match data**: real past matches with full detail (StatsBomb Open Data), and real live
   matches from free live-score services.
3. **More templates, with branding**: 12 new templates for speakers and matches, brand kits, three
   overlay styles, backgrounds, name tags and per-element style.
4. **Full stream management**: scheduling, destinations per broadcast, a go-live checklist, a rundown,
   stream health, transitions, keyboard shortcuts, an audio mixer with music, media and recordings
   libraries, screen sharing, backstage chat and post-broadcast analytics.

## Phases

One spec; built and merged in six phases, each with its own plan, a review after every task, and the
user's approval before it lands on `main`.

| Phase | Contents |
|---|---|
| 1 | The studio rewrite: the new layout, with every existing feature moved into it and checked end to end |
| 2 | Real match data: StatsBomb replays, API-Football and SportAPI.ai live |
| 3 | Brand kits, overlay styles, backgrounds, name tags, per-element style, 12 templates |
| 4 | Broadcast management: scheduling, destinations per broadcast, go-live checklist, rundown, analytics |
| 5 | Production tools: stream health, transitions, shortcuts, audio mixer and music, media and recordings libraries |
| 6 | Guests: screen sharing and backstage chat |

## Global constraints

- Secrets (`KICKSTREAM_ACS_CONNECTION_STRING`, `KICKSTREAM_API_FOOTBALL_KEY`, `KICKSTREAM_SPORTAPI_KEY`,
  stream keys) live only in the git-ignored root `.env` or `.data/`; they are never logged, printed,
  returned to a page, or shown in a `repr`.
- The studio has no sign-in. Studio routes stay local; on a public host only `/api/guest/*` answers,
  plus everything for a valid co-host cookie (the existing gate). New guest features (chat, screen
  sharing) go under `/api/guest/*`.
- The program page (the hidden capture browser) renders exactly what viewers see; anything that must be
  on the stream (transitions, music, credits) happens on the program page, not only in the studio.
- No test needs the internet or an API key. Network sources are tested with recorded sample responses;
  an opt-in network smoke test runs only when asked.
- Match the surrounding code: pure `rules.py`, `service.py` with revision and listeners, `api.py`
  routers, ports and adapters chosen in `app.py`, the architecture test's stages. UI text is English and
  in sentence case; comments only for constraints the code cannot show.
- Saved data from before each phase keeps loading.

---

## Phase 1: the studio rewrite

### What is rewritten and what is kept

- **Rewritten:** `studio/StudioPage.tsx` and `studio/panels.tsx` are replaced by a new studio made of
  small, focused components (one file per tool).
- **Kept:** the scene renderer (`SceneCanvas.tsx`, `elements.tsx`, `widgets.tsx`) and `ProgramPage.tsx`,
  because the program that is streamed uses them; the API clients; every pipeline route.

### Layout (live mode)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Top bar: broadcast · LIVE 00:42:10 · health · destination lights ·            │
│          Edit layout · Shortcuts · Go live / End broadcast                     │
├──────────────────────────────────────────────────────┬────────────────────────┤
│                                                      │ Rail │ Tool panel       │
│   Stage: the program, large (16:9, fits the space)   │ icons│ (one tool open)  │
│   transition and audio controls in its corner        │      │                  │
├──────────────────────────────────────────────────────┤      │                  │
│ Backstage: you and every guest as video tiles,       │      │                  │
│ Add to stage / Remove, + Invite                      │      │                  │
├──────────────────────────────────────────────────────┤      │                  │
│ Scene strip: live thumbnails, 1–9, + Scene           │      │                  │
└──────────────────────────────────────────────────────┴────────────────────────┘
```

- **Top bar** (`studio/TopBar.tsx`): breadcrumb and broadcast title, state (Ready / LIVE with an elapsed
  timer / Ended), recording badge, connection badge, Edit layout, Shortcuts, and the one primary action
  (Go live, or End broadcast while live) always in the same place. Health and destination lights are
  added in phase 5; until then the destination lights show today's per-destination status.
- **Stage** (`studio/Stage.tsx`): the on-air scene rendered with `SceneCanvas` and `withFallbacks`,
  scaled to fill the available width at 16:9. A red outline and a "Program" tag while live.
- **Backstage row** (`studio/Backstage.tsx`): the host tile (Join with camera / camera, mic and
  devices, Add me to stage) and one tile per present guest with role, presence, Add to stage / Remove
  from stage. Members show "Backstage only". An Invite tile opens the Guests tool. The People panel's
  logic moves here and into the Guests tool; the mute and current-call handling is extracted into one
  hook (`calls/useHostCall.ts`) used by both the studio and the guest page.
- **Scene strip** (`studio/SceneStrip.tsx`): one live thumbnail per scene (a small `SceneCanvas`),
  numbered 1–9, the on-air scene outlined in red. Click to switch. A menu on each thumbnail: Edit,
  Rename, Duplicate, Commentary (studio default / fan / analyst), Save as template, Delete (not the
  on-air scene). The last tile, **+ Scene**, opens a picker of templates (built-in and saved).
- **Tool rail** (`studio/ToolRail.tsx`): icon buttons with labels; one tool open at a time; the rail
  collapses to icons. Phase 1 tools (each the old panel, redesigned):
  - **Banners**: banner text, Show / Clear, saved banners, auto banners for goals and cards; **Ticker**
    below it.
  - **Comments**: today's Fans tab (comments, polls, Super Chats, spotlight).
  - **Guests**: invites (role, name, link, copy, revoke), presence, stage.
  - **Replays**: highlights list, replay, stop, banner from a narrative.
  - **Timer**: countdown to a time, break of N minutes, end.
  - **Stream**: quality, destinations (add, enable, delete), recording toggle, recordings list.
  - **Settings**: studio default commentary, language, auto start, auto half-time break.
  Later phases add Brand, Match, Rundown, Chat and Media.
- **Edit layout mode** (`studio/EditLayout.tsx`): a full-size editor that replaces the stage area while
  open (the stream keeps running; the scene strip stays, so the streamer can still switch). Left: element
  library and layers (show/hide, order, delete). Centre: the scene canvas, drag and resize, snapping to
  the canvas edges, centre lines and other elements. Right: the inspector for the selected element (its
  props, and, from phase 3, its style), or for the scene when nothing is selected (name, commentary;
  later background and transition). It can edit any scene, on air or not; the header says which.
- **Smaller windows**: below 1280 px wide the rail collapses to icons; below 1100 px the backstage row
  and the scene strip scroll horizontally. Nothing important is ever below the fold at 1536 × 864.
- Errors appear in one toast region at the top of the stage area, not as a full-width bar.

### End to end in phase 1

Every feature that exists before the rewrite is reachable in the new studio and has a Playwright test
that drives it in a real browser: switching scenes, creating / renaming / duplicating / deleting scenes,
saving and deleting templates, editing elements (add, move, resize, hide, reorder, delete, upload an
image), commentary per scene, banners (manual, auto), ticker, countdown and break, replays, comments and
polls, invites and the stage, quality and destinations, going live to a file destination and ending,
and settings. The existing e2e specs are updated to the new studio rather than deleted.

---

## Phase 2: real match data

### Match sources

A new port `MatchSource` (`ports/match_source.py`) with three kinds of adapter:

| Source | Adapter | How it works | Setup |
|---|---|---|---|
| Simulated | `simulator` (today's generator) | Generated match, deterministic by seed | none |
| StatsBomb replay | `adapters/statsbomb.py` | Real past matches with every event. Files are fetched from `raw.githubusercontent.com/statsbomb/open-data/master/data/` on first use and cached in `.data/statsbomb/`; converted to Kickstream events and played through the existing `Simulator` in match-time order at the chosen speed | none |
| API-Football live | `adapters/api_football.py` | Polls one fixture (`/fixtures?id=`, which returns events, line-ups and statistics in one call) every 60 s while live, less often before kick-off and at half-time; stops at full time. A daily request counter keeps within 100 a day and says so when the budget is spent | `KICKSTREAM_API_FOOTBALL_KEY` |
| SportAPI.ai live | `adapters/sportapi.py` | The same, every 30 s, within 2,000 a day | `KICKSTREAM_SPORTAPI_KEY` |

Live sources are offered only when their key is set. A `LiveMatch` runner publishes to the bus as
events arrive, replacing the simulator for that match; the `MatchController` starts and stops either
kind, and still announces an abandoned match.

### Data model changes

- `MatchEvent` gains `xg: number | null` (StatsBomb's own xG; analytics use it when present, the local
  model otherwise) and `located: boolean` (default `true`; live events have no position and are
  `false`, and every position-based analytic ignores them).
- `MatchStatus` gains `source: "simulated" | "statsbomb" | "live"`, `detail: "full" | "key_events"`,
  `credit: string | null` ("Data: StatsBomb" for StatsBomb), `competition: string | null`, and the state
  `pre_match`.
- Teams are no longer fixed: each match carries its own `home` and `away` `TeamSheet` (real names, a
  colour chosen from a palette when the source has none, and the players). `GET /api/teams` returns the
  current match's teams, or the default pair when no match has started.
- A `TeamSheet` gains `formation: string | null` and players gain `starting: boolean` and optional
  `grid` (a position on a formation grid when the source gives one), for the Line-ups element.

### Converting StatsBomb events

| StatsBomb | Kickstream |
|---|---|
| Half Start (period 1) | `kickoff` |
| Pass | `pass` (`completed` when there is no outcome) |
| Shot, outcome Goal | `shot` (outcome `goal`, `xg`) then `goal` |
| Shot, Saved / Off T / Blocked / Wayward | `shot` with `saved` / `off_target` / `blocked` |
| Goal Keeper, Shot Saved | `save` |
| Foul Committed | `foul` |
| Foul Committed / Bad Behaviour with a card | `yellow_card` / `red_card` (second yellow = red) |
| Pass with type Corner | `corner` |
| Substitution | `substitution` (`player_in_id`) |
| Half End period 1 / period 2 | `half_time` / `full_time` |

Positions go from StatsBomb's 120 × 80 pitch to 0–100, flipped so the home side always attacks the same
way as in the simulator. Carries and pressures are not separate Kickstream events but feed the pressure
model through the passes around them, as simulated passes do today. Extra time and shoot-outs end the
match at the end of extra time; shoot-outs are not replayed.

### Live limits

With `detail: "key_events"`, these elements say "Not available with live data" instead of showing
invented numbers: the pitch with pressure, the 3D pitch, momentum graphs and pressure-based predictions.
Score, events, team stats (from the source's statistics), the timeline, line-ups, narration, banners and
goal cuts all work.

### Studio: the Match tool

A **Match** tool in the rail: choose the source; for StatsBomb, browse competition → season → match
(with the score hidden until chosen, so replays are not spoiled) and set the speed (real time, 2×, 5×,
10×, 30×); for a live source, today's fixtures, filtered by competition, with their state; Start and
Stop. While a StatsBomb match plays, the program shows the credit in a corner.

Routes: `GET /api/sources` (which sources are available), `GET /api/sources/statsbomb/competitions`,
`GET /api/sources/statsbomb/competitions/{competition}/{season}/matches`,
`GET /api/sources/{live}/fixtures?date=`, and `POST /api/matches` gains
`{source, ref, speed}` (the simulated form `{seed, speed}` keeps working).

### Errors

Network failures, a refused key and a spent daily budget are reported in the Match tool with what to do;
a running live match keeps its last state and retries with backoff. Cached StatsBomb files make a match
replayable offline after its first download.

---

## Phase 3: brand, styles and templates

### Brand kits

A new `brand` package (`brand/rules.py`, `service.py`, `api.py`, `brands.json`):

```
BrandKit {
  id, name,
  colors: { primary, accent, text, background },      # hex
  font: "inter" | "roboto" | "montserrat" | "oswald" | "bebas" | "noto-devanagari",
  logo: { image_id | null, corner: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "none" },
  style: "classic" | "minimal" | "tv",
  background: { kind: "color" | "gradient" | "image", color, gradient: [from, to, angle], image_id },
  tiles: { shape: "rounded" | "square" | "circle", names: boolean, active_border: boolean }
}
Brands { revision, brands: BrandKit[] (max 20), default_id }
```

- A broadcast gains `brand_id` (null: the default kit). The studio and the program render with the
  current broadcast's kit. A built-in "Kickstream" kit reproduces today's look and cannot be deleted.
- Fonts are bundled with the web app (no network at render time), so the hidden browser renders them.
- The **Brand** tool in the rail: pick the broadcast's kit, edit kits (colours, font, logo, style,
  background, tiles), duplicate, delete.

### Styles and overrides

- The three overlay styles are theme sets for every element (corner radius, bars, gradients, weight,
  angled shapes for Sports TV), driven by CSS variables from the kit.
- A scene gains `background` (an override of the kit's background, or null) and, in phase 5,
  `transition`.
- Any element's props may hold `style: { color, background, opacity, radius, font_size }`; each is
  optional and overrides the kit. Edit layout's inspector edits them.
- An invite gains `title` (max 40 characters), shown in name tags with the guest's name.
- Saved templates keep the scene's background and every element's style.

### New elements

| Element | Shows |
|---|---|
| `lower_third` | A name and title bar; from a guest on stage or typed text |
| `lineups` | Both squads (starting XI and bench), and the formation grid when the data has one |
| `goal_card` | The latest goal: scorer, minute and new score, large |
| `socials` | Social handles and "Next stream" time, typed in the inspector |
| `logo` | The broadcast kit's logo |
| `screen` | (phase 6) a shared screen on stage |

The `cameras` element gains `layout: "grid" | "side" | "spotlight" | "pip" | "column"` and uses the kit's
tile settings.

### The 12 new templates

Speakers: **Solo**, **Side by side**, **Panel**, **Spotlight**, **Speaker and data**.
Matches: **Watch-along**, **Match with a corner camera**, **Line-ups**, **Half-time report**, **Goal**,
**Post-match analysis**, **Ending / BRB**. Each is defined in `studio/templates.py` like today's, on the
1920 × 1080 canvas, following the layouts approved in the design session (cameras, data and graphics
in the same places as those mock-ups). A new studio has today's five starting scenes; the rest are
offered under **+ Scene**.

### Cut to Goal

A studio setting, **Cut to the Goal scene on a goal** (off by default): on a goal, if a scene made from
the Goal template exists, the studio switches to it, starts the goal's replay, and after 12 seconds
switches back to the scene that was on air (unless the streamer switched in the meantime).

---

## Phase 4: broadcast management

- **Scheduling.** A broadcast gains `scheduled_at` (optional, in the future when set). Home shows an
  **Upcoming** list (soonest first) above recent broadcasts. Opening the studio of a scheduled broadcast
  that is not yet live sets the countdown to `scheduled_at` if no countdown is running.
- **Destinations per broadcast.** Destinations and their keys stay one shared, saved list. A broadcast
  gains `destination_ids`; new broadcasts tick every enabled destination. Going live with a broadcast
  sends only to its ticked destinations; the Stream tool shows the ticks.
- **Go-live checklist.** Go live opens a dialog that lists checks before anything starts.
  Blocking: no destination ticked; ffmpeg missing; a ticked destination with no key.
  Warnings (Go live anyway): recording off; you are on stage with your camera off; the scene on air is
  not one made from Starting soon or Solo; no match is running for a scene that shows
  match data. Checks come from one pure function so the dialog and tests agree.
- **Rundown.** A broadcast gains `rundown: [{ id, scene_id, minutes, note }]` (max 30) and
  `rundown_index`. The **Rundown** tool edits it (add, reorder, delete) and runs it: **Next** (and the
  N key) switches to the next step's scene; each step shows time used against time planned, turning
  amber when over.
- **Analytics.** Each broadcast session logs scene switches (`scenes: [{ scene_id, name, at }]`) and
  guests put on stage (`guests: [{ name, role, at }]`). The broadcast page shows time live, each
  destination's uptime and failures, time per scene, goals and key moments, reels made and guests who
  were on stage.

---

## Phase 5: production tools

- **Stream health.** The encoder reports progress (`-progress` with `-stats_period 1` on its error
  pipe): frame rate, dropped and duplicated frames, speed. Each sender already reports progress: its
  bitrate and speed are kept. `Output` gains `health: { status: "healthy" | "warning" | "poor",
  fps, dropped_frames, speed, destinations: { id: { kbps, speed } } }`, updated at most once a second.
  Warning when speed < 0.97 or frames are being dropped; poor when speed < 0.9 or a destination is
  retrying. Shown in the top bar and in detail in the Stream tool.
- **Transitions.** `StudioSettings.transition` and an optional per-scene `transition`
  (`{ kind: "cut" | "fade" | "slide" | "zoom", duration_ms: 300–1500 }`, applied when switching to that
  scene). The program page keeps the outgoing scene mounted for the transition and animates both; the
  studio's stage shows the same.
- **Keyboard shortcuts.** 1–9 switch to scenes 1–9; N next rundown step; B clear the banner; E toggle
  Edit layout; ? the shortcuts list. Never while typing in a field. Go live and End always ask first.
- **Audio mixer.** The studio document gains `audio: { voices: 0–150, music: 0–100, track_id | null,
  playing, loop }`. The program page applies them: the room's voices through a gain node into the
  program mix, and music from the media library through another. The **Audio** control on the stage
  opens the mixer: voices and music volume, play / pause / next / loop, your own mic, and **Mute** per
  guest (an Azure forced mute from the host's call; disabled with an explanation when you are not in
  the call). Per-guest volume is not offered: Azure delivers all voices as one mixed stream.
- **Media library.** `ImageStore` becomes a `MediaStore` (images: PNG, JPEG, WebP, GIF up to 8 MB;
  audio: MP3, OGG, WAV up to 30 MB; checked by content, not name) with a `media.json` index
  (`{ id, name, kind, size_bytes, added_at }`). The **Media** tool lists, uploads, renames and deletes;
  each item shows where it is used (scenes, kits, the mixer), and deleting a used item asks first.
  Existing images are indexed on first start.
- **Recordings library.** The Stream tool and each broadcast page list recordings with play (an in-page
  player served with range requests), download, rename (a display name; the file keeps its name) and
  delete (asks first; removes the file and every reference). Total size and free disk space are shown.

---

## Phase 6: guests

- **Screen sharing.** The host, Speakers and Co-hosts get **Share screen** (ACS screen sharing). A
  shared screen is its own backstage tile ("Sam's screen") and goes on stage like a camera; stage
  entries gain `kind: "camera" | "screen"`, and screens count toward the four places. A new `screen`
  element shows the first screen on stage, and a **Screen and speaker** template ships with it. The
  fake call adapter simulates a screen for tests.
- **Backstage chat.** People documents gain `chat: [{ id, from: "host" | invite_id, name, text, at }]`
  (last 200 kept, text up to 500 characters). The **Chat** tool in the studio and a chat panel on the
  guest page send through `POST /api/broadcasts/{id}/people/chat` and `POST /api/guest/{secret}/chat`,
  and receive over the existing sockets. Every role can chat, Members included. Chat is never on the
  stream and is deleted with the broadcast. Unread messages show a count on the rail.

---

## Testing

- **Pipeline**: rules are pure and unit tested; services with fakes; routes with the test client;
  StatsBomb conversion and both live adapters with recorded JSON fixtures under `tests/fixtures/`;
  the architecture test covers the new packages (`brand`, `media`, the match sources).
- **Web**: component tests for every tool, the top bar, stage, backstage, scene strip and Edit layout;
  the checklist and health thresholds as pure functions.
- **End to end** (Playwright, fake rooms, fake devices, simulated match unless the test is about a
  source): one spec per phase covering every feature listed in it, at 1536 × 864, plus a layout test
  that asserts the stage, backstage row, scene strip and rail are all in view without scrolling.
- **Opt-in network test**: `pnpm e2e:network` downloads one StatsBomb match and, when a key is set,
  lists today's fixtures from each live source.

## Out of scope

- Per-guest volume (not possible with ACS's mixed audio).
- Penalty shoot-out replays from StatsBomb.
- Paid data tiers, odds and betting data.
- Sign-in for the studio (it stays local; the tunnel exposes only guest routes).
