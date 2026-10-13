# Kickstream

Kickstream is live-streaming software for football, in the spirit of Streamlabs and StreamYard: create a broadcast, compose scenes, go live to YouTube, X, Facebook and Twitch at once, and let fans vote and ask questions. Every broadcast keeps its sessions, recording and stats, and AI agents turn its best moments into vertical reels. What it puts on screen comes from a match event stream turned into live intelligence, AI narratives and recaps. This repository runs one synthetic match locally through the full pipeline.

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
pnpm dev:web     # web app on http://127.0.0.1:5173
```

Open `http://127.0.0.1:5173`, the streaming home, press **Create a broadcast**, then **Start match** and **Go live**. A 90-minute match plays in about three minutes. On the **Match data** page (`/match`), add `?speed=120` to the URL to play it faster (1 to 600).

| Page | Use |
|---|---|
| `/` | Home: create a broadcast and go live or end it, where the stream is going and how each destination is doing, every saved broadcast, the fan page link, and a quick-start checklist |
| `/broadcasts/{id}` | One broadcast: its stats, recording player, key moments, sessions and reels |
| `/studio` | Build and switch scenes, see the program as it goes out, run banners, polls and questions, and manage the Output |
| `/match` | The match data: pitch, key moments, narratives and stats, in Fan or Analyst view |
| `/join` | The fan page to share with viewers |

Every streamer page has the same top bar. While the stream is on, its right side shows how long you have been live and the status of each destination. The sun and moon button switches between light and dark themes.

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

A streamer composes the picture at `/studio`, watches it in the studio's **Program** preview, and sends it out from the **Output** box (see Going live below).

| Address | Use |
|---|---|
| `http://127.0.0.1:5173/studio` | Arrange scenes on a 16:9 canvas, switch them, and control banners, the ticker, replays and countdowns |
| `http://127.0.0.1:5173/studio?output` | The scene that is on air, full window, with no controls. This is what Go live streams. To use another tool instead, such as an OBS browser source, point it here at 1920 × 1080 |

- **Scenes** are saved canvases. Five templates are built in: Starting soon, Live match, Analyst desk, Break and Full-time. Drag and resize elements, or select one and use the arrow keys (Shift with the arrow keys resizes). Press **Switch** on a scene to put it on air.
- **Fan and Analyst scenes:** each scene's commentary is Fan, Analyst, or the studio default (set it with the selector above the editor). Live match is a Fan scene and Analyst desk an Analyst scene, so switching between them while live changes the program's narration from the Commentator's to the Tactical Analyst's.
- **Banners** appear by themselves for goals and red cards. Any narration line can be sent to the banner from the Highlights tab, and the Banner tab takes your own text.
- **Replays** animate the 20 seconds of play before a key moment on the pitch.
- **Countdowns**: a start countdown starts the match and cuts to the Live scene at zero; a break cuts to the Break scene and returns to where you were.

Scenes, settings and uploaded images are kept in `.data/` (set `KICKSTREAM_DATA_DIR` to move it). The program uses the on-air scene's commentary, or the **Default commentary** and language from the studio's Settings tab.

## Going live

The studio's **Output** box sends the program to several platforms at once.

1. On the platform (YouTube Studio, X Media Studio, Facebook Live Producer, Twitch), create a live stream. It shows a server address and a stream key.
2. In the Output box, choose the platform and paste the key. YouTube, Facebook and Twitch addresses are filled in; X gives each account its own, so paste that too. **Record to file** needs neither and writes an MP4 to `.data/recordings/`, which is a good first test.
3. Press **Go live**, in the studio, or on the home page for the current broadcast. Each destination shows connecting, live, retrying or failed, in the Output box and in the top bar. One failing does not stop the others.

Kickstream opens the studio's clean output (`/studio?output`) in a hidden browser, encodes it once with ffmpeg, and copies that stream to every destination. It needs [ffmpeg](https://ffmpeg.org) and a Chromium-based browser (Microsoft Edge is used when present).

