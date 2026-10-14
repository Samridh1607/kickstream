# Kickstream

Kickstream is live-streaming software for football, in the spirit of Streamlabs and StreamYard: create a broadcast, compose scenes, go live to YouTube, X, Facebook and Twitch at once. Every broadcast keeps its sessions, recording and stats, and AI agents turn its best moments into vertical reels. What it puts on screen comes from a match event stream turned into live intelligence, AI narratives and recaps. This repository runs a synthetic match, or a real one from free match data, locally through the full pipeline.

```
simulator ──► analytics ──► narration ──► overlay ──► gateway ──SSE──► web
 Ingest       Interpret     Explain       Render      Personalize
     └──────► agents ─────────────────────────────────────┘
              seven match agents
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
| `/` | Home: create a broadcast and go live or end it, where the stream is going and how each destination is doing, every saved broadcast, and a quick-start checklist |
| `/broadcasts/{id}` | One broadcast: its stats, recording player, key moments, sessions and reels |
| `/broadcasts/{id}/studio` | That broadcast's studio: build and switch scenes, see the program as it goes out, run banners, and go live with it |
| `/studio` | Opens the studio of the broadcast on air, or else of the current one; with neither, asks you to choose or create one |
| `/match` | Match intelligence: the seven match agents and what each has found, with the match dashboard and overlay JSON as two of its views |
| `/guest/{secret}` | A guest's page, opened from an invite link: check the camera and microphone, give a name, and join |

Every streamer page has the same top bar. While the stream is on, its right side shows how long you have been live and the status of each destination. The sun and moon button switches between light and dark themes.

## Real match data

Instead of the simulated match, you can play a real one from three free sources. Choose it in the studio's **Match** tool, or with **Choose match** on the **Match data** page.

| Source | Kind | What it gives | Key | Free limits | Credit |
|---|---|---|---|---|---|
| [StatsBomb Open Data](https://github.com/hudl/open-data) | Replay | Past matches with every event, its position on the pitch, and StatsBomb's own xG | None | Files come from GitHub, which allows about 5,000 requests an hour from one address. Free for non-commercial use with attribution | StatsBomb's logo and "Data: StatsBomb" |
| [API-Football](https://www.api-football.com) | Live | Fixtures worldwide: score, goals, cards, substitutions, line-ups and team stats | Free key | 100 requests a day and 10 a minute | "Data: API-Football" |
| [OpenLigaDB](https://www.openligadb.de) | Live | Scores and scorers for the leagues you list | None | No documented limit. Data under the ODbL licence | "Data: OpenLigaDB" |

- **StatsBomb** files are downloaded on first use into `.data/statsbomb/`, so a match played once replays offline. The first start of a match waits a few seconds for the download. The match list never shows a score, so a replay is not spoiled. StatsBomb's [licence](https://github.com/hudl/open-data/blob/master/LICENSE.pdf) allows non-commercial use with attribution and asks for their logo, which is why the program shows it in a corner while a StatsBomb match plays.
- **API-Football** is polled every 90 seconds while a match is live (every 5 minutes at half-time, every 10 before kick-off and every 2 in the last 15 minutes before it). That is about 80 requests for one match, fixture lists included. Every request is counted; the Match tool shows the day's count, kept in `.data/api-football-budget.json`, which resets at midnight UTC and follows API-Football's own count, so other programs using the same key spend the same 100. When the day's requests are spent, the match keeps its last state and resumes after midnight UTC. The free plan does not cover every season; when it refuses a match, the Match tool shows API-Football's own message and what to do.
- **OpenLigaDB** is entered by its community, so goals can arrive late or be corrected. It has no live clock, so the minute and half-time are estimated from the kick-off time. It is polled every 60 seconds while live. The leagues offered are the Premier League, LaLiga and the Champions League (`pl,la1,ucl`); set `KICKSTREAM_OPENLIGADB_LEAGUES` to OpenLigaDB league shortcuts to change them, for example `bl1` for the Bundesliga.

To get and set the API-Football key:

1. Register at [dashboard.api-football.com/register](https://dashboard.api-football.com/register).
2. Copy the key from the dashboard.
3. Add it to the `.env` file at the top of the project (it is ignored by git; never commit it):

       KICKSTREAM_API_FOOTBALL_KEY=<key>

4. Restart the pipeline. API-Football then becomes available in the Match tool; until then it shows these steps.

In the **Match** tool, choose a source. For StatsBomb, choose a competition and season, then a match; for a live source, today's fixtures are listed with their state, and can be filtered by competition. The simulated match plays at 30× by default and StatsBomb replays in real time; both can be played at real time, 2×, 5×, 10× or 30×. Live matches play as they happen. **Start** plays the match now and **Stop match** ends it. A failed start leaves the match that is playing as it was and shows the source's message.

Whatever you choose is also the **next match**: when a studio countdown ends, it starts, as long as automatic start is on in Settings. The tool shows it under **Starts when the countdown ends**, with **Clear**. With no choice, the simulated match starts as before. If the chosen match cannot start then, the simulated match plays instead and the studio shows why. On the **Match data** page, the header shows the competition and the credit, and the **Choose match** dialog is translated like the rest of the page.

**Live data has key events only.** API-Football and OpenLigaDB send the score, goals, cards and substitutions, and API-Football some team stats, but no ball positions. With live data, the score, timeline, events, stats the source measured, narration and banners work as usual; what would need positions shows **Not available with live data** instead of invented numbers:

- On scenes: the pitch, the 3D pitch, replays, the momentum and xG graphs, the next-action prediction and the tactics chart.
- On the **Match data** page: the pitch with its pressure map, the 3D pitch, the tactics card and where the danger has come from. The Tactical Analyst and the Visualization Agent sit out.
- **Ask Copilot** quotes only the stats the source measured, and a tactics or pitch question is answered by saying the feed has no positions.

| Variable | Meaning |
|---|---|
| `KICKSTREAM_API_FOOTBALL_KEY` | Your API-Football key, in `.env` |
| `KICKSTREAM_OPENLIGADB_LEAGUES` | OpenLigaDB league shortcuts, comma-separated (default `pl,la1,ucl`) |
| `KICKSTREAM_STATSBOMB_URL`, `KICKSTREAM_API_FOOTBALL_URL`, `KICKSTREAM_OPENLIGADB_URL` | For tests only: where each source is read from |
| `KICKSTREAM_LIVE_POLL_S` | For tests only: poll live sources every N seconds instead of their schedule |

| Endpoint | Use |
|---|---|
| `GET /api/sources` | Every source, whether it is available (and if not, how to set it up), API-Football's count for the day, and the match playing now |
| `GET /api/sources/{source}/competitions` | A replay source's competitions and seasons |
| `GET /api/sources/{source}/competitions/{competition_id}/{season_id}/matches` | That season's matches, without scores |
| `GET /api/sources/{source}/fixtures?date=` | A live source's fixtures for a day (`YYYY-MM-DD`; default today) |
| `POST /api/matches` | `{source, seed?, ref?, speed}`: start a match. `ref` is `competition/season/match` for StatsBomb and the fixture id for a live source; `seed` is for the simulated match only |
| `POST /api/matches/stop` | Stop the match that is playing |
| `PUT /api/studio/queued-match` | `{source, ref?, speed, title?}`: the match the countdown starts; `null` clears it |

## AI narratives

With no configuration, narratives come from templates and are marked **Scripted**. To have the agents write them, point Kickstream at any OpenAI-compatible Chat Completions endpoint before starting the pipeline:

| Variable | Meaning |
|---|---|
| `KICKSTREAM_LLM_BASE_URL` | Endpoint base URL, ending in `/v1` |
| `KICKSTREAM_LLM_MODEL` | Model or deployment name |
| `KICKSTREAM_LLM_API_KEY` | API key |
| `KICKSTREAM_LLM_MAX_CALLS` | Model calls allowed per match (default 60) |
| `KICKSTREAM_CACHE_DIR` | Where agent output is cached (default `.cache/narration`) |

Four Microsoft Agent Framework agents do the writing: a Commentator and a Tactical Analyst work on each key moment concurrently, a Recap Writer covers half-time and full-time, and a Localizer translates into Spanish and Hindi. Each item is written once per mode and language and sent to every viewer on that variant, so model cost does not grow with the number of viewers. Output is cached, so replaying the same match costs no model calls. If the model is slow, rate-limited or returns something unusable, that item falls back to a template.

## Studio

The pages follow one path: **Home › Broadcast › Studio**. The studio always works on a broadcast. Open it with **Open studio** on Home or on a broadcast's page; its top bar names the broadcast and links back to it and to Home. Opening a broadcast's studio makes it the current broadcast, so **Go live** there goes live with it. An ended broadcast's studio cannot go live; create a new broadcast instead. Scenes are one library shared by every broadcast, so a layout built once is ready for the next show.

The studio is laid out around the picture, as in StreamYard: what goes out is always the biggest thing on the screen.

| Area | What it holds |
|---|---|
| **Top bar** | The broadcast's name, the output state (Off air, Connecting, LIVE with the elapsed time), the scene on air, **Edit layout**, Ask Copilot, and the one **Go live** / **End broadcast** button |
| **Stage** | The program exactly as viewers see it, scaled to fit, marked **Program · LIVE** while streaming |
| **Backstage** | You and your guests as tiles: **Join with camera**, **Add to stage** or **Backstage only**, mute, and **Invite a guest** |
| **Scenes** | A strip of live thumbnails under the stage. Click one, or press 1 to 9, to put it on air; its menu edits, renames, duplicates, saves as a template, deletes or sets its commentary. **Add scene** starts from a template or a saved one |
| **Tools** | A rail on the right; one tool opens at a time beside the stage: **Match** (what plays; see Real match data), **Banners**, **Comments** (the fan zone), **Guests** (invites), **Replays**, **Timer** (countdowns), **Stream** (destinations and quality) and **Settings** |

| Address | Use |
|---|---|
| `http://127.0.0.1:5173/broadcasts/{id}/studio` | The studio for that broadcast |
| `http://127.0.0.1:5173/studio?output` | The scene that is on air, full window, with no controls. This is what Go live streams. To use another tool instead, such as an OBS browser source, point it here at 1920 × 1080 |

