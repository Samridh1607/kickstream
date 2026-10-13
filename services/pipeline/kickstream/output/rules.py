"""Every rule for destinations and for what a run may do.

Each rule takes a state and returns a new one; none mutates its argument. Time is passed in.
A broken limit raises `OutputError`. Stream keys live beside the document, never in it.
"""

import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from kickstream.contracts import Destination, Output, Recording
from kickstream.domain.errors import Refusal
from kickstream.ports.output import Quality, Target

MAX_DESTINATIONS = 10
MAX_RECORDINGS = 20
MAX_FAILURES = 10  # in a row, with no time live between them
MAX_REASON = 200
_RETRY_DELAYS_S = (2, 4, 8, 16, 30)
_HINT = 4
QUALITIES = {"720p30": Quality(1280, 720, 3000), "1080p30": Quality(1920, 1080, 6000)}
# X gives each account its own address, so it has no default.
DEFAULT_URLS = {
    "youtube": "rtmp://a.rtmp.youtube.com/live2",
    "facebook": "rtmps://live-api-s.facebook.com:443/rtmp/",
    "twitch": "rtmp://live.twitch.tv/app",
}


class OutputError(Refusal):
    """A change the output rules refuse."""


@dataclass(frozen=True)
class OutputState:
    doc: Output
    keys: Mapping[str, str] = field(default_factory=dict)  # destination id -> stream key


def empty_state() -> OutputState:
    return OutputState(
        doc=Output(
            revision=0, server_time=0.0, destinations=[], quality="720p30", state="idle", recordings=[]
        )
    )


def _doc(state: OutputState, /, **changes) -> OutputState:
    return replace(state, doc=state.doc.model_copy(update=changes))


def _editable(state: OutputState) -> None:
    if state.doc.state != "idle":
        raise OutputError(409, "output", "Stop the stream before changing this.")


def _find(state: OutputState, destination_id: str) -> Destination:
    for destination in state.doc.destinations:
        if destination.id == destination_id:
            return destination
    raise OutputError(404, "destination", "That destination no longer exists.")


def _swap(state: OutputState, updated: Destination) -> OutputState:
    return _doc(state, destinations=[updated if d.id == updated.id else d for d in state.doc.destinations])


def _name(name: str) -> str:
    name = " ".join(name.split())
    if not 1 <= len(name) <= 40:
        raise OutputError(422, "name", "A destination needs a name of 1 to 40 characters.")
    return name


def _url(platform: str, url: str) -> str:
    if platform == "file":
        return ""
    url = url.strip() or DEFAULT_URLS.get(platform, "")
    if not url:
        raise OutputError(422, "url", "Enter the server address the platform gives you.")
    try:
        parts = urlsplit(url)
        scheme, host = parts.scheme, parts.hostname
    except ValueError:
        scheme, host = "", None
    if len(url) > 300 or any(c.isspace() for c in url) or scheme not in ("rtmp", "rtmps") or not host:
        raise OutputError(422, "url", "A server address begins with rtmp:// or rtmps:// and names a host.")
    return url


def _key(key: str) -> str:
    key = key.strip()  # a pasted key often brings a line break with it
    if not 1 <= len(key) <= 300 or any(c.isspace() for c in key):
        raise OutputError(422, "key", "A stream key is 1 to 300 characters with no spaces.")
    return key


def _hint(key: str) -> str:
    """The end of a key, to tell keys apart. A short key would be mostly given away, so it shows nothing."""
    return key[-_HINT:] if len(key) > 2 * _HINT else ""


# --- destinations ------------------------------------------------------------------------------


def add_destination(state: OutputState, name: str, platform: str, url: str, key: str) -> OutputState:
    _editable(state)
    if len(state.doc.destinations) >= MAX_DESTINATIONS:
        raise OutputError(409, "destinations", f"There can be at most {MAX_DESTINATIONS} destinations.")
    key = "" if platform == "file" else _key(key)
    destination = Destination(
        id=uuid.uuid4().hex[:8],
        name=_name(name),
        platform=platform,
        url=_url(platform, url),
        enabled=True,
        key_hint=_hint(key),
        status="idle",
    )
    keys = {**state.keys, destination.id: key} if key else state.keys
    return replace(_doc(state, destinations=[*state.doc.destinations, destination]), keys=keys)


def edit_destination(
    state: OutputState, destination_id: str, *, name: str, url: str, enabled: bool, key: str | None = None
) -> OutputState:
    _editable(state)
    current = _find(state, destination_id)
    changes: dict = {"name": _name(name), "url": _url(current.platform, url), "enabled": enabled}
    keys = state.keys
    if key is not None and current.platform != "file":
        key = _key(key)
        keys = {**state.keys, destination_id: key}
        changes["key_hint"] = _hint(key)
    return replace(_swap(state, current.model_copy(update=changes)), keys=keys)