| Variable | Meaning |
|---|---|
| `KICKSTREAM_PROGRAM_URL` | Where the hidden browser opens the clean output (default `http://127.0.0.1:5173/studio?output`) |
| `KICKSTREAM_BROWSER` | Path to a Chromium-based browser, when Edge is not wanted or not found |
| `KICKSTREAM_FFMPEG` | Path to ffmpeg, when it is not on the `PATH` |

Stream keys are kept in `.data/output-keys.json` and are never sent back to a page. The studio has no sign-in, so anyone who can reach it can stream to your channels: keep the pipeline reachable from your machine only. The stream carries no sound yet. Do not run the pipeline with `--reload` when going live; on Windows it cannot start ffmpeg that way.

Pages follow live data over WebSockets, which the pipeline accepts only from pages on the host it was reached at. Behind a reverse proxy that rewrites the `Host` header, list the public hostnames in `KICKSTREAM_ALLOWED_HOSTS` (comma-separated, for example `kick.example,www.kick.example`).

## Broadcasts and reels

A broadcast is one show: a title, an optional description, and whether to record it. Create it on the home page, then press **Go live**. A broadcast that records turns on a file destination by itself, so it can go live with no platform set up. **End broadcast** stops the stream and saves what happened:

- **Sessions:** each time it was on air, and whether each destination got the stream. Going live again from the broadcast's page adds a session.
- **Recordings:** the MP4s written while it was live, playable and downloadable on its page.
- **Stats:** time on air, destinations reached, poll votes and fan questions, the score, and the key moments with their commentary.

Going live from the studio with no broadcast chosen still saves one, titled with the date and time. Broadcasts are kept in `.data/broadcasts.json`.

On an ended broadcast's page, **Generate reels** cuts up to four 15-second vertical clips (1080 × 1920) from the recording, around its goals, red cards and big chances, or spread through it when there were none. With a model configured, two Microsoft Agent Framework agents do the choosing: a Highlight Editor picks the moments and a Social Copywriter writes each reel's title, caption and hashtags. Without a model, or if they fail, templates do it. The agents never set the times: each clip starts 8 seconds before its moment. Each reel plays on the page, downloads as an MP4, and has a button that copies its post. Reels are kept in `.data/reels/`.

| Endpoint | Use |
|---|---|
| `GET /api/broadcasts`, `/api/broadcasts/socket` | Every broadcast, once or live |
| `POST /api/broadcasts` | Create one: `{"title", "description", "record"}` |
| `PUT`, `DELETE /api/broadcasts/{id}` | Edit or delete one |
| `POST /api/broadcasts/{id}/live`, `/end` | Go live with it, or end it |
| `POST /api/broadcasts/{id}/reels` | Generate reels from its recording |
| `GET /api/broadcasts/{id}/recordings/{file}`, `/reels/{reel}.mp4` | Its recordings and reels, with range requests for seeking |

## Audience

Viewers take part at `/join`, a phone-friendly page you share in your stream description. The home page shows its link with a copy button. The same panel is the **Join in** tab on the Match data page.

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
| `apps/web/` | The React and Fluent UI web app: home, broadcasts, studio, program, match data and fan page |
| `docs/superpowers/` | Design spec and implementation plan |

Stages talk only through the event bus and the contracts, and never import one another. Moving to Azure means adding adapters for the four ports (event bus, narrative writer, match store, broadcaster) and choosing them in `app.py`.

## Test it

```bash
pnpm test:api                         # pipeline unit and integration tests
pnpm test:web                         # web unit and component tests
(cd apps/web && pnpm e2e)             # home, broadcasts and reels, studio, output, match data and fan page, in a real browser
```

No test calls a live model.

The browser tests start their own pipeline (port 8010) and dev server (port 5183) with a fresh data directory, so they never touch a Kickstream you have running.

After changing `packages/contracts/kickstream.schema.json`, regenerate both sets of types:

```bash
(cd services/pipeline && uv run python -m kickstream.tools.gen_contracts)
(cd apps/web && pnpm gen:contracts)
```
