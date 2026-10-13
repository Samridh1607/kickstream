# Kickstream match agents, live scene widgets and the fan zone

Status: built. Written under a standing goal, without a review pause; the assumptions are listed so they can be corrected.
Date: 2026-10-13
Builds on: the slice, studio, output, broadcasts and guests specs.

## Purpose

Three things, asked for together:

1. **Match data, redesigned around agents.** Seven named agents turn the match feed into structured
   events, tactics, predictions, explanations, 3D pitch data, player metrics and highlights. The match
   data endpoint and the `/match` page are rebuilt around them, in the manner of Copilot Studio: each
   agent is declared (instructions, triggers, tools, connected agents), listed, inspectable and
   switchable, with a live activity trace.
2. **Live scene widgets.** While on air, the streamer adds a score card, charts, graphs, predictions,
   comments and more to a scene with one click.
3. **A fan zone.** Comments from platforms such as X, a quick summary of the chat, polls, superchats
   that show the supporter's name, custom messages, and quick actions such as picking a winner.

Everything that appears or changes on the program animates smoothly.

## What the user said, and what is assumed

Said: the seven agents and their jobs; a Copilot Studio-like interface and way of building; live-added
charts, score card, graphs, predictions and comments in a scene; fan data from platforms like X, liked
comments, a quick summary, good-looking polls, superchats with the name shown, custom messages, a
winner quick action; smooth animation throughout.

Assumed:

- **There is no video in this repository.** The synthetic event feed stands in for video detections.
  The Event Interpreter consumes that feed; a real detector would publish to the same `events` topic.
- **Player positions are estimated.** The feed carries the ball and the player on it, not 22 tracked
  players. The Visualization Agent places the others from the formation and the ball, and says so.
- **Kickstream takes no money.** Fans pay on the platform (a Super Chat, bits). A superchat reaches
  Kickstream through a feed or the ingest route, or the streamer types it in. Nothing here charges a card.
- **The fan zone is the streamer's tool, not a public page.** The `/join` fan page was removed on
  purpose (guests spec). Fans stay on the platforms; their comments come in through a feed.
- **X needs the streamer's own API access.** With `KICKSTREAM_X_BEARER_TOKEN` set, the X adapter reads
  recent posts matching `KICKSTREAM_X_QUERY`. Without it, a clearly labelled **demo feed** supplies
  made-up comments from made-up accounts, as the synthetic match supplies a made-up game.
- **Agent text is English.** Enumerated labels are translated in the web app as before; the sentences
  an agent writes (explanations, highlight titles, the tactical summary) are not localized in this cycle.
- **Rendering is CSS 3D,** not a WebGL engine: no new web dependency.

## Constraints kept

Stages talk through the bus and the contracts and never import one another; adapters are named only in
`app.py`; message shapes live in the shared schema; no test calls a live model or a live platform;
fan text is untrusted and shown as plain text only.

## 1. The agents

A new stage, `kickstream/agents/`. Each agent is one module with a declared **spec** and a `handle`
function; a registry lists them and an orchestrator routes bus messages to the agents whose triggers
match, in dependency order, and publishes what they return on a new `agents` topic.

| Agent | Triggers | Produces |
|---|---|---|
| Event Interpreter | each match event | `PlayEvent`: zone, lane, phase of play, possession sequence, danger |
| Tactical Analyst | play events, once a match minute | `TacticalInsight`: per team pressure, tempo, field tilt, lane shares, patterns; the match rhythm |
| Prediction Agent | play events and stats, once a minute | `Prediction`: win, draw and loss, next goal within ten minutes, the likely next action, a danger grid |
| Explainability Agent | a tactical insight that changed, a prediction that moved, a highlight | `Explanation`, in Fan and Analyst wording: a headline, why it matters, the evidence |
| Visualization Agent | each play event | `PitchScene`: ball with height, its trail, estimated players, danger columns, pass lanes, a camera hint |
| Player Tracking Agent | play events, once a minute | `PlayerReport`: every player's touches, passes, accuracy, shots, xG, goals, fouls, cards, rating, heat |
| Highlights Agent | key moments and play events | `Highlight`: key moments ranked, and hidden events: long passing moves, big saves, dangerous turnovers, tactical fouls, unsung players |

Each agent also reports an `AgentRun` (agent, trigger, what it produced, how long it took), at most one
per agent per match minute, so the trace stays readable.

The agents compute; only the Explainability Agent writes prose. It follows the narration pattern: a
scripted explainer always works, and with a model configured an Agent Framework explainer writes
instead, within a per-match call limit, falling back to the script on any failure.

Agents can be switched off. A switched-off agent produces nothing, so the agents after it go quiet too.
The switches are kept in `.data/agents.json`.

### Endpoint

| Route | Use |
|---|---|
| `GET /api/agents` | The catalogue: each agent's name, description, instructions, triggers, tools, outputs, connected agents, and whether it is on |
| `PUT /api/agents/{id}` | `{enabled}`: switch one on or off |
| `GET /api/matches/{id}/intelligence` | The latest output of every agent for the match in one document; `?player=` picks the tracked player, `?mode=` the wording |
| `GET /api/matches/{id}/stream`, `/socket` | As before, now also carrying `play`, `tactics`, `prediction`, `explanation`, `pitch_scene`, `players`, `highlight` and `agent_run` |

Explanations carry a mode, so the existing personalization sends each viewer one wording.