- **Edit layout** swaps the stage for the scene's 16:9 canvas with an element library on the left and **Layers** and an **Inspector** on the right. Drag and resize elements; they snap to the canvas centre and edges and to each other. Arrow keys move the selection (Shift resizes). The scene strip stays in view, so you can switch which scene you are editing.
- **Templates** built in: Starting soon, Live match, Analyst desk, Break, Full-time, Interview, Match intelligence, Fan zone and 3D pitch.
- **Fan and Analyst scenes:** each scene's commentary is Fan, Analyst, or the studio default (from the scene's menu). Live match is a Fan scene and Analyst desk an Analyst scene, so switching between them while live changes the program's narration from the Commentator's to the Tactical Analyst's.
- **Banners** appear by themselves for goals and red cards. Any narration line can be sent to the banner, and the Banners tool takes your own text and the ticker.
- **Replays** animate the 20 seconds of play before a key moment on the pitch.
- **Timer**: a start countdown starts the match chosen in the Match tool (else the simulated one) and cuts to the Live scene at zero; a break cuts to the Break scene and returns to where you were.
- **Widgets**: the element library adds a score card, chart, graph, prediction, "why it matters" card, 3D pitch, player card, comments, poll, superchats or spotlight. Added to the scene on air, it appears on the program at once. Select a widget to choose what it shows in the Inspector.
- **Motion**: an element fades and rises in, fades out when removed, and glides when moved or resized; numbers count and bars ease to each new value. With the operating system's *reduce motion* setting on, they change at once.