def remove_destination(state: OutputState, destination_id: str) -> OutputState:
    _editable(state)
    _find(state, destination_id)
    remaining = [d for d in state.doc.destinations if d.id != destination_id]
    keys = {held: key for held, key in state.keys.items() if held != destination_id}
    return replace(_doc(state, destinations=remaining), keys=keys)


def set_quality(state: OutputState, quality: str) -> OutputState:
    _editable(state)
    if quality not in QUALITIES:
        raise OutputError(422, "quality", "Choose 720p30 or 1080p30.")
    return _doc(state, quality=quality)


# --- a run -------------------------------------------------------------------------------------


def _reset(destination: Destination, status: str) -> Destination:
    return destination.model_copy(update={"status": status, "reason": None, "live_since": None})


def begin(state: OutputState) -> OutputState:
    if state.doc.state != "idle":
        raise OutputError(409, "output", "The stream is already running.")
    enabled = [d for d in state.doc.destinations if d.enabled]
    if not enabled:
        raise OutputError(409, "destinations", "Turn on at least one destination first.")
    for destination in enabled:
        if destination.platform != "file" and destination.id not in state.keys:
            raise OutputError(
                409, "key", f"{destination.name} has no stream key. Add it again, or turn it off."
            )
    return restarting(_doc(state, problem=None))


def restarting(state: OutputState) -> OutputState:
    """Back to the beginning of a run: nothing is live until the encoder produces video again."""
    destinations = [_reset(d, "connecting" if d.enabled else "idle") for d in state.doc.destinations]
    return _doc(state, destinations=destinations, state="starting", started_at=None)


def went_live(state: OutputState, now: float) -> OutputState:
    return _doc(state, state="live", started_at=now) if state.doc.state == "starting" else state


def stopping(state: OutputState) -> OutputState:
    return _doc(state, state="stopping") if state.doc.state in ("starting", "live") else state


def finish(state: OutputState, problem: str | None) -> OutputState:
    """The run is over. A destination that failed keeps saying why until the next run."""
    destinations = [d if d.status == "failed" else _reset(d, "idle") for d in state.doc.destinations]
    return _doc(state, destinations=destinations, state="idle", started_at=None, problem=problem)


def mark(
    state: OutputState, destination_id: str, status: str, reason: str | None = None, now: float | None = None
) -> OutputState:
    current = next((d for d in state.doc.destinations if d.id == destination_id), None)
    if current is None:
        return state
    live_since = now if status == "live" else current.live_since
    return _swap(
        state, current.model_copy(update={"status": status, "reason": reason, "live_since": live_since})
    )


def add_recording(state: OutputState, file: str, size_bytes: int, now: float) -> OutputState:
    recording = Recording(file=file, size_bytes=size_bytes, made_at=now)
    return _doc(state, recordings=[recording, *state.doc.recordings][:MAX_RECORDINGS])


def retry_delay(failures: int) -> int:
    """Seconds to wait before the next try, after that many failures in a row."""
    return _RETRY_DELAYS_S[min(max(failures, 1), len(_RETRY_DELAYS_S)) - 1]


def redact(text: str, key: str) -> str:
    """A sender's last words, safe to show: the key removed, and no longer than a line."""
    if key:
        text = text.replace(key, "…")
    return text[:MAX_REASON]


def target_for(destination: Destination, key: str, recordings_dir: Path, now: float) -> Target:
    if destination.platform == "file":
        name = datetime.fromtimestamp(now).strftime("%Y-%m-%d-%H%M%S") + ".mp4"
        return Target("file", str(recordings_dir / name))
    return Target("rtmp", f"{destination.url.rstrip('/')}/{key}")


# --- views and storage ---------------------------------------------------------------------------


def view(state: OutputState, now: float) -> Output:
    return state.doc.model_copy(update={"server_time": now})


def dump(state: OutputState) -> dict:
    return {"doc": state.doc.model_dump(mode="json")}


def dump_keys(state: OutputState) -> dict:
    return {"keys": dict(state.keys)}


def load(record: dict, keys_record: dict | None) -> OutputState:
    """A saved state, as it should be after a restart: nothing running, nothing live."""
    doc = Output.model_validate(record["doc"])
    saved = (keys_record or {}).get("keys", {})
    saved = saved if isinstance(saved, dict) else {}
    ids = {d.id for d in doc.destinations}
    keys = {held: key for held, key in saved.items() if held in ids and isinstance(key, str) and key}
    destinations = [
        _reset(d, "idle").model_copy(update={"key_hint": d.key_hint if d.id in keys else ""})
        for d in doc.destinations
    ]
    doc = doc.model_copy(
        update={"destinations": destinations, "state": "idle", "started_at": None, "problem": None}
    )
    return OutputState(doc=doc, keys=keys)
