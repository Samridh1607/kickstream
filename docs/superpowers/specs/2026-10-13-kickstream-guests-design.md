# Kickstream guests: invite links, cameras and sound

## Goal

A streamer invites people into a broadcast with a link, as in StreamYard. Each invite has a role:
**Speaker**, **Co-host** or **Member**. The streamer's camera and every guest's camera and microphone
work end to end: people on stage appear in the program, and their voices are on the stream, on every
destination. Guests can join from anywhere on the internet.

The fan page (`/join`), with its polls and fan questions, is removed: the people taking part in a
broadcast are now invited guests, not anonymous fans.

## Sub-projects

1. **Remove the fan audience** (ships first, on its own).
2. **Guests** over Azure Communication Services (ACS) Rooms.

Azure Media Services is not an option: Microsoft retired it on 30 June 2024. ACS Rooms is Azure's
current service for group video with roles, and it brings worldwide media relays, so guests on strict
networks connect.

## 1. Remove the fan audience

Deleted:

- The `/join` page, the **Fan page** link in the top bar, the fan link and Audience tile on Home, and
  the **Join in** tab on the Match data page.
- The studio's **Audience** tab (polls, the question board, the answer draft).
- The `poll` and `qa` scene element types, and the Poll and Q&A boxes the program adds by itself.
- The pipeline's `audience` package, its routes (`/api/audience/*`, `/api/studio/audience/*`) and
  sockets, and its wiring in `app.py`.
- Broadcast stats `polls` and `questions`, with their tile and card on the broadcast page, and the
  audience observation in the broadcast rules and service.
- Their tests, translation strings, README sections and `e2e/audience.spec.ts`.

Saved data keeps loading:

- `studio.json`: `poll` and `qa` elements are dropped on load (`sanitize_raw` already drops unknown
  element types).
- `broadcasts.json`: `polls` and `questions` in old stats are ignored on load.

## 2. Guests

### Roles

| Role | Camera and mic | Can be on stage | Runs the studio | ACS role |
|---|---|---|---|---|
| Host (the streamer, in the studio) | yes | yes | yes | Presenter |
| Co-host | yes | yes | yes | Presenter |
| Speaker | yes | yes | no | Attendee |
| Member | yes | never | no | Attendee |
| Program page (the hidden capture browser) | receives only | — | — | Consumer |

### Shape

```
Studio (host) ──▶ /api/broadcasts/{id}/people/*  ──▶ PeopleService ──▶ CallRooms port
Guest page    ──▶ /api/guest/{secret}/*          ──▶      │              ├─ AcsRooms (Azure)
                                                         │              └─ FakeRooms (tests)
                       people.json ◀─────────────────────┘
Host, guests, program page ══ ACS Calling SDK (media through Azure) ══
Program page: on-stage videos in the Cameras element; room audio ─▶ programAudio().input ─▶ capture
```

`people/` is a feature like the others: `rules.py` (pure), `service.py`, `api.py`. Adapters are
chosen only in `app.py`. The service is handed the broadcast view as a callable, so it never imports
the broadcasts package.

### Rules (`people/rules.py`, pure)

- **Invites belong to a broadcast.** An invite has an id, a role, an optional name (1–40 characters),
  a secret (32 url-safe random bytes) and when it was made. A broadcast has at most 12 invites. The
  host can revoke one; a revoked invite's link stops working, and a joined guest is removed from the
  stage and the room.
- **Invites need a broadcast that has not ended.** Ending a broadcast revokes all its invites.
- **Joining** with a valid secret records the guest's display name (1–40 characters; defaults to the
  invite's name) and their ACS identity. Joining again with the same link replaces the earlier
  session (one person per link).
- **The stage** is an ordered list of people (the host or joined guests), at most 4. Members cannot
  be added. A person who leaves the room stays on the stage list but shows as away until removed or
  back, so a dropped connection does not reshuffle the layout.
- **Muting while live:** while the broadcast is live, everyone not on stage is muted and cannot
  unmute; their page says why. Before going live, everyone may talk. On stage, people control their
  own microphone; the host and co-hosts can mute anyone (ACS Presenter capability).
- Refusals follow the existing shape: `{"detail":[{"loc":["body",field],"msg"}]}` with 404 for an
  unknown or revoked invite, 409 for a full stage, a Member on stage, or an ended broadcast.

### Rooms (`ports/calls.py`, `adapters/acs_rooms.py`)

`CallRooms` port:

- `open_room(valid_until) -> room_id`
- `seat(room_id, role) -> Seat(user_id, token, expires_at)` — a new ACS identity, added to the room
  with its role, and a VoIP token (24 h)
- `refresh(user_id) -> Seat` — a new token for the same identity
- `unseat(room_id, user_id)` — removes the identity from the room
- `close_room(room_id)`

`AcsRooms` uses the `azure-communication-rooms` and `azure-communication-identity` packages and
`KICKSTREAM_ACS_CONNECTION_STRING`. SDK calls are blocking, so they run in a thread. The room is
opened the first time the broadcast needs it (an invite, or the host turning on their camera), valid
for 7 days, and closed when the broadcast ends. `FakeRooms` hands out predictable ids and tokens for
tests and for the always-on end-to-end tests.

With no connection string, the People panel says how to set it up; everything else works as today.

### Endpoints

Studio (local, or a co-host):

