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

## Audience

Viewers take part at `/join`, a phone-friendly page you share in your stream description. The same panel is the **Join in** tab on the dashboard.

| Page | Use |
|---|---|
| `http://127.0.0.1:5173/join` | Fans vote in the current poll, ask a question, and upvote other fans' questions |
| `/studio`, **Audience** tab | Start and close polls, put results on the program, moderate questions, and answer one |

- **Polls:** type a question and 2 to 6 options, or use a preset built from the match. Fans see results after they vote. Results reach the program only when you switch **Show poll on the program** on.
- **AskExpert:** press **Ask the expert** on a fan question. With a model configured, a fifth agent, the Match Expert, drafts an answer from the live match data. You can edit it, or write your own; nothing airs until you press **Put on air**. Without a model you write the answer yourself.
- **On the program:** add `poll` and `qa` elements to a scene to choose where they appear. A scene without them shows each in a default box while it is on air.

Votes are counted once per browser, using a random ID the browser keeps. That stops accidental double votes, not deliberate ones.

**Before sharing `/join` on a public address:** Kickstream has no sign-in, so anyone who can reach the server can also reach the studio's routes. Put the studio behind protection first, for example by exposing only `/join`, `/api/audience` and the match routes through a reverse proxy.

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
(cd apps/web && pnpm e2e)             # the dashboard, the studio and the fan page, in a real browser
```

No test calls a live model.

The browser tests start their own pipeline (port 8010) and dev server (port 5183) with a fresh data directory, so they never touch a Kickstream you have running.

After changing `packages/contracts/kickstream.schema.json`, regenerate both sets of types:

```bash
(cd services/pipeline && uv run python -m kickstream.tools.gen_contracts)
(cd apps/web && pnpm gen:contracts)
```
