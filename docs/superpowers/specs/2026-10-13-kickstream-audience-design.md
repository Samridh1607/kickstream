# Kickstream audience: polls and AskExpert

Status: awaiting review
Date: 2026-10-13
Builds on: `2026-10-12-kickstream-slice-design.md` (cycle 1) and `2026-10-12-kickstream-studio-design.md` (studio)

## Purpose

The studio lets a streamer compose a picture. This sub-project lets the audience take part in it. Fans vote in polls and ask questions; the streamer puts poll results on the program, and has an AI match expert draft an answer to the question fans most want answered, which the streamer approves before it airs.

## Constraints

- There is no sign-in. A fan is identified by a random ID kept in their browser. That prevents accidental double votes; it does not stop someone determined to stuff a poll.
- The studio routes are not protected either. That is acceptable while Kickstream runs on the streamer's machine. **Before the fan page is exposed on a public address, the studio routes must be protected.** That work is outside this sub-project and is called out here so it is not forgotten.
- Fan text is untrusted. It is shown as plain text only, and when it is given to the model it is marked as a question to answer, never as instructions.
- Nothing a model writes reaches the program without the streamer pressing a button.
- The cycle 1 and studio rules still hold: stages talk through the bus and the contracts, adapters are chosen only in `app.py`, message shapes live in the shared schema, and no test calls a live model.

## Decisions

| Topic | Decision |
|---|---|
| AskExpert | Fans submit and upvote questions; an AI agent drafts an answer to one the streamer picks; the streamer edits and approves it |
| Fan page | `/join`, phone-friendly, and the same panel as a tab on the dashboard |
| Polls | One open at a time; 2 to 6 options; timed or closed by hand |
| Identity | One vote per browser, by a random ID the browser keeps |
| Moderation | The streamer can hide any question. No automatic filtering |
| Without a model | No AI draft; the streamer types the answer |
| State | A separate audience document, not part of the studio document |
| Updates to fans | Pushed at most twice a second, however many votes arrive |
| Transport | Pages follow every live stream (match, studio, audience) over a WebSocket. Browsers allow six HTTP connections to one server and each Server-Sent Events stream holds one, so the studio and program pages together would leave none for a button press. The Server-Sent Events routes remain for tools |
| Other sites | A WebSocket is refused unless the page that opens it was served from the same host, because the browser's same-origin rule does not cover WebSockets |

## Definition of done

1. The streamer creates a poll in the studio, from scratch or from a preset, and fans on `/join` and on the dashboard see it within a second.
2. A fan votes, sees live results, and can change their vote while the poll is open. Voting twice from one browser counts once.
3. A timed poll closes by itself; any poll can be closed by hand. A closed poll accepts no votes.
4. The streamer puts poll results on the program, where they update live, and takes them off again.
5. A fan submits a question with an optional nickname, and other fans upvote it. The list is ordered by votes.
6. The streamer hides a question, and it disappears from every fan's list.
7. The streamer presses Ask the expert on a question. With a model configured, a draft answer grounded in the match appears in the studio. The streamer edits it and puts it on air; the program shows the question and answer, and fans see the answer under the question.
8. With no model configured, the streamer types an answer and puts it on air the same way.
9. After a server restart, the open poll, its votes, the questions and their votes are as they were, to within the last second of activity.

## Pages

| Path | Change |
|---|---|
| `/join` | New. The current poll and its results, a box to ask a question, and the question list with upvote buttons. Laid out for a phone. |
| `/` | The dashboard gains a third tab, Join in, showing the same panel. |
| `/studio` | A new Audience tab: create and close polls, put results on air, the question list with hide and Ask the expert, and the answer draft. |
| `/program` | Two new canvas elements, `poll` and `qa`. |

## Audience state

The server holds one audience document.

**Poll:** an ID, the question (1 to 140 characters), 2 to 6 options (each 1 to 60 characters, with a vote count), a state (`open` or `closed`), and an optional closing time.

**Question:** an ID, the text (1 to 200 characters), a nickname (up to 24 characters; "Fan" when blank), a vote count, a state (`open`, `hidden` or `answered`), the answer once there is one, and when it was asked.

**Document fields:**

| Field | Meaning |
|---|---|
| `poll` | The current poll, open or closed, or none |
| `poll_on_air` | Whether the program shows the current poll |
| `history` | Up to 20 earlier polls, newest first |
| `questions` | Up to 200 questions that are open or hidden, plus the 50 most recently answered |
| `draft` | The answer being prepared: which question, the text, and whether the expert is still writing, has finished, or was unavailable |
| `qa` | The question and answer on the program, with its end time, or none |

Who voted for what is kept beside the document, not in it.

There are two views of the document. The **fan view** leaves out hidden questions and the draft. The **studio view** is complete. Fans can never obtain the studio view's extra content through the fan routes.

## Behaviour

### Polls

- Creating a poll closes the current one, if open, and moves the current one into the history.
- **Presets**, built from the current match in the program language: "Who will win?" (home, draw, away) and "Who scores next?" (home, away, no more goals). A preset is refused when there is no match.
- A time limit is 30 seconds to 10 minutes. With none, the poll stays open until closed by hand.
- A fan's vote for an option replaces that fan's earlier vote in the same poll.
- Fans see option counts and percentages only after they have voted or the poll has closed. The program shows them whenever the poll is on air.
- The streamer can bring a poll back from the history as the current, closed poll, to show its result again.

### Questions

