# Kickstream output: live to YouTube, X, Facebook and other channels

Status: awaiting review
Date: 2026-10-13
Builds on: `2026-10-12-kickstream-slice-design.md` (cycle 1), `2026-10-12-kickstream-studio-design.md` (studio) and `2026-10-13-kickstream-audience-design.md` (audience)

## Purpose

The studio composes a picture on `/program`, but Kickstream sends it nowhere; a streamer has to capture that page with another tool. This sub-project makes Kickstream produce the video itself and send it to several platforms at once. The streamer pastes each platform's stream key, presses Go live, and the program appears on every channel.

This is the first of three pieces. Sound (spoken commentary, crowd sounds) and camera and guests follow as their own sub-projects; this one is built so that they only need to play on the program page to reach every platform.

## Constraints

- There is no Azure subscription. Everything runs on the streamer's machine, behind ports, as in earlier cycles.
- The studio routes are not protected. With stream keys stored, that matters more: anyone who can reach the studio could add a destination and stream to it. **This sub-project is safe only while the pipeline is reachable from the streamer's machine alone.** Protecting the studio routes remains outside it.
- A stream key is a secret. No route returns one, and none is written to a log.
- No test contacts a real platform.
- The earlier rules still hold: stages talk through ports and contracts, adapters are chosen only in `app.py`, message shapes live in the shared schema.

## What the feasibility test showed

A throwaway test on this machine, before this spec was written:

- A hidden Chromium page can capture its own tab (`getDisplayMedia` with the current tab preferred, the browser started with `--auto-accept-this-tab-capture`), record it, and hand the recording to ffmpeg, which produced 1280×720 H.264 video at 30 frames per second. It worked the same in Playwright's Chromium and in the installed Microsoft Edge.
- Sound captured from the tab was silent. Sound the page mixes itself (Web Audio into a stream destination, added to the recording) came through at full level. The page therefore owns an audio mix, and anything that should be heard is connected to it.
- The flag `--use-fake-ui-for-media-stream` made the browser capture the whole screen instead of the tab. It must never be used: it would broadcast the streamer's desktop.

## Decisions

| Topic | Decision |
|---|---|
| Where video comes from | The pipeline opens `/program` in a hidden browser, which captures its own tab |
| Browser | A Chromium-based browser already on the machine: Microsoft Edge by default, or the one named in `KICKSTREAM_BROWSER` |
| Program address | The hidden browser opens `KICKSTREAM_PROGRAM_URL`, by default the dev server's `/program` |
| ffmpeg | The `ffmpeg` on the path, or the one named in `KICKSTREAM_FFMPEG` |
| Sound | The program page owns one audio mix. In this sub-project nothing is connected to it, so the stream carries silence |
| Encoding | One ffmpeg process encodes once: H.264 video, AAC audio, a keyframe every 2 seconds |
| Reaching platforms | One sender process per destination copies the encoded stream to it without re-encoding |
| Destinations | YouTube, X, Facebook, Twitch, Custom RTMP, and Record to file |
| Quality | 720p at 30 frames per second and 3,000 kbps by default; 1080p at 30 and 6,000 kbps as an option |
| Platform APIs | Not used. The streamer creates the stream on the platform and pastes its key |
| State | A separate output document, not part of the studio document |

## Definition of done

1. The streamer adds a destination in the studio's Output tab by choosing a platform and pasting a stream key. The server address is filled in for the known platforms.
2. After saving, the key is never shown again: the studio shows only its last four characters, and nothing at all for a key of eight characters or fewer.
3. The streamer presses Go live. Within 15 seconds each enabled destination shows live, and the program, as it looks on `/program`, is being sent to it.
4. A Record to file destination produces an MP4 that plays, with the program's picture at the chosen size and an audio track.
5. What the streamer changes in the studio while live (scene, banner, poll on air) appears in the stream.
6. A destination with a wrong address or key shows failed with a reason, and the other destinations stay live.
7. A destination whose connection drops is retried by itself and returns to live.
8. Stop ends every stream within 5 seconds and leaves no browser or ffmpeg process running.
9. Stopping or restarting the pipeline while live leaves no browser or ffmpeg process running.
10. With no ffmpeg or no browser on the machine, Go live is refused with a message saying what is missing.

## Pages