### The page

`/match` becomes **Match intelligence**. A left rail lists Overview, the seven agents with a live state
dot, then the classic dashboard and the overlay JSON, which keep everything the old page did. Overview
shows the agent flow (nodes joined by edges that pulse as data moves) above live cards: the 3D pitch,
predictions, tactics, the tracked player, highlights and explanations. An agent's own page shows its
details, instructions, triggers, tools and connected agents, its live output, its runs and its switch.
A right-hand Activity pane is the trace.

## 2. Live scene widgets

Eleven new element types: `scorecard`, `chart` (the two teams compared), `graph` (momentum, expected
goals or win probability over time), `prediction`, `insight` (the latest explanation), `pitch3d`,
`player` (the tracked player's card), `comments`, `poll`, `superchat` and `spotlight`.

The Elements tab gains a **widget gallery**: one click adds a widget to the scene being edited at a
sensible size and place, and the scene on air updates at once. Elements fade and rise in, fade out when
removed, and glide when moved or resized. Numbers count, bars and lines ease.

A spotlight or a poll that is put on air appears even when the scene has no element for it, as a
replay already does.

## 3. The fan zone

A new stage, `kickstream/fans/`, holding one **fan zone** document, live like the studio's.

- **Comments.** Up to 200 recent comments, each with its platform, author, text and likes. The streamer
  *likes* a comment to keep it featured, or puts it on the spotlight.
- **Summary.** Comments a minute, the mood (positive, neutral, negative), the topics most mentioned,
  the share of each platform, and one sentence saying so. Computed from the comments; no model.
- **Polls.** One at a time, two to six options, timed or closed by hand. Fans vote by commenting the
  option's number; one vote per account, the last one counting. Results animate. The streamer puts the
  poll on air and takes it off.
- **Superchats.** Name, amount, currency and message, coloured by size. The streamer thanks one on the
  spotlight; with *Show superchats automatically* on, each new one goes there by itself.
- **Spotlight.** One thing on air at a time, with a queue: a comment, a superchat, a custom message, or
  a winner.
- **Quick actions.** Custom message; pick a winner from the commenters, the poll's voters or the
  supporters; announce the poll's result; clear.

Sources are behind a `SocialFeed` port: the demo feed, the X adapter, and `POST /api/fans/ingest` for a
bridge from any other platform. The document is kept in `.data/fans.json`.

| Route | Use |
|---|---|
| `GET /api/fans`, `/stream`, `/socket` | The fan zone, once or live |
| `PUT /api/fans/settings` | `{source, auto_superchat}` |
| `POST /api/fans/comments/{id}/like`, `/spotlight` | Feature a comment, or put it on air |
| `POST /api/fans/poll`, `/poll/close`, `/poll/announce`, `PUT /api/fans/poll/air`, `DELETE /api/fans/poll` | Run a poll, and put its result on air |
| `POST /api/fans/superchats`, `/superchats/{id}/spotlight` | Add one by hand; thank one on air |
| `POST /api/fans/spotlight`, `DELETE /api/fans/spotlight` | A custom message; clear what is on air |
| `POST /api/fans/winner` | `{pool}`: pick a winner and put the name on air |
| `POST /api/fans/ingest` | Comments and superchats from a bridge |
| `DELETE /api/fans` | Clear comments, polls and superchats |

In the studio, a **Fans** tab holds all of this.

## 4. Ask Copilot (added on request after the first three parts)

A chat pane, opened from the top bar of every streamer page, that answers questions about the match,
a player's record, the head to head, a play card and the play history, with web search.

A new stage, `kickstream/copilot/`. A question is placed by the words in it and the players it names,
then answered from the match log and from an archive of finished matches (`.data/matches.json`), which
a small stage fills at each final whistle. The answer is text plus up to three cards (facts, a
side-by-side comparison, a list of moments) and suggested next questions.

Assumed:

- **The record is local.** The clubs are fictional, so "record" and "head to head" mean the matches
  finished on this installation. There is no outside history to draw on.
- **Web search is opt-in per conversation and used only when the match cannot answer.** It sends the
  question to a third party, and results for a match question would be about anything but this match.
  Wikipedia by default (no key); Tavily when a key is set.
- **A model only words the answer.** The facts and the cards are computed; the model is told to use
  nothing else and to treat the question and the web results as material, never as instructions.
- English only; the conversation lives in the page, not on the server.

## Found while building

- The agents roughly quadruple the messages a match sends. A page that drew once per message fell
  seconds behind, so pages now gather messages for 30 ms and draw them together, and a page joining
  late is replayed only the newest pitch scene and player report.
- New superchats do not go on air by themselves unless the streamer turns that on: with the demo feed
  as the default source, the other default would put made-up supporters on a real stream.
- The Prediction Agent gives the odds of each next action (pass, shot, losing the ball) rather than
  one "most likely" action, which would nearly always be a pass.

## Testing

Rules for agents and the fan zone are pure functions with unit tests. The orchestrator, the services
and the routes have integration tests over the in-memory bus and fake feeds. The web reducers,
elements and panels have component tests. The existing suites stay green. The X adapter is tested
against a recorded response shape only; it has not been run against X.

## Out of scope

Real video detection; real player tracking; payments; a public fan page; localized agent prose;
YouTube, Twitch and Facebook chat adapters (the ingest route is their way in).
