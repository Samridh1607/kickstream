"""Every rule for broadcasts: what the streamer may do, and what a broadcast keeps while it is live.

Each rule takes a state and returns a new one; none mutates its argument. Time is passed in.
A broken limit raises `BroadcastError`. A rule with nothing to change returns its argument.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from datetime import datetime

from kickstream.broadcasts.reels import latest_recording, recording_length
from kickstream.contracts import (
    Broadcast,
    BroadcastDestination,
    BroadcastMoment,
    BroadcastRecording,
    Broadcasts,
    BroadcastScore,
    BroadcastSession,
    BroadcastStats,
    KeyMoment,
    MatchStatus,
    Narrative,
    Output,
    Reel,
)
from kickstream.domain.errors import Refusal

MIN_RECORDING_S = 3.0
MAX_BROADCASTS = 100
MAX_SESSIONS = 50
MAX_RECORDINGS = 50
MAX_MOMENTS = 100
MAX_REELS = 12
MAX_TITLE = 80
MAX_DESCRIPTION = 500
MAX_COMMENTARY = 300
MAX_REASON = 200
CUT_SHORT = "Kickstream stopped while this broadcast was live."
UNFINISHED = "Kickstream stopped before this reel was finished."


class BroadcastError(Refusal):
    """A change the broadcast rules refuse."""


@dataclass(frozen=True)
class BroadcastsState:
    doc: Broadcasts
    # What the live session has seen so far. Not saved: a restart closes the session anyway.
    file_starts: Mapping[str, float] = field(default_factory=dict)  # file destination id -> when it began


def empty_state(ai: bool) -> BroadcastsState:
    return BroadcastsState(doc=Broadcasts(revision=0, server_time=0.0, broadcasts=[], current_id=None, ai=ai))


# --- helpers -----------------------------------------------------------------------------------


def _doc(state: BroadcastsState, /, **changes) -> BroadcastsState:
    return replace(state, doc=state.doc.model_copy(update=changes))


def get(state: BroadcastsState, broadcast_id: str) -> Broadcast:
    for broadcast in state.doc.broadcasts:
        if broadcast.id == broadcast_id:
            return broadcast
    raise BroadcastError(404, "broadcast", "That broadcast no longer exists.")


def find(state: BroadcastsState, broadcast_id: str) -> Broadcast | None:
    return next((b for b in state.doc.broadcasts if b.id == broadcast_id), None)


def live(state: BroadcastsState) -> Broadcast | None:
    return next((b for b in state.doc.broadcasts if b.state == "live"), None)


def _put(state: BroadcastsState, updated: Broadcast) -> BroadcastsState:
    return _doc(state, broadcasts=[updated if b.id == updated.id else b for b in state.doc.broadcasts])


def _change(broadcast: Broadcast, **changes) -> Broadcast:
    return broadcast.model_copy(update=changes)


def _title(title: str) -> str:
    title = " ".join(title.split())
    if not 1 <= len(title) <= MAX_TITLE:
        raise BroadcastError(422, "title", f"A broadcast needs a title of 1 to {MAX_TITLE} characters.")
    return title


def _description(description: str) -> str:
    description = description.strip()
    if len(description) > MAX_DESCRIPTION:
        raise BroadcastError(422, "description", f"A description is at most {MAX_DESCRIPTION} characters.")
    return description


def _new(broadcast_id: str, title: str, description: str, record: bool, now: float) -> Broadcast:
    return Broadcast(
        id=broadcast_id,
        title=title,
        description=description,
        record=record,
        state="ready",
        created_at=now,
        sessions=[],
        recordings=[],
        moments=[],
        stats=BroadcastStats(live_s=0.0),
        reels=[],
        generating=False,
    )


def untitled(now: float) -> str:
    """The name of a broadcast made because the stream went live without one."""
    return "Broadcast · " + datetime.fromtimestamp(now).strftime("%d %b %H:%M")


# --- what the streamer does -------------------------------------------------------------------


def create(
    state: BroadcastsState, broadcast_id: str, title: str, description: str, record: bool, now: float
) -> BroadcastsState:
    """A new broadcast, ready to go live, and the one Go live starts."""
    if len(state.doc.broadcasts) >= MAX_BROADCASTS:
        raise BroadcastError(
            409, "broadcasts", f"There can be at most {MAX_BROADCASTS} broadcasts. Delete an old one first."
        )
    broadcast = _new(broadcast_id, _title(title), _description(description), record, now)
    current = live(state)
    return _doc(
        state,
        broadcasts=[broadcast, *state.doc.broadcasts],
        # A broadcast on air stays current until it ends.
        current_id=state.doc.current_id if current is not None else broadcast.id,
    )


def edit(state: BroadcastsState, broadcast_id: str, title: str, description: str) -> BroadcastsState:
    current = get(state, broadcast_id)
    return _put(state, _change(current, title=_title(title), description=_description(description)))


def delete(state: BroadcastsState, broadcast_id: str) -> BroadcastsState:
    current = get(state, broadcast_id)
    if current.state == "live":
        raise BroadcastError(409, "broadcast", "End the broadcast before deleting it.")
    if current.generating:
        raise BroadcastError(409, "broadcast", "Wait for its reels to finish before deleting it.")
    remaining = [b for b in state.doc.broadcasts if b.id != broadcast_id]
    current_id = None if state.doc.current_id == broadcast_id else state.doc.current_id
    return _doc(state, broadcasts=remaining, current_id=current_id)


def select(state: BroadcastsState, broadcast_id: str) -> BroadcastsState:
    """Make a broadcast the one the next stream belongs to."""
    chosen = get(state, broadcast_id)
    if chosen.state == "ended":
        raise BroadcastError(409, "broadcast", "This broadcast has ended. Create a new one to go live again.")
    on_air = live(state)
    if on_air is not None and on_air.id != broadcast_id:
        raise BroadcastError(409, "broadcast", f"“{on_air.title}” is live. End it first.")
    return _doc(state, current_id=broadcast_id)


def end(state: BroadcastsState, broadcast_id: str, now: float) -> BroadcastsState:
    """The streamer is done with this broadcast. A session still open is closed now.

    A broadcast that never got on air stays ready: ending it only gave up on going live.
    """
    current = get(state, broadcast_id)
    if current.state == "ended" or not current.sessions:
        return state
    state = _close(state, current, now, None, final=True)
    return _doc(state, current_id=None if state.doc.current_id == broadcast_id else state.doc.current_id)


# --- following the output ---------------------------------------------------------------------


def _open(state: BroadcastsState, output: Output, now: float, new_id: str) -> BroadcastsState:
    target = find(state, state.doc.current_id) if state.doc.current_id else None
    if target is None or target.state != "ready":
        state = create(state, new_id, untitled(now), "", False, now)
        target = get(state, new_id)
    session = BroadcastSession(
        started_at=output.started_at or now,
        destinations=[
            BroadcastDestination(id=d.id, name=d.name, platform=d.platform, outcome="off")
            for d in output.destinations
            if d.enabled
        ],
    )
    sessions = [*target.sessions, session][-MAX_SESSIONS:]
    state = _put(state, _change(target, state="live", sessions=sessions, problem=None))
    return replace(_doc(state, current_id=target.id), file_starts={})


def _close(
    state: BroadcastsState, broadcast: Broadcast, now: float, problem: str | None, *, final: bool
) -> BroadcastsState:
    sessions = list(broadcast.sessions)
    live_s = broadcast.stats.live_s
    if sessions and sessions[-1].ended_at is None:
        last = sessions[-1]
        ended_at = max(now, last.started_at)
        live_s += ended_at - last.started_at
        sessions[-1] = last.model_copy(update={"ended_at": ended_at, "problem": _reason(problem)})
    stats = broadcast.stats.model_copy(update={"live_s": live_s})
    closed = _change(
        broadcast,
        state="ended" if final else "ready",
        sessions=sessions,
        stats=stats,
        problem=_reason(problem),
    )
    return replace(_put(state, closed), file_starts={})


def _reason(text: str | None) -> str | None:
    return text[:MAX_REASON] if text else None


def _recording_start(file: str, starts: Mapping[str, float], fallback: float) -> float:
    """File destinations name their recordings `<time>-<destination id>.mp4`."""
    stem = file.rsplit(".", 1)[0]
    destination_id = stem.rsplit("-", 1)[-1]
    return starts.get(destination_id, fallback)


def _follow(state: BroadcastsState, broadcast: Broadcast, output: Output) -> BroadcastsState:
    """Bring the open session up to date: how each destination fares, and new recordings."""
    session = broadcast.sessions[-1]
    status = {d.id: d for d in output.destinations}
    destinations = []
    for kept in session.destinations:
        now_ = status.get(kept.id)
        if now_ is not None and now_.status == "live":
            kept = kept.model_copy(update={"outcome": "live", "reason": None})
        elif now_ is not None and now_.status == "failed" and kept.outcome != "live":
            kept = kept.model_copy(update={"outcome": "failed", "reason": _reason(now_.reason)})
        destinations.append(kept)
    starts = dict(state.file_starts)
    for destination in output.destinations:
        if destination.platform == "file" and destination.live_since is not None:
            starts[destination.id] = destination.live_since
    known = {recording.file for b in state.doc.broadcasts for recording in b.recordings}
    added = [
        BroadcastRecording(
            file=recording.file,
            size_bytes=recording.size_bytes,
            started_at=_recording_start(recording.file, starts, session.started_at),
            made_at=recording.made_at,
        )
        for recording in reversed(output.recordings)  # the output lists the newest first
        if recording.file not in known and recording.made_at >= session.started_at
    ]
    sessions = [*broadcast.sessions[:-1], session.model_copy(update={"destinations": destinations})]
    recordings = [*broadcast.recordings, *added][-MAX_RECORDINGS:]
    updated = _change(broadcast, sessions=sessions, recordings=recordings)
    if updated == broadcast and starts == state.file_starts:
        return state
    return replace(_put(state, updated), file_starts=starts)


def observe_output(state: BroadcastsState, output: Output, now: float, new_id: str) -> BroadcastsState:
    """Sessions follow the output, whoever started it. `new_id` names a broadcast made for an unplanned stream."""
    on_air = live(state)
    if output.state == "live" and on_air is None:
        state = _open(state, output, now, new_id)
        on_air = live(state)
    if on_air is None:
        return state
    state = _follow(state, on_air, output)
    if output.state == "idle":
        state = _close(state, get(state, on_air.id), now, output.problem, final=False)
    return state


# --- following the match ----------------------------------------------------------------------


def observe_status(state: BroadcastsState, status: MatchStatus) -> BroadcastsState:
    on_air = live(state)
    if on_air is None:
        return state
    score = BroadcastScore(
        home=status.home.name,
        away=status.away.name,
        score_home=status.score_home,
        score_away=status.score_away,
    )
    if score == on_air.stats.score:
        return state
    return _put(state, _change(on_air, stats=on_air.stats.model_copy(update={"score": score})))


def observe_moment(state: BroadcastsState, moment: KeyMoment, now: float) -> BroadcastsState:
    on_air = live(state)
    if on_air is None or any(kept.id == moment.id for kept in on_air.moments):
        return state
    added = BroadcastMoment(
        id=moment.id,
        kind=moment.kind,
        team=moment.team,
        minute=moment.minute,
        at=now,
        score_home=moment.score_home,
        score_away=moment.score_away,
    )
    return _put(state, _change(on_air, moments=[*on_air.moments, added][-MAX_MOMENTS:]))


def observe_narrative(state: BroadcastsState, narrative: Narrative) -> BroadcastsState:
    """The fan commentary on a moment the broadcast kept, which arrives a little after it."""
    if (narrative.mode, narrative.language) != ("fan", "en"):
        return state
    for broadcast in state.doc.broadcasts:
        for index, moment in enumerate(broadcast.moments):
            if moment.id == narrative.moment_id and moment.commentary is None:
                moments = list(broadcast.moments)
                moments[index] = moment.model_copy(update={"commentary": narrative.text[:MAX_COMMENTARY]})
                return _put(state, _change(broadcast, moments=moments))
    return state


# --- reels ------------------------------------------------------------------------------------


def begin_reels(state: BroadcastsState, broadcast_id: str) -> BroadcastsState:
    current = get(state, broadcast_id)
    if current.state == "live":
        raise BroadcastError(409, "reels", "Reels are made once the broadcast is off air.")
    recording = latest_recording(current)
    if recording is None:
        raise BroadcastError(409, "reels", "This broadcast has no recording to make reels from.")
    if recording_length(recording) < MIN_RECORDING_S:
        raise BroadcastError(409, "reels", "The recording is too short to make reels from.")
    if current.generating:
        raise BroadcastError(409, "reels", "Reels are already being made.")
    if len(current.reels) >= MAX_REELS:
        raise BroadcastError(409, "reels", f"A broadcast keeps at most {MAX_REELS} reels. Delete some first.")
    return _put(state, _change(current, generating=True))


def room_for_reels(broadcast: Broadcast) -> int:
    return MAX_REELS - len(broadcast.reels)


def add_reel(state: BroadcastsState, broadcast_id: str, reel: Reel) -> BroadcastsState:
    current = get(state, broadcast_id)
    return _put(state, _change(current, reels=[*current.reels, reel][-MAX_REELS:]))


def finish_reel(
    state: BroadcastsState, broadcast_id: str, reel_id: str, size_bytes: int | None, reason: str | None
) -> BroadcastsState:
    current = find(state, broadcast_id)
    if current is None:
        return state
    reels = [
        reel.model_copy(
            update={
                "state": "failed" if reason else "ready",
                "size_bytes": size_bytes,
                "reason": _reason(reason),
            }
        )
        if reel.id == reel_id
        else reel
        for reel in current.reels
    ]
    return _put(state, _change(current, reels=reels))


def end_reels(state: BroadcastsState, broadcast_id: str) -> BroadcastsState:
    current = find(state, broadcast_id)
    if current is None or not current.generating:
        return state
    return _put(state, _change(current, generating=False))


def delete_reel(state: BroadcastsState, broadcast_id: str, reel_id: str) -> BroadcastsState:
    current = get(state, broadcast_id)
    reel = next((r for r in current.reels if r.id == reel_id), None)
    if reel is None:
        raise BroadcastError(404, "reel", "That reel no longer exists.")
    if reel.state == "rendering":
        raise BroadcastError(409, "reel", "Wait for the reel to finish before deleting it.")
    return _put(state, _change(current, reels=[r for r in current.reels if r.id != reel_id]))


# --- views and storage ------------------------------------------------------------------------


def view(state: BroadcastsState, now: float) -> Broadcasts:
    """The document, with the open session's time on air counted up to now."""
    broadcasts = []
    for broadcast in state.doc.broadcasts:
        if broadcast.state == "live" and broadcast.sessions:
            running = max(0.0, now - broadcast.sessions[-1].started_at)
            stats = broadcast.stats.model_copy(update={"live_s": broadcast.stats.live_s + running})
            broadcast = _change(broadcast, stats=stats)
        broadcasts.append(broadcast)
    return state.doc.model_copy(update={"server_time": now, "broadcasts": broadcasts})