| Endpoint | Use |
|---|---|
| `GET /api/broadcasts/{id}/people`, `/socket` | The people document, once or live |
| `POST /api/broadcasts/{id}/people/invites` | `{role, name?}`: make an invite; answer includes its link |
| `DELETE /api/broadcasts/{id}/people/invites/{invite}` | Revoke it |
| `PUT /api/broadcasts/{id}/people/stage` | `{people: [...]}`: who is on stage, in order |
| `POST /api/broadcasts/{id}/people/host/seat` | The host's ACS token (Presenter) |
| `POST /api/broadcasts/{id}/people/program/seat` | The program page's ACS token (Consumer) |

Guest (public, by secret):

| Endpoint | Use |
|---|---|
| `GET /api/guest/{secret}`, `/socket` | The guest document: broadcast title and state, their role, whether they are on stage, whether they are muted by the live rule |
| `POST /api/guest/{secret}/join` | `{name}`: join; answer is the ACS seat |
| `POST /api/guest/{secret}/seat/refresh` | A fresh token |

The people document (schema `People`): revision, server time, broadcast id, `configured`, invites
(id, role, name, link, joined name, present, revoked), the stage list, and the host's ACS id. The
guest document (schema `Guest`) carries nothing about other guests' invites or secrets.

### Pages

- **Studio, People panel** (next to Scenes): **Invite** (role, optional name, then copy the link),
  the list of people with role, present/away, on-stage state, **Add to stage** / **Remove from
  stage**, **Mute**, **Revoke**. The host's own camera and mic, with device pickers and preview, and
  an **Add me to stage** toggle.
- **Guest page** `/guest/{secret}`: before joining, camera preview, camera and mic pickers, a name
  field and **Join**. After joining, the others' cameras, mic and camera toggles, and a banner: "You're
  on stage — you're live", "You're on stage", "You're backstage" or "You're backstage and muted while
  the broadcast is live". A co-host also gets **Open studio**. An invalid link shows "This invite is
  no longer valid".
- **Program page**: joins as Consumer whenever the current broadcast (the live one, else the
  current one) has a room, and switches rooms when that broadcast changes. Renders each on-stage
  person's video in the **Cameras** element. Connects the room's mixed audio to `programAudio().input`
  (through a muted `<audio>` element first, which Chrome needs before remote WebRTC audio flows into
  Web Audio). Rejoins by itself if the call drops.

### Scenes

- New element type **`cameras`**: tiles the people on stage inside its box (1 → full, 2 → side by
  side, 3–4 → a 2×2 grid), each with a name tag. Props: `names` (show name tags, default on).
- New built-in template **Interview**: cameras across most of the canvas, with the scoreboard.
- If people are on stage and the scene on air has no `cameras` element, the program adds a
  picture-in-picture box at the bottom right (the fallback pattern `withFallbacks` already uses).

### The ACS client in the web app (`apps/web/src/calls/`)

A small `RoomCall` interface hides the ACS Calling SDK:

- `join(roomId, token, refresh)`, `leave()`
- `cameras()`, `microphones()`, `setCamera(id | null)`, `setMicrophone(id | null)`, `setMuted(bool)`
- `participants` (ACS id, display name, video on, speaking) with change events
- `renderVideo(acsId, element)` and `renderLocal(element)`, each returning a disposer
- `roomAudio()`: the room's mixed audio as a `MediaStream`

`AcsRoomCall` implements it with `@azure/communication-calling` and `@azure/communication-common`,
loaded with a dynamic `import()` so pages that never join a call do not load the SDK. Unit tests use
a scripted `FakeRoomCall`.

### Reaching the studio through a tunnel

Guests on the internet reach Kickstream through an HTTPS tunnel (Cloudflare Tunnel, ngrok) to the
web server; browsers allow camera and microphone only on `https://` pages or `localhost`.

- `KICKSTREAM_PUBLIC_HOSTS` lists the tunnel's hostnames. They are added to the WebSocket allowed
  hosts.
- On a public host, the pipeline answers only `/api/guest/*` (checked by secret). Everything else is
  404, unless the request carries a valid co-host cookie, set when a co-host joins and cleared when
  their invite is revoked. The web server's page assets are harmless without the API.
- On `127.0.0.1`, everything works as today.

### Failure handling

- Camera or mic denied, missing or busy: a clear message on the guest page or People panel; the
  person can join with that device off.
- Revoked link or ended broadcast: "This invite is no longer valid".
- ACS errors (bad connection string, quota, network): shown in the People panel with ACS's reason;
  streaming without guests is unaffected.
- The program page's call drops: it rejoins after a short wait; the stream keeps going with the
  scene's other elements meanwhile.
- Risk: ACS may treat the capture browser's `HeadlessChrome` user agent as unsupported. If so, the
  capture browser starts with the user agent of the installed Edge/Chrome.

### Testing

- Pipeline: rules (roles, invite limits, stage limits, Members kept off stage, ended broadcasts,
  muting while live), service and API with `FakeRooms`, the public-host gate, and `AcsRooms` with a
  stubbed SDK client.
- Web: unit tests with `FakeRoomCall` for the People panel, the guest page, the Cameras element and
  the program page's audio connection.
- End to end, always: invite, join as each role, stage controls, revoke, the public-host gate, using
  `FakeRooms` and the browser's fake camera.
- End to end, only when `KICKSTREAM_ACS_CONNECTION_STRING` is set: a real room with the host and a
  guest using the browser's fake camera and microphone; the program shows the guest's video, and the
  recording's audio track is not silent.

## Out of scope

Screen sharing, text chat between guests, per-guest volume, more than 4 people on stage, a guest
preview of the program picture, and recording each guest separately.