| Path | Change |
|---|---|
| `/studio` | A new Output tab: the destination list, quality, Go live and Stop, and live status. |
| `/program` | When opened with a capture token, it captures itself and sends the recording to the pipeline. Otherwise unchanged. |

## Output state

The server holds one output document.

**Destination:** an ID, a name (1 to 40 characters), a platform (`youtube`, `x`, `facebook`, `twitch`, `custom` or `file`), a server address (for every platform except `file`), whether it is enabled, the last four characters of its key, and its status.

**Destination status:** `idle`, `connecting`, `live`, `retrying` or `failed`, with a short reason when retrying or failed, and when it last went live.

**Document fields:**

| Field | Meaning |
|---|---|
| `destinations` | Up to 10 destinations |
| `quality` | `720p30` or `1080p30` |
| `state` | `idle`, `starting`, `live` or `stopping` |
| `started_at` | When the current run went live, or none |
| `problem` | Why the last run ended, if it ended by itself |
| `recordings` | The 20 most recent recordings: file name, size and when it was made |

Stream keys are kept beside the document, not in it. The document, as every page sees it, never contains a key.

## Behaviour

### Destinations

- The known platforms have a default server address, which the streamer may change: YouTube `rtmp://a.rtmp.youtube.com/live2`, Facebook `rtmps://live-api-s.facebook.com:443/rtmp/`, Twitch `rtmp://live.twitch.tv/app`. X gives each streamer its own address in Media Studio, so X and Custom RTMP start empty.
- A server address must begin with `rtmp://` or `rtmps://`, be at most 300 characters, and name a host. A key is 1 to 300 characters with no spaces or line breaks; spaces and line breaks around a pasted key are dropped.
- Editing a destination without entering a key keeps the stored key.
- Record to file needs no address or key. It writes `.data/recordings/<date>-<time>-<destination id>.mp4`, in a form that still plays if the recording is cut short.
- Destinations cannot be added, edited, removed, enabled or disabled while a run is starting, live or stopping. The quality cannot be changed either.
- Deleting a destination deletes its key.

### Going live

- Go live needs at least one enabled destination. It is refused while a run is in progress.
- The pipeline starts the encoder, then the hidden browser on the program page, then a sender per enabled destination.
- The run is `starting` until the encoder has produced video, and `live` from then on. If no video arrives within 20 seconds, the run stops with a problem saying so.
- The hidden browser's window is the size of the chosen quality, and the program page fills it.

### While live

- Each destination's status is its own. One failing never changes another.
- A sender that exits is restarted after 2 seconds, then 4, 8, 16 and 30, and every 30 seconds after that. It is `retrying` while waiting and `connecting` while starting. After 10 failures in a row with no time live between them, it is `failed` and is left alone until the next run.
- The reason shown for a failure is the last line the sender reported, with the key removed.
- If the browser or the encoder exits, the whole run restarts once. If it exits again within 60 seconds, the run stops and `problem` says which one failed.
- A new sender joins the stream at the next keyframe, so it starts within 2 seconds.

### Stopping

- Stop ends the browser, the encoder and every sender. Each process is asked to finish and is killed if it has not within 3 seconds.
- A recording is closed properly so that it plays. It is listed in `recordings` with its size.
- When the pipeline shuts down, a run in progress is stopped the same way.
- When the pipeline starts, the state is `idle` whatever the saved document says, and every destination is `idle`.

### The program page as a source

- The capture token is random, made for one run, and checked by the pipeline. A page without the run's token cannot send video.
- The page waits until it has the studio document before it starts recording, so the stream does not begin on an empty frame.
- The page owns one audio mix and records it alongside the picture. Nothing is connected to it in this sub-project.
- The page sends the recording to the pipeline over a WebSocket in pieces of about a quarter of a second.
- The page shows nothing that is not on `/program` today: no capture controls, no cursor.
- The page records only its own tab. If the browser hands it a screen or a window instead, it refuses and nothing is sent.

## Architecture

```
studio page ──HTTP + WebSocket (output document)──► output stage ──► OutputStore (JSON file + keys file)
                                                       │
                                  ┌────────────────────┼─────────────────────┐
                                  ▼                    ▼                     ▼
                           ProgramCapture           Encoder               Sender (one per destination)
                        hidden browser on      one ffmpeg: recording   ffmpeg copy ──► rtmp://… or .mp4
                        /program?capture=…     in, encoded stream out
                                  │                    ▲   │                     ▲
                                  └──WebSocket: recording──┘   └── encoded stream ───┘
```