Scenes, settings and uploaded images are kept in `.data/` (set `KICKSTREAM_DATA_DIR` to move it). The program uses the on-air scene's commentary, or the **Default commentary** and language from the Settings tool.

The **Match data** page (`/match`) is for analysts: its narration and agent output are always in the Analyst wording.

## Match agents

Seven agents work on every match. Each is declared the way a Copilot Studio agent is, with instructions, triggers, tools and the agents it is connected to, and the `/match` page shows each one that way, with its live output and its runs.

| Agent | What it does |
|---|---|
| Event Interpreter | Converts each detection into a structured event: third, flank, phase of play, possession sequence and danger |
| Tactical Analyst | Once a match minute: each side's pressure, tempo, field tilt and patterns (high press, wing overload, counter-attack and others), and the rhythm of the game |
| Prediction Agent | Once a minute: win, draw and loss, each side's chance of scoring in the next ten minutes, what the side on the ball does next, and a danger grid |
| Explainability Agent | Writes "why this matters", in Fan and Analyst wording, when the patterns change, the odds move by 12 points or a hidden event is found |
| Visualization Agent | The data for the 3D pitch: the ball's flight, the players, danger columns, pass lanes and a camera hint |
| Player Tracking Agent | Every player's touches, passing, shots, expected goals, rating and heat map; the page and the player card follow the one you choose |
| Highlights Agent | Ranks the key moments, and finds hidden events: long passing moves, good saves, balls won high, tactical fouls and unsung players |

