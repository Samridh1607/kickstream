# Kickstream studio and scenes

Status: awaiting review
Date: 2026-10-12
Builds on: `2026-10-12-kickstream-slice-design.md` (cycle 1)

## Purpose

Cycle 1 gives fans a dashboard. A streamer needs something different: a picture they compose and control, ready to broadcast. This sub-project adds a studio where the streamer arranges scenes on a 16:9 canvas, switches between them, puts banners, a ticker and replays on screen, and runs countdowns before the match and during breaks.

It is the first of four studio sub-projects. The others are video output to YouTube, X and Facebook; platform comments and Super Chat; and polls and AskExpert. Each of those needs a studio canvas to put things on, which is why this one comes first.

## Constraints

- Kickstream has no video. Everything on the canvas is drawn from match data, and a replay is an animation of stored match events.
- The cycle 1 rules still hold: stages talk only through the event bus and the contracts, adapters are chosen only in `app.py`, message shapes live in the shared JSON Schema, and no test calls a live model.
- No new sign-in. There is one studio per server.
- Nothing in this sub-project sends video anywhere. The program page is a web page that a capture tool, or the later output sub-project, points at.

## Decisions

| Topic | Decision |
|---|---|
| Layout model | Free canvas: elements are dragged, resized, layered and hidden |
| Canvas | Logical 1920 × 1080; positions and sizes are whole logical pixels; snapping to a 20-pixel grid |
| Templates | Saved canvases; five built in; the streamer can save their own |
| Banner feed | Automatic for goals and red cards, manual for everything else, with custom text |
| Replay | Animated on the pitch from stored events |
| Breaks | The match does not pause during a break |
| Persistence | One JSON file behind a storage port |
| Timers | Run on the server, so they fire with no control page open |
| Languages | The control page is in English; everything on the program page follows the program language |
| Start time | Entered as "start in N minutes" (1 to 1440) and converted to a time on the server's clock |
| Reconnecting | The first document a page receives after reconnecting replaces what it holds, even with a lower revision, because the server may have restarted from a reset file |

## Definition of done

With a match available, a streamer can:

1. Open `/studio`, create a scene from a template, and drag, resize, layer and hide its elements.
2. Open `/program` in another window, on this or another machine, and see exactly the active scene with no controls.
3. Switch scenes with one click and see the program page cut to the new scene within a second.
4. Set a start time, watch the Starting-soon scene count down, and have the match start and the program cut to the Live scene at zero.
5. See a goal appear on the banner by itself, send any narration line to the banner with one click, and show a banner with their own text.
6. Run a ticker with their own messages and automatic score and stats lines.
7. Replay a key moment as an animation on the pitch, tagged as a replay, and see the program return to live when it ends.
8. Take a break with a countdown and have the program return to the previous scene when it ends.
9. Restart the server and find scenes, templates and settings as they left them.

## Pages

| Path | For | Content |
|---|---|---|
| `/` | Fans | The cycle 1 dashboard, unchanged |
| `/studio` | The streamer | Canvas editor, scene list, element list, banner, ticker, highlights and countdown controls, and a small live preview of the program |
| `/program` | Capture | The active scene only, scaled to fit the window at 16:9, with no controls, scroll bars or cursor-dependent content |

The web app chooses the page from the URL path. No routing library is added.

## Studio state

The server holds one `Studio` document. Every change produces a new revision of the whole document.

| Field | Meaning |
|---|---|
| `revision` | Increases by one on every change |
| `scenes` | Up to 20 scenes |
| `active_scene_id` | The scene the program shows |
| `previous_scene_id` | Where to return after a break |
| `templates` | Scenes the streamer saved as templates |
| `settings` | Program mode and language; switches for automatic banners, automatic start at the end of the start countdown, and automatic break at half-time |
| `banner` | The message on screen now, if any, with its kind and end time |
| `banner_queue` | Messages waiting, oldest first, up to 10 |
| `ticker` | On or off, speed, the streamer's messages, and switches for the automatic score and stats lines |
| `countdown` | Kind (`start` or `break`), end time and label, or none |
| `replay` | The key moment being replayed and when it started, or none |