- **`output` stage:** owns the output document and every rule above. The rules that do not involve processes (validating a destination, the retry schedule, what a run may do in each state) are pure functions tested against a fake clock, in the style of the studio and audience rules.
- **`OutputStore` port:** load and save the document and the keys. The adapter writes two JSON files in the data directory; the keys file is readable only by the current user where the system allows it.
- **`ProgramCapture` port:** start and stop a browser on a URL at a size, and report if it exits. The adapter starts the browser as a process with a temporary profile and drives it over the DevTools protocol.
- **`Encoder` port:** takes the recording in, gives the encoded stream out, and reports if it exits. The adapter is ffmpeg.
- **`Sender` port:** takes the encoded stream and delivers it to one destination, and reports when it connects and why it exits. The adapter is ffmpeg copying without re-encoding. The stage hands each sender the same bytes.
- **Capture socket:** `/api/output/capture/socket`, accepted only with the run's token. Its bytes go straight to the encoder.
- **Compute once, fan out many:** the cost of encoding does not grow with the number of destinations, and none of it grows with the number of viewers. The stage has no dependency on where it runs, so a later cycle can move it to its own container.

### HTTP surface

Under `/api/studio/output`.

| Method and path | Purpose |
|---|---|
| `GET /` | The output document |
| `GET /stream` and `/socket` | The output document after changes |
| `POST /destinations` | Add a destination |
| `PUT /destinations/{id}` | Change a destination; a missing key keeps the stored one |
| `DELETE /destinations/{id}` | Remove a destination and its key |
| `PUT /quality` | Set the quality |
| `POST /start` | Go live |
| `POST /stop` | Stop |

A request that breaks a limit is refused with 422 and a message naming the field; an unknown ID with 404; a change while a run is in progress, or Go live with nothing enabled, with 409; Go live when ffmpeg or a browser is missing with 503 and what is missing.

## Error handling

- **ffmpeg or browser missing:** checked when Go live is pressed, not at startup, so the rest of Kickstream works without them.
- **The browser cannot reach the program page:** no video arrives, and the run stops after 20 seconds with a problem saying the program page did not start.
- **A key the platform rejects:** the sender exits; the destination retries and then shows failed with the platform's reason.
- **The disk fills during a recording:** the file sender exits and that destination fails; the others continue.
- **A slow destination:** each sender has a bounded buffer of 10 seconds of stream. A sender that falls further behind is restarted, so one slow platform cannot hold back the others or grow memory.
- **The studio page closes while live:** the run continues. It is the pipeline that is live, not the page.
- **Corrupt output file:** set aside, and the output starts empty, as the studio file does. A corrupt keys file loses the keys; destinations then show no key and must be given one again.
- **Save failure:** the change is refused and not applied.
- **Processes left from a crash:** the browser's temporary profile and every process the stage starts are tied to the pipeline process, so they end with it.

## Testing

- **pytest:** every rule against a fake clock: destination validation, the retry schedule and the failure limit, what each state allows, that no view of the document contains a key, and that failure reasons have the key removed. The stage with fake capture, encoder and senders: start order, one sender failing while others stay live, the single whole-run restart, the 20-second start limit, Stop and shutdown ending everything. The HTTP surface with its status codes. The store, including the corrupt-file cases.
- **pytest with real ffmpeg**, skipped where ffmpeg is absent: the encoder and a file sender turn a generated test recording into an MP4 that ffprobe reads as H.264 and AAC at the chosen size; a sender pointed at a closed port reports failure without stopping a second sender.
- **Vitest:** the Output tab in each state (no destinations, idle with destinations, starting, live, a failed destination), the destination form and its refusals, and the program page starting capture only when given a token.
- **Playwright:** one run: add a Record to file destination, go live, switch scene, stop, and check that a recording of a few seconds exists and that no process is left.

## Out of scope

Sound of any kind beyond a silent track (the next sub-project); camera input and guests (the one after); creating or titling broadcasts through platform APIs; reading platform chat or Super Chat (the comments sub-project); protecting the studio routes; rendering in the cloud; hardware encoding; more than one program at a time; SRT, HLS or WebRTC output.
