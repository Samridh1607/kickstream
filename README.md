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