A **scene** has an ID, a name, the name of the template it was made from (if any) and up to 40 elements. An **element** has an ID, a type, `x`, `y`, `width`, `height`, a layer number, a visible flag, and type-specific properties.

### Elements

| Type | Shows | Properties |
|---|---|---|
| `scoreboard` | Teams, score, match clock | |
| `pitch` | Live events and the pressure map | Pressure map on or off |
| `narration` | The latest narrative lines in the program's mode and language | Number of lines, 1 to 6 |
| `stats` | Home and away comparison bars | |
| `banner` | The current banner message; empty when there is none | |
| `ticker` | The scrolling line | |
| `timeline` | Key moments along the 90 minutes | |
| `recap` | The latest half-time or full-time recap | |
| `replay` | The replay animation; empty when none is playing | |
| `countdown` | Time remaining and label; empty when none is running | |
| `text` | The streamer's own text | Text up to 200 characters, size, alignment |
| `image` | An uploaded image | Image ID, fit (contain or cover) |

Elements are kept inside the canvas and are at least 40 × 40. An element type the server does not recognise in a saved file is dropped when the file is loaded.

When a replay starts and the active scene has no `replay` element, the program shows the replay in a default box centred on the canvas, so a replay is never invisible.

### Built-in templates

| Template | Elements |
|---|---|
| Starting soon | Title text, countdown, both team names, ticker |
| Live match | Scoreboard, pitch, narration, banner, ticker |
| Analyst desk | Scoreboard, stats, timeline, narration, a smaller pitch, banner |
| Break | Title text, countdown, recap, ticker |
| Full-time | Scoreboard, recap, stats, banner |

A new studio starts with one scene from each template, and Starting soon active.

## Behaviour

### Editing and syncing

- The control page edits a scene locally while a drag or resize is in progress and saves it when the gesture ends.
- Saving replaces that scene on the server. If two control pages edit the same scene, the last save wins.
- The server sends the whole studio document to every connected control and program page after each change. Pages ignore a document whose revision is not newer than the one they hold.
- Elements can also be moved and resized from the keyboard: arrow keys move by one grid step, and Shift with arrow keys resizes.
- The active scene cannot be deleted, and neither can the last remaining scene.

### Banner

- A banner has text, a kind (`goal`, `card`, `info` or `custom`) and a duration between 3 and 30 seconds; the default is 8.
- With automatic banners on, the studio adds a banner when a goal or red card narrative arrives in the program's mode and language.
- "Show on banner" on any narration line adds that line as an `info` banner.
- If a banner is already showing, new ones wait in the queue. When the queue is full, the oldest waiting message is dropped. A goal goes to the front of the queue.
- The streamer can clear the current banner, which shows the next one.

### Ticker

- The ticker cycles through the streamer's messages, each up to 120 characters, up to 20 messages.
- With the automatic lines on, it also carries the current score and one line of headline stats, refreshed as the match goes on.
- With no messages and both automatic lines off, the ticker element is empty.

### Highlights and replay

- The control page lists the match's key moments, newest first, each with its narrative and a Replay button.
- A replay plays the events of the 20 match seconds leading up to the moment, over about 8 seconds, as markers moving on a pitch, with a "REPLAY" tag and the moment's minute.
- The replay ends by itself. Starting another replay replaces the one playing. The streamer can stop it early.
- Replaying a moment from a match the server no longer holds is refused with a clear message.

### Countdown and breaks

- **Start countdown:** the streamer sets a start time up to 24 hours ahead. The program cuts to the first scene made from the Starting-soon template, or stays where it is if there is none. At zero, if automatic start is on, the studio starts a match and cuts to the first scene made from the Live-match template.
- **Break:** the streamer chooses 1 to 60 minutes. The studio remembers the current scene, cuts to the first scene made from the Break template, and counts down. At zero it returns to the remembered scene. The streamer can end a break early.
- **Half-time:** with the automatic half-time break on, a half-time status from the match starts a 2-minute break.
- Starting a new countdown replaces the one running. A break started during a break keeps the scene remembered by the first one. A start time in the past is refused.

