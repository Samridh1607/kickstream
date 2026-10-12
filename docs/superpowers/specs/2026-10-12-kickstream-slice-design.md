# Kickstream cycle 1: thin end-to-end slice

Status: awaiting review
Date: 2026-10-12

## Purpose

Kickstream is a submission for the Microsoft Premier League hackathon, targeting the Grand Prize and the Multi-Agent / Foundry category. It turns a synthetic football match event stream into live intelligence, AI narratives, recaps and personalized views, covering the required pipeline: Ingest → Interpret → Explain → Render → Personalize.

Cycle 1 delivers one match running through all five stages on a developer machine, with every feature present but shallow. Later cycles deepen each feature and move the system onto Azure.

## Constraints

- No Azure subscription is available yet. Everything runs locally, and each Azure service sits behind a port so the cloud adapter can be added without touching stage code.
- The language model is any OpenAI-compatible chat endpoint, set by three environment variables: `KICKSTREAM_LLM_BASE_URL`, `KICKSTREAM_LLM_MODEL` and `KICKSTREAM_LLM_API_KEY`. No provider is chosen yet. Until those are set, the system runs on scripted narratives. The design bounds model calls per match and never depends on the model being reachable. (GitHub Models, the original choice, was retired on 2026-07-30.)
- Toolchain on the build machine: Node 24, Python 3.13. No .NET.
- Clubs and players are fictional. No real club names, crests or player names are used.

## Decisions

| Topic | Decision |
|---|---|
| Live stream | A simulated event feed drawn as a pitch and timeline. No video. |
| Backend | Python 3.13, FastAPI, Microsoft Agent Framework |
| Frontend | Vite, React, TypeScript, Fluent UI v9 (`@fluentui/react-components`) |
| Languages | English, Spanish, Hindi |
| Modes | Fan, Analyst |
| Sign-in | None. Preferences are stored in the browser. |
| Matches | One at a time is exercised. All interfaces are keyed by `match_id`. |
| Delivery to browser | Server-Sent Events |

## Definition of done

A viewer opens the dashboard and starts a match. A seeded 90-minute match, compressed to about three minutes, plays to full time, and the viewer sees:

1. Events appear on the pitch as they happen.
2. Stats and the pressure map update live.
3. Each key moment gets a narrative explaining why it matters.
4. A recap appears at half-time and at full-time.
5. Switching Fan / Analyst mode or language changes the narratives shown, including those already in the feed.
6. Items about the viewer's favorite club or player are highlighted.
7. The overlay tab shows broadcast-ready JSON beside its rendered graphic.
8. The pipeline panel shows which stage and agent produced each item and the insights it cited.

The same run completes with no model endpoint configured, using scripted narratives.

## Architecture

```
simulator ──► EventBus ──► analytics ──► EventBus ──► narration ──► overlay ──► gateway ──SSE──► web
 Ingest                    Interpret                  Explain       Render      Personalize
```

Cycle 1 runs one Python process. Each stage is a separate module that communicates with the others only through the event bus and the shared contracts, and no stage imports another stage. This lets each stage become its own Container App in a later cycle.

### Ports

| Port | Responsibility | Cycle 1 adapter | Later adapter |
|---|---|---|---|
| `EventBus` | Publish and subscribe by topic, ordered per `match_id` | in-memory asyncio queues | Azure Event Hubs |
| `NarrativeWriter` | Write a key-moment narrative, write a recap, localize text | Agent Framework agents; scripted templates | Foundry-hosted agents |
| `MatchStore` | Append-only log of everything published for a match | in-memory | Fabric Eventhouse or Cosmos DB |
| `Broadcaster` | Fan a match's stream out to connected viewers | in-process SSE | Azure Web PubSub |

The model endpoint used by the agent adapter is configuration: base URL, model name and key. OpenAI, a local Ollama server and Azure OpenAI differ only in those values.

### Scale principle

Narratives are computed once per (key moment, mode, language) and broadcast to every viewer on that variant. Model cost and latency grow with the number of matches and variants (2 modes × 3 languages = 6), never with the number of viewers. Per-viewer personalization is a filter and a highlight flag applied at the gateway. The gateway keeps no match state of its own beyond what it reads from `MatchStore`, so it can be replicated.

## Stages

### 1. Ingest: `simulator`

Generates a full match from a seed and two team sheets. The same seed always produces the same match.