Three things to know:

- **There is no video here.** The synthetic match feed stands in for a detector's output. A real detector would publish to the same `events` topic.
- **Only the ball and the player on it are known positions.** The Visualization Agent places the other players from the formation and the ball, and the 3D pitch draws them dashed and says so.
- **The agents compute; one writes.** Only the Explainability Agent produces prose. Without a model it writes from templates. With the `KICKSTREAM_LLM_*` variables set, a Microsoft Agent Framework agent writes instead, for at most 20 explanations a match, falling back to the templates on any failure. Its text is English only.

Any agent can be switched off on its page; the agents that listen to it then have less to work on. The switches are kept in `.data/agents.json`.

| Endpoint | Use |
|---|---|
| `GET /api/agents` | The catalogue: each agent's instructions, triggers, tools, outputs, connections and whether it is on |
| `PUT /api/agents/{id}` | `{enabled}`: switch one on or off |
| `GET /api/matches/{id}/intelligence` | The latest output of every agent in one document; `?mode=analyst` for the analyst wording, `?player=` for the tracked player |
| `GET /api/matches/{id}/stream`, `/socket` | The match stream, which also carries `play`, `tactics`, `prediction`, `explanation`, `pitch_scene`, `players`, `highlight` and `agent_run`. A page that joins late is replayed only the newest pitch scene and player report |

## Ask Copilot

The **Ask Copilot** button in the top bar of every streamer page opens a chat pane. It answers from the match being played and from the finished matches Kickstream has seen, and shows what it found as cards.

| Ask about | For example | It answers from |
|---|---|---|
| The match | "What is the score?", "Who will win from here?", "What are the tactics?" | The score and stats, the Prediction Agent and the Tactical Analyst |
| A player's record | "Tell me about Bellweather", "Who is the best player so far?", "Who scored?" | The Player Tracking Agent, and the player's totals over earlier matches |
| Head to head | "Show me the head to head", "Compare Bellweather and Marrowby", "Compare the two best players" | Wins and results on record with today's numbers, or two players side by side |
| A play card | "Show the last goal's play card", "Show a hidden highlight" | The Highlights Agent's pick, its commentary and the touches that led to it |
| Play history | "Show the play history", "Bellweather play history", "What were the previous results?" | The match's key moments, one player's plays, or the results on record |

- **The record is what Kickstream has seen.** The two clubs are fictional, so a head to head or a player's record counts the matches finished on this installation, kept in `.data/matches.json` (the newest 50). Before the first one finishes, it says there is nothing on record.
- **Web search** is a switch under the question box, off until you turn it on. It is used only for a question the match cannot answer, and it sends that question to the search service. The default is Wikipedia, which needs no key; with `KICKSTREAM_TAVILY_API_KEY` set, Tavily searches the whole web instead. `KICKSTREAM_WEB_SEARCH=off` turns it off. The Tavily adapter is tested against its documented response shape and has not been run against Tavily itself.
- **Wording**: without a model, answers are assembled from the recorded numbers. With the `KICKSTREAM_LLM_*` variables set, a Microsoft Agent Framework agent words each answer from those same facts and the web results, for at most 40 answers a match, falling back to the assembled answer on any failure. The cards never come from the model.
- **Ask one agent**: type `@` (or press **Tag an agent**) and pick one of the seven agents, or type a tag such as `@tactics`, `@prediction`, `@highlights` or `@TacticalAnalyst`. The question goes to that agent's part of the match: the latest plays, the tactics, the forecast, why something matters, where play is happening, a player, or the highlights. The reply says **Answered by** that agent.
- **Answers** are written in Markdown (headings, lists, tables) with charts: the two sides' numbers as bars, the forecast as a donut, where play happens by thirds.
- **When Ask Copilot cannot be reached**, the pane shows a sample answer of the same kind, marked **Sample — not live data**, with the reason, so the layout of an answer can still be seen. Its numbers are made up.
- Answers are in English. The conversation is kept while the page is open.

| Endpoint | Use |
|---|---|
| `GET /api/copilot` | Whether a model words the answers, which search service is used, and how many matches are on record |
| `POST /api/copilot/ask` | `{question, mode?, web?, match_id?, agent?}`: the answer, its cards and charts, any web sources, which agent answered and questions to ask next. Without `match_id` it answers about the current match |