## Architecture

```
match stream (cycle 1) ─────────────────────────────┐
                                                    ▼
control page ──HTTP──► studio stage ──► StudioStore   program page
      ▲                    │  ▲                          ▲
      └────────SSE─────────┘  └── event bus (narratives, └──SSE (studio document)
                                   status, key moments)
```

- **`studio` stage:** owns the studio document and every rule in the Behaviour section. It reads narratives, key moments and match status from the event bus, and publishes nothing back to it. It asks for a match to be started through an injected function, as the gateway does.
- **`StudioStore` port:** load and save the studio document. The cycle 1 adapter is a JSON file written atomically. A file that cannot be read is renamed with a `.corrupt` suffix and the studio starts from the built-in templates.
- **`ImageStore` port:** save and fetch uploaded images. The adapter is a local directory. Uploads are limited to PNG, JPEG and WebP, 2 MB each, 50 images, checked by content and not by file name.
- **Timers:** banner expiry, countdown end and replay end are scheduled by the stage against an injected wall clock, so tests control time.
- **Program data:** the program page opens the cycle 1 match stream for the current match in the studio's mode and language, plus the studio stream. It reuses the cycle 1 stream store and components where they fit.

### HTTP surface

All paths are under `/api/studio`.

| Method and path | Purpose |
|---|---|
| `GET /` | The studio document |
| `GET /stream` | Server-Sent Events; the full document after every change |
| `POST /scenes` | Create a scene from a template or by duplicating a scene |
| `PUT /scenes/{id}` | Replace a scene's name and elements |
| `DELETE /scenes/{id}` | Delete a scene |
| `POST /scenes/{id}/activate` | Make it the active scene |
| `POST /templates` | Save a scene as a template |
| `DELETE /templates/{id}` | Delete a saved template |
| `PUT /settings` | Change settings |
| `POST /banner` | Queue a banner |
| `DELETE /banner` | Clear the current banner |
| `PUT /ticker` | Change the ticker |
| `POST /countdown` | Start a start countdown or a break |
| `DELETE /countdown` | Cancel the countdown or end the break |
| `POST /replay` | Replay a key moment |
| `DELETE /replay` | Stop the replay |
| `POST /images` | Upload an image; returns its ID |
| `GET /images/{id}` | Fetch an image |

One addition outside `/api/studio`: `GET /api/matches/{id}/moments/{moment_id}/replay` returns the match events for a replay.

Every request is validated against the limits in this document and refused with 422 and a message naming the field when it breaks one.

## Error handling

- **Corrupt or missing studio file:** start from the built-in templates; keep the unreadable file aside.
- **Save failure:** the change is refused with an error, the document in memory is left as it was, and the control page shows that the change was not saved.
- **Program page loses its connection:** it keeps showing the last scene and reconnects by itself; on reconnect it takes the current document.
- **No current match:** match-driven elements show an empty state sized to their box. They never collapse or shift other elements.
- **Missing image:** the image element shows a neutral placeholder.
- **Replay for an unknown moment or match:** refused with 404.
- **Server restart during a countdown or break:** the end time is saved, so the countdown resumes. If it ended while the server was down, its end action runs at startup.

## Testing

- **pytest:** every rule in the Behaviour section against a fake clock; the limits; the JSON store including a corrupt file; image validation by content; the HTTP surface; a full run with a real match.
- **Vitest:** the canvas editor's move, resize, snap, clamp, layer and keyboard behaviour; each program element against fixture data including its empty state; revision handling.
- **Playwright:** one run across two pages: build a scene, activate it, see it on the program page, trigger a banner, replay a goal, take and end a break.
- **Contract tests:** the new message shapes generate current Python and TypeScript types.

## Out of scope

Video encoding and output to any platform, platform comments and Super Chat, polls, AskExpert, audio, real video replay, multiple studios, user accounts and permissions, undo and redo in the editor, animated transitions between scenes, and custom fonts or themes.
