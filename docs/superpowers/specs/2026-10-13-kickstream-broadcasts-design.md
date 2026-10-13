# Kickstream broadcasts and AI reels

## Goal

The streamer's unit of work is a **broadcast**, as in StreamYard: create one on Home with a title and
description, go live with it, end it. Every broadcast is kept: its live sessions, the recordings made
while live, and what happened during it (time on air, destinations reached, polls, votes, questions,
the match score and its key moments). From a kept broadcast with a recording, a team of AI agents
turns the best moments into short vertical **reels** ready to post.

## Shape

```
Home ── POST /api/broadcasts ──▶ BroadcastService ◀── output documents (OutputService.changes)
                                   │    ▲          ◀── audience documents (AudienceService.changes)
            /api/broadcasts/socket │    │          ◀── BroadcastStage (bus: status, key moments, narratives)
                                   ▼    │
                        broadcasts.json  ReelProducer (Highlight Editor ▸ Social Copywriter | template)
                                         ClipCutter (ffmpeg, 1080×1920)
```

`broadcasts/` is a stage like the others: it imports only itself and the shared packages. The
composition root hands it the output and audience services as plain callables, so it never names them.

## Rules (`broadcasts/rules.py`, pure)

- A broadcast is `ready`, `live` or `ended`. One broadcast at a time is **current**: the one Go live
  starts. Creating a broadcast makes it current.
- **Sessions follow the output, whoever started it.** When the output goes live, a session opens on
  the current broadcast; if there is none, one is created and named after the time ("Broadcast ·
  13 Oct 14:05"), so no stream goes unsaved. When the output goes idle, the session closes with the
  output's problem, if any. A broadcast whose session closed because the streamer pressed **End
  broadcast** is `ended`; one whose stream stopped any other way is `ready` again, and can go live
  again as a new session.
- Each session keeps the destinations that were on and how each fared: `live` if it ever received
  the stream, `failed` with the reason, or `off`.
- **Recordings** are the output's recordings listed while a session was open. A recording starts
  when its file destination went live (its id is in the file name), so moment times map onto it.
- **Stats**: time on air (sum of sessions), polls run while live with their votes, questions asked
  while live, the match score at the end, and key moments while live (with the fan commentary when
  it arrives).
- A restart while live closes nothing: the output passes through `starting` and back.
- After a pipeline restart, a session left open is closed at its start with a note.

## Reels (`broadcasts/reels.py`, pure)

- **Candidates** are the key moments inside a recording, each with its offset into the file. A
  recording with no moments offers evenly spaced segments instead, so every recording can make reels.
- The **producer** picks up to four candidates and writes a title, caption and hashtags for each.
  It never chooses times: a reel is the 15 s around its moment (8 s before), clamped to the file.
- What any producer returns is checked: unknown or repeated candidates are dropped, text is trimmed
  to its limits, hashtags are normalised to `#Word`, at most six.
- The **agent producer** is two Microsoft Agent Framework agents in sequence: the **Highlight
  Editor** picks moments from the list and says why; the **Social Copywriter** writes the post for
  each pick. Any failure or timeout falls back to the **template producer**, and each reel records
  which one wrote it.
- The **clip cutter** renders 1080×1920 at 30 fps: the program picture fitted across the width, over
  a blurred fill of itself. H.264/AAC MP4 with `+faststart`, so it plays while downloading.
- Generating runs in the background; reels appear as `rendering` and become `ready` or `failed`. A
  broadcast keeps at most 12 reels; one can be deleted with its file.

## API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/broadcasts`, `/stream`, `/socket` | the document |
| POST | `/api/broadcasts` | create `{title, description, record}` |
| PUT | `/api/broadcasts/{id}` | edit title and description |
| POST | `/api/broadcasts/{id}/live` | make current, turn the recording on if asked, start the output |
| POST | `/api/broadcasts/{id}/end` | stop the output if live; the broadcast is ended |
| DELETE | `/api/broadcasts/{id}` | delete a broadcast that is not live, with its reels |
| POST | `/api/broadcasts/{id}/reels` | generate reels |
| DELETE | `/api/broadcasts/{id}/reels/{reel}` | delete a reel and its file |
| GET | `/api/broadcasts/{id}/recordings/{file}` | the recording (byte ranges, for seeking) |
| GET | `/api/broadcasts/{id}/reels/{reel}.mp4` | the reel |

Only files the broadcast lists are served.

## Web

- **Home**: the hero is the current broadcast (create one, go live, end it) beside the program
  preview. A **Broadcasts** list replaces the scenes grid (scenes stay in the studio).
- **`/broadcasts/{id}`**: title and state with Go live / End; stat tiles; the recording player with
  downloads; sessions with each destination's result; key moments; **Reels** with *Generate reels
  with AI agents*, each reel playable, downloadable, with its caption to copy.