## Fan zone

The studio's **Comments** tool is where the audience comes in. Fans stay on the platforms; their comments reach Kickstream through a source.

- **Comments**: the newest 200, each with its platform. **Like** one to keep it and mark it on screen, or put it on the spotlight.
- **Quick summary**: comments a minute, the mood, the topics most mentioned, each platform's share and what superchats have raised, with one sentence saying so. The mood is read from a short word list; it is a guide, not a measure.
- **Poll**: one at a time, two to six options, timed or closed by hand. Fans vote by commenting the option's number; one vote per account, the last one counting. Switch **On screen** to show it.
- **Superchats**: the supporter's name, amount and message, coloured by size. Fans pay on the platform; Kickstream shows who did and takes no money itself. Add one by hand when a payment reached you another way.
- **Quick actions**: a custom message, pick a winner (from the commenters, the poll's voters or the supporters), show the poll's result, thank the last supporter, clear the screen.

One thing is on screen at a time and the rest wait their turn. A spotlight or poll put on screen appears on any scene; a scene with a Spotlight or Poll widget shows it there.

| Source | Use |
|---|---|
| Demo feed | Made-up fans, for trying the fan zone. Everything from it is marked **Demo**, in the studio and on the program. This is the source a new installation starts on |
| X | Recent posts matching a search, read with your own X API access. Set the two variables below; how often X may be asked depends on your access tier. This adapter is tested against X's documented response shape and has not been run against X itself |
| Any other platform | A bridge of your own posts comments and superchats to `POST /api/fans/ingest` |

| Variable | Meaning |
|---|---|
| `KICKSTREAM_X_BEARER_TOKEN` | An X API v2 app-only bearer token |
| `KICKSTREAM_X_QUERY` | The search whose posts are the comments, for example `#MyStream -is:retweet` |

| Endpoint | Use |
|---|---|
| `GET /api/fans`, `/stream`, `/socket` | The fan zone, once or live |
| `PUT /api/fans/settings` | `{source, auto_superchat}`: `off`, `demo` or `x`, and whether each new superchat goes on screen by itself |
| `POST /api/fans/comments/{id}/like`, `/spotlight` | Like a comment, or put it on screen |
| `POST /api/fans/poll`, `/poll/close`, `/poll/announce`; `PUT /api/fans/poll/air`; `DELETE /api/fans/poll` | Run a poll: `{question, options, minutes?}` |
| `POST /api/fans/superchats`, `/superchats/{id}/spotlight` | Add one by hand: `{name, amount, currency, message}`; thank one on screen |
| `POST /api/fans/spotlight`, `DELETE /api/fans/spotlight` | A custom message: `{title?, text, duration_s?}`; take off what is on screen |
| `POST /api/fans/winner` | `{pool}`: `commenters`, `voters` or `supporters` |
| `POST /api/fans/ingest` | `{comments: [{id, platform, author, text, handle?, likes?}], superchats: [{id, platform, name, amount, currency, message?}]}` |
| `DELETE /api/fans` | Clear comments, the poll and superchats |

The fan zone is kept in `.data/fans.json`. What fans write is cut to length and only ever shown as plain text.

## Going live

The studio's **Stream** tool sends the program to several platforms at once.

1. On the platform (YouTube Studio, X Media Studio, Facebook Live Producer, Twitch), create a live stream. It shows a server address and a stream key.
2. In the Stream tool, choose the platform and paste the key. YouTube, Facebook and Twitch addresses are filled in; X gives each account its own, so paste that too. **Record to file** needs neither and writes an MP4 to `.data/recordings/`, which is a good first test.
3. Press **Go live**, in the studio, or on the home page for the current broadcast. Each destination shows connecting, live, retrying or failed, in the Stream tool and in the top bar. One failing does not stop the others.

Kickstream opens the studio's clean output (`/studio?output`) in a hidden browser, encodes it once with ffmpeg, and copies that stream to every destination. It needs [ffmpeg](https://ffmpeg.org) and a Chromium-based browser (Microsoft Edge is used when present).

| Variable | Meaning |
|---|---|
| `KICKSTREAM_PROGRAM_URL` | Where the hidden browser opens the clean output (default `http://127.0.0.1:5173/studio?output`) |
| `KICKSTREAM_BROWSER` | Path to a Chromium-based browser, when Edge is not wanted or not found |
| `KICKSTREAM_FFMPEG` | Path to ffmpeg, when it is not on the `PATH` |

Stream keys are kept in `.data/output-keys.json` and are never sent back to a page. Kickstream has no sign-in: keep the pipeline and the web server reachable from your machine only. The one exception is the guests' tunnel, which opens only the guest routes (see Guests). Anyone who can reach the rest can stream to your channels. The stream's sound is the guests' call: the voices of everyone unmuted in the broadcast's room, you included when you join with your camera. There is no other sound, so with no one in the call the stream is silent. Do not run the pipeline with `--reload` when going live; on Windows it cannot start ffmpeg that way.

Pages follow live data over WebSockets, which the pipeline accepts only from pages on the host it was reached at. Behind a reverse proxy that rewrites the `Host` header, list the public hostnames in `KICKSTREAM_ALLOWED_HOSTS` (comma-separated, for example `kick.example,www.kick.example`).

## Broadcasts and reels

A broadcast is one show: a title, an optional description, and whether to record it. Create it on the home page, then press **Go live**. A broadcast that records turns on a file destination by itself, so it can go live with no platform set up. **End broadcast** stops the stream and saves what happened:

- **Sessions:** each time it was on air, and whether each destination got the stream. Going live again from the broadcast's page adds a session.
- **Recordings:** the MP4s written while it was live, playable and downloadable on its page.
- **Stats:** time on air, destinations reached, the score, and the key moments with their commentary.

Starting the Output with no broadcast (through the API, for example) still saves one, titled with the date and time. Broadcasts are kept in `.data/broadcasts.json`.

On an ended broadcast's page, **Generate reels** cuts up to four 15-second vertical clips (1080 × 1920) from the recording, around its goals, red cards and big chances, or spread through it when there were none. With a model configured, two Microsoft Agent Framework agents do the choosing: a Highlight Editor picks the moments and a Social Copywriter writes each reel's title, caption and hashtags. Without a model, or if they fail, templates do it. The agents never set the times: each clip starts 8 seconds before its moment. Each reel plays on the page, downloads as an MP4, and has a button that copies its post. Reels are kept in `.data/reels/`.

| Endpoint | Use |
|---|---|
| `GET /api/broadcasts`, `/api/broadcasts/socket` | Every broadcast, once or live |
| `POST /api/broadcasts` | Create one: `{"title", "description", "record"}` |
| `PUT`, `DELETE /api/broadcasts/{id}` | Edit or delete one |
| `POST /api/broadcasts/{id}/select` | Make it the current broadcast, the one the studio works on and the next stream belongs to |
| `POST /api/broadcasts/{id}/live`, `/end` | Go live with it, or end it |
| `POST /api/broadcasts/{id}/reels` | Generate reels from its recording |
| `GET /api/broadcasts/{id}/recordings/{file}`, `/reels/{reel}.mp4` | Its recordings and reels, with range requests for seeking |

## Guests

In a broadcast's studio, the **Guests** tool (or **Invite a guest** under Backstage) invites guests by link, as on StreamYard. Each invite has a role:

| Role | Camera and mic | On stage | Studio |
|---|---|---|---|
| Speaker | yes | when you put them there | no |
| Co-host | yes | when you put them there | can open it |
| Member | yes | never | no |

Copy the link and send it. The guest checks their camera and microphone, gives a name, and joins. You add up to four people to the stage, including yourself with **Join with camera** and **Add me to stage**. Who is on stage appears in the scene's **Cameras** element (the **Interview** template has one), or in a picture-in-picture box when the scene has none, and their voices are on the stream. While the broadcast is live, everyone backstage is muted. **Revoke** stops a link at once; ending or deleting the broadcast stops them all.

Calls go through Azure Communication Services Rooms. Create a Communication Services resource in the Azure portal, then put its connection string in a `.env` file at the top of the project (it is ignored by git):

    KICKSTREAM_ACS_CONNECTION_STRING=endpoint=https://<resource>.communication.azure.com/;accesskey=<key>

To try guests without Azure, set `KICKSTREAM_ROOMS=fake` instead: invites, the stage and the guest page work, but no one sees or hears anyone else.

Guests on other networks reach you through an HTTPS tunnel (Cloudflare Tunnel or ngrok) to the web server on port 5173; browsers allow cameras only on `https://` pages or `localhost`. Put the tunnel's hostname in `KICKSTREAM_PUBLIC_HOSTS` (in `.env` too) before starting the pipeline and the web server; both read it at start. On that address only the guest routes answer, and a co-host's studio routes; everything else stays on your machine. Never open a tunnel while `KICKSTREAM_PUBLIC_HOSTS` is empty: with no public hosts the gate is off, and the tunnel opens the whole studio to anyone with its address.

A co-host can do everything you can in the studio: go live, end or delete the broadcast, and make or revoke invites. A co-host's **Join with camera** in the studio joins as you, the host: it is your seat in the room, with your name and your place on the stage, not a second one.

| Variable | Use |
|---|---|
| `KICKSTREAM_ACS_CONNECTION_STRING` | The Azure Communication Services resource guests' calls use |
| `KICKSTREAM_ROOMS` | `fake`: in-memory rooms, for trying guests without Azure |
| `KICKSTREAM_PUBLIC_HOSTS` | The tunnel's hostnames, comma-separated; invite links use the first |

| Endpoint | Use |
|---|---|
| `GET /api/broadcasts/{id}/people`, `/socket` | The broadcast's people: invites, who is present, the stage |
| `POST /api/broadcasts/{id}/people/invites` | `{role, name?}`: make an invite link |
| `DELETE /api/broadcasts/{id}/people/invites/{invite}` | Revoke it |
| `PUT /api/broadcasts/{id}/people/stage` | `{people}`: who is on stage, in order |
| `POST /api/broadcasts/{id}/people/host/seat` | `{name?}`: your seat in the room, for **Join with camera**; asking again gives a new token for the same seat |
| `POST /api/broadcasts/{id}/people/program/seat` | The program page's seat in the room, from which it shows who is on stage and carries their voices; asking again gives a new token |
| `GET /api/guest/{secret}`, `/socket` | What a guest's page shows |
| `POST /api/guest/{secret}/join` | `{name}`: join the room |
| `POST /api/guest/{secret}/seat/refresh` | A new token for a guest who has joined |

## Layout

| Path | Contents |
|---|---|
| `packages/contracts/` | JSON Schema for every message; the Python and TypeScript types are generated from it |
| `services/pipeline/kickstream/` | The five stages, the ports they depend on, and the adapters behind those ports |
| `services/pipeline/kickstream/app.py` | The composition root: the only place adapters are chosen |
| `services/pipeline/kickstream/sources/`, `live/` | Browsing the match data sources, and turning a live source's polls into match events |
| `services/pipeline/kickstream/people/` | Invites, the stage and call rooms for guests |
| `services/pipeline/kickstream/agents/` | The seven match agents, one module each, and the orchestrator that routes payloads to them |
| `services/pipeline/kickstream/fans/` | The fan zone: comments, the summary, polls, superchats and the spotlight |
| `services/pipeline/kickstream/copilot/` | Ask Copilot: placing a question, answering it from the match and the archive, and the archive of finished matches |
| `apps/web/` | The React and Fluent UI web app: home, broadcasts, studio, program and match data |
| `docs/superpowers/` | Design spec and implementation plan |

Stages talk only through the event bus and the contracts, and never import one another. Moving to Azure means adding adapters for the four ports (event bus, narrative writer, match store, broadcaster) and choosing them in `app.py`; the fifth, the call rooms, already has one for Azure Communication Services Rooms.

## Test it

```bash
pnpm test:api                         # pipeline unit and integration tests
pnpm test:web                         # web unit and component tests
(cd apps/web && pnpm e2e)             # home, broadcasts and reels, studio, output, guests, agents, fan zone, Ask Copilot and match data, in a real browser
(cd apps/web && pnpm e2e:acs)         # guests over Azure; runs only with KICKSTREAM_ACS_CONNECTION_STRING in .env
(cd apps/web && pnpm e2e:network)     # real StatsBomb and OpenLigaDB; API-Football only with KICKSTREAM_API_FOOTBALL_KEY in .env
```

No test calls a live model or a live platform, and only `e2e:network` reaches the match data sources; the others use recorded or stand-in answers.

The browser tests start their own pipeline (port 8010) and dev server (port 5183) with a fresh data directory, so they never touch a Kickstream you have running.

After changing `packages/contracts/kickstream.schema.json`, regenerate both sets of types:

```bash
(cd services/pipeline && uv run python -m kickstream.tools.gen_contracts)
(cd apps/web && pnpm gen:contracts)
```