- Event types: `kickoff`, `pass`, `shot`, `goal`, `save`, `foul`, `yellow_card`, `red_card`, `corner`, `substitution`, `half_time`, `full_time`.
- Each event has an ID, match minute and second, team, player, pitch coordinates and type-specific fields (for example, shot outcome).
- Coordinates are 0–100 on both axes. The home team attacks toward x = 100 in both halves, so consumers never need to flip.
- A match clock releases events in match-time order at a playback speed set when the match starts. The default is 30×.

Publishes `MatchEvent` on topic `events`.

### 2. Interpret: `analytics`

Keeps per-match state by folding over events. The fold is a pure function of (state, event), which makes it testable without a clock or bus.

- **Stats:** possession share, shots, shots on target, pass accuracy, fouls, cards, and a simple expected-goals value per shot based on distance and angle.
- **Pressure grid:** the pitch divided into 6 × 4 zones. Each team's value in a zone rises with its events there and decays over match time.
- **Momentum:** a single signed value from recent pressure and shots, positive for the home team.
- **Key moments:** rule-based detection of `goal`, `red_card`, `big_chance` (shot above an xG threshold), `momentum_swing` (momentum changes sign by more than a threshold within a window) and `sustained_pressure` (one team holds high pressure in the attacking third for a set duration). Thresholds are configuration with defaults chosen so a typical seeded match yields 10 to 20 key moments.

Publishes `StatsSnapshot` and `PressureSnapshot` at most once per match minute, and `KeyMoment` when detected, on topic `insights`. Each key moment lists the stats that triggered it.

### 3. Explain: `narration`

Consumes key moments and the half-time and full-time events, and produces narratives through the `NarrativeWriter` port.

**Agent adapter.** A Microsoft Agent Framework workflow with four agents:

| Agent | Input | Output |
|---|---|---|
| Commentator | Key moment, match state | Fan-mode narrative in English: short, vivid, one or two sentences |
| Tactical Analyst | Key moment, triggering stats, match state | Analyst-mode narrative in English: what changed and why, citing the stats |
| Recap Writer | Full match state at half-time or full-time | A recap in English for each mode |
| Localizer | English narratives | Spanish and Hindi versions of both modes in one call |

A key moment costs three model calls: Commentator, Tactical Analyst, then Localizer. A recap costs two: Recap Writer, then Localizer.

**Scripted adapter.** Builds the same outputs from templates per key-moment type, mode and language, filled from the triggering stats. It needs no network.

**Choosing between them.** The narration stage wraps the agent adapter with three behaviors:

- **Budget:** a per-match cap on model calls and a minimum gap between them. When the budget is spent, remaining moments use the scripted adapter. Goals and recaps are served from the budget first.
- **Cache:** responses are stored on disk keyed by a hash of the model name and prompt. Replaying the same seeded match costs no model calls and gives the same text, which keeps demos repeatable.
- **Fallback:** on timeout, rate limit or malformed output, the scripted adapter writes that item.

Every narrative records `source` (`agent` or `scripted`), the agent that wrote it, and the IDs of the insights it was built from.

If a key moment is still waiting when a newer one arrives and the queue is full, the oldest waiting moment is written by the scripted adapter so narration stays current.

Publishes `Narrative` and `Recap` on topic `narratives`.

### 4. Render: `overlay`

Maps insights and narratives to overlay documents, the JSON a broadcast graphics system would consume.

| Overlay kind | Built from | Content |
|---|---|---|
| `lower_third` | Key moment + Fan narrative | Headline, sub-line, team, minute |
| `stat_card` | Stats snapshot | Up to four labelled home / away values |
| `pressure_map` | Pressure snapshot | Zone grid with values per team |
| `recap_card` | Recap | Title, score, three bullet points |

Each overlay carries its kind, language, a display duration and the IDs of its sources. Every overlay is validated against the schema before it is published. The web app's overlay tab renders from this JSON and from nothing else, so the JSON is proven sufficient to draw the graphic.

Publishes `Overlay` on topic `overlays`.

### 5. Personalize: `gateway`

The HTTP surface, and the only stage the browser talks to.

| Endpoint | Purpose |
|---|---|
| `GET /api/teams` | Team sheets, for the preferences drawer |
| `POST /api/matches` | Start a match with `{seed, speed}`. Returns `match_id`. Starting a new match ends the current one. |
| `GET /api/matches/{id}/stream` | SSE stream. Query: `mode`, `lang`, `club`, `player` |
| `GET /api/matches/{id}/overlays/latest` | Latest overlay of each kind, as JSON, for external consumers |

For each viewer the gateway:

- sends match events, stats and pressure unchanged;
- sends only the narrative, recap and overlay variants matching the viewer's mode and language;
- sets `highlighted: true` on items involving the viewer's favorite club or player.

Changing mode, language or favorites reconnects the stream with new parameters. On connect the gateway replays the match so far from `MatchStore` in the new variant, so the feed is complete and consistent after a switch. A reconnect after a dropped connection sends `Last-Event-ID` and receives only what it missed.

## Contracts

`packages/contracts` holds JSON Schema for `MatchEvent`, `StatsSnapshot`, `PressureSnapshot`, `KeyMoment`, `Narrative`, `Recap`, `Overlay`, `ViewerProfile`, `TeamSheet` and the stream envelope. Pydantic models and TypeScript types are generated from these schemas, and the generated files are checked by a test that fails when they are out of date.

The stream envelope is:

```json
{ "id": 412, "type": "narrative", "match_id": "m-1", "minute": 37, "highlighted": false, "payload": {} }
```

`id` increases by one per item in the match log. A viewer sees gaps where other variants were filtered out, and the IDs they do see are always increasing, which is all `Last-Event-ID` replay needs. `type` is one of `match_status`, `match_event`, `stats`, `pressure`, `key_moment`, `narrative`, `recap`, `overlay`.

## Web app

One page, built with Fluent UI v9 components and tokens, with light and dark themes following the system setting.

| Area | Content |
|---|---|
| Header | Scoreboard, match clock, Fan / Analyst switch, language picker, preferences button, start / restart match |
| Pitch | SVG pitch with recent event markers and a toggleable pressure heat layer |
| Timeline | Key moments along the 90 minutes; selecting one scrolls the feed to it |
| Narrative feed | Narratives newest first, with highlighted items accented and a badge for scripted ones |
| Stats panel | Home / away comparison bars and the momentum indicator |
| Preferences drawer | Favorite club, favorite player, language |
| Recap dialog | Opens at half-time and full-time; reopenable from the timeline |
| Overlay tab | Rendered overlay beside its JSON, with a copy button |
| Pipeline panel | For a selected item: the stage and agent that produced it, its source, and the insights it cited |

A single typed stream client owns the SSE connection and feeds one store. Components read from the store and do not open connections or fetch on their own. Interface text is localized in the same three languages as the narratives. Preferences persist in `localStorage`.

## Repository layout

```
apps/web/                     React + Fluent UI dashboard
services/pipeline/
  kickstream/
    ports/                    EventBus, NarrativeWriter, MatchStore, Broadcaster
    adapters/                 in-memory bus and store, SSE broadcaster, agent and scripted writers
    simulator/
    analytics/
    narration/
    overlay/
    gateway/
    app.py                    composition root: wires adapters to stages
  tests/
packages/contracts/           JSON Schema and code generation
docs/superpowers/specs/
```

`app.py` is the only place that names concrete adapters.

## Error handling

- **Model failure:** covered by the budget, cache and fallback in the narration stage. The stream never waits on a model call.
- **Invalid messages:** each stage validates what it consumes and what it publishes. An invalid message is logged with its topic and dropped.
- **Slow consumers:** bus queues are bounded. A viewer whose connection cannot keep up is disconnected and recovers through `Last-Event-ID` replay.
- **Dropped connections:** the browser reconnects automatically and shows a reconnecting state in the header until the stream resumes.
- **Unknown match ID:** the stream endpoint returns 404, and the web app offers to start a match.

## Testing

Development is test-first.

- **pytest:** simulator determinism, the analytics fold, each key-moment rule, overlay schema validity, the narration stage's budget, cache and fallback against a fake writer, the agent adapter against a fake model client, gateway variant selection, highlighting and replay.
- **Vitest and React Testing Library:** the stream store and each component against fixture streams.
- **Playwright:** one smoke test with no model endpoint configured. It starts the seeded match and asserts a goal narrative, a mode switch, a language switch and the full-time recap.
- **Contract test:** generated Python and TypeScript types match the schemas.

No test calls a live model.

## Out of scope

Azure deployment and infrastructure-as-code, Event Hubs, Fabric, Foundry-hosted agents, sign-in, video, concurrent matches under load, load testing, a fourth language, and pausing or seeking within a match.

## Later cycles

2. Azure adapters for the four ports, Foundry-hosted agents, Container Apps infrastructure.
3. Match history in Fabric and deeper recaps that draw on it.
4. Load testing, a fourth language and demo polish.