def dump(state: BroadcastsState) -> dict:
    return {"doc": state.doc.model_dump(mode="json")}


_FORGOTTEN_STATS = ("polls", "questions")  # kept by versions that had a fan page


def _without_forgotten_stats(raw):
    """A copy without stats older versions kept. Anything misshapen is left for validation to refuse."""
    if not isinstance(raw, dict) or not isinstance(raw.get("broadcasts"), list):
        return raw
    broadcasts = []
    for broadcast in raw["broadcasts"]:
        if isinstance(broadcast, dict) and isinstance(broadcast.get("stats"), dict):
            stats = {k: v for k, v in broadcast["stats"].items() if k not in _FORGOTTEN_STATS}
            broadcast = {**broadcast, "stats": stats}
        broadcasts.append(broadcast)
    return {**raw, "broadcasts": broadcasts}


def load(record: dict, ai: bool) -> BroadcastsState:
    """A saved state, as it should be after a restart: nothing live, nothing being made."""
    doc = Broadcasts.model_validate(_without_forgotten_stats(record["doc"]))
    state = BroadcastsState(doc=doc.model_copy(update={"ai": ai}))
    for broadcast in doc.broadcasts:
        if broadcast.state == "live":
            started = broadcast.sessions[-1].started_at if broadcast.sessions else broadcast.created_at
            state = _close(state, broadcast, started, CUT_SHORT, final=False)
        current = get(state, broadcast.id)
        if current.generating or any(reel.state == "rendering" for reel in current.reels):
            reels = [
                reel.model_copy(update={"state": "failed", "reason": UNFINISHED})
                if reel.state == "rendering"
                else reel
                for reel in current.reels
            ]
            state = _put(state, _change(current, generating=False, reels=reels))
    return state