- A browser can submit one question every 30 seconds. A question identical to one that browser already has open is refused.
- When 200 open or hidden questions exist, the open question with the fewest votes (oldest first among ties) is dropped to make room.
- An upvote is a toggle: pressing again removes it. A fan cannot upvote their own question; it starts with their one vote.
- The list is ordered by votes, then oldest first.
- Hiding a question removes it from the fan view and keeps its votes. It can be unhidden.

### AskExpert

- **Ask the expert** starts a draft for one question. Starting another replaces it.
- The expert is given the question, both team sheets, the score, the latest stats, and the key moments so far with their narratives. It is told to answer in at most 60 words in the program language, only from that data, and to say so plainly when the data cannot answer the question.
- If the expert fails, times out after 20 seconds, or no model is configured, the draft is marked unavailable and left empty for the streamer to write.
- The streamer can edit the draft at any time, up to 400 characters.
- **Put on air** needs a non-empty draft. It marks the question answered with that text, shows the question and answer on the program for 10 to 120 seconds (30 by default), and clears the draft.
- The streamer can take the Q&A off the program early.
- Asking the expert about a question from a match that has ended still works; the expert is told the match is over.

### On the program

- `poll` shows the question, each option with its bar, count and percentage, and whether the poll is open. It is empty unless the poll is on air.
- `qa` shows the nickname, the question and the answer. It is empty when nothing is on air.
- When a poll or Q&A is on air and the scene on air has no visible element of that type, the program shows it in a default box, as it does for replays.

## Architecture

```
fan pages ──HTTP──► audience stage ──► AudienceStore (JSON file, batched)
     ▲                 │   ▲   │
     └──SSE (fan view)─┘   │   └──► ExpertWriter ──► Match Expert agent
studio page ──HTTP + SSE (studio view)──┘
program page ──SSE (fan view)
```

- **`audience` stage:** owns the audience document and every rule above, as pure functions in the same style as the studio rules. It learns the current match, its stats, key moments and narratives from the event bus.
- **`AudienceStore` port:** load and save the document and the vote records. The adapter is a JSON file. Structural changes (a new poll, a hidden question, an answer) are saved at once; votes are saved in batches, at most once a second.
- **`ExpertWriter` port:** one method that answers a question from a match context. The adapter is a Microsoft Agent Framework agent, `match_expert`, using the same model endpoint settings as the narration agents. With no endpoint configured, no adapter is installed.
- **Pushing updates:** each view has its own stream. A burst of votes is coalesced so that a view is pushed at most once every 500 milliseconds.
- **Timers:** a timed poll's close and the Q&A's end are deadlines settled against an injected clock, as in the studio.
- **Scene elements:** `poll` and `qa` are added to the scene element types. The program and control pages read the fan view alongside the studio document.

### HTTP surface

Fan routes, under `/api/audience`. Every changing request carries the browser's ID in an `X-Voter` header.

| Method and path | Purpose |
|---|---|
| `GET /` | The fan view |
| `GET /stream` | Server-Sent Events: the fan view after changes |
| `POST /poll/vote` | Vote for an option of the current poll |
| `POST /questions` | Submit a question |
| `POST /questions/{id}/vote` | Toggle an upvote |

Studio routes, under `/api/studio/audience`.

| Method and path | Purpose |
|---|---|
| `GET /` | The studio view |
| `GET /stream` | Server-Sent Events: the studio view after changes |
| `POST /poll` | Create a poll, from fields or a preset |
| `POST /poll/close` | Close the current poll |
| `PUT /poll/on-air` | Show or hide the current poll on the program |
| `POST /history/{id}/restore` | Make an earlier poll the current, closed poll |
| `POST /questions/{id}/hide` and `/unhide` | Moderate a question |
| `POST /questions/{id}/ask` | Start an expert draft for a question |
| `PUT /draft` | Edit the draft |
| `DELETE /draft` | Discard the draft |
| `POST /draft/air` | Put the draft on the program |
| `DELETE /qa` | Take the Q&A off the program |

A request that breaks a limit is refused with 422 and a message naming the field; an unknown ID with 404; a vote on a closed poll with 409; a question sent too soon with 429 and the seconds to wait.

## Error handling

- **Missing or malformed voter ID:** the request is refused with 422. The fan page creates an ID if its stored one is missing or malformed.
- **Vote on a poll that just closed, or an option from an earlier poll:** refused with 409; the fan page shows the closed result.
- **Corrupt audience file:** set aside, and the audience starts empty, as the studio file does.
- **Save failure:** structural changes are refused with an error and not applied. A failed vote batch is retried on the next batch; votes stay in memory.
- **Expert failure:** covered above; it never blocks the studio.
- **Fan page loses its connection:** it reconnects by itself and takes the current view; a vote or question sent while offline shows an error and can be sent again.
- **Storage blocked in the fan's browser:** the page keeps an ID for the visit only and says votes may not be remembered after a reload.

## Testing

- **pytest:** every rule against a fake clock; both views, including that the fan view never carries hidden questions or the draft; vote replacement and toggling; the question rate limit and the full-list eviction; batched saving and coalesced pushes; the expert adapter against the fake model endpoint, including fan text that tries to give instructions; the HTTP surface with its status codes.
- **Vitest:** the join panel in each state (no poll, open and not voted, voted, closed), the question box and list, the Audience tab, and the two program elements with their empty states.
- **Playwright:** one run across three pages: the streamer opens a poll, a fan votes on `/join`, results go on the program; the fan asks a question, the streamer answers it and puts it on air.

## Out of scope

Votes or questions from YouTube, X or Facebook chat; sign-in and protection of the studio routes; automatic profanity filtering; a QR code on screen; several polls open at once; translating fan questions; fans answering each other.
