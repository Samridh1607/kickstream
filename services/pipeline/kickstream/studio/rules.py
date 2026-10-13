"""Every rule for changing the studio document.

Each rule takes a document and returns a new one; none mutates its argument. Time is passed
in, so the rules can be tested without a clock. A broken limit raises `StudioError`.
"""

import typing
import uuid

from kickstream.contracts import (
    Banner,
    Countdown,
    KeyMoment,
    Replay,
    Scene,
    SceneElement,
    Studio,
    StudioSettings,
    Ticker,
)
from kickstream.domain.errors import Refusal
from kickstream.studio.templates import (
    BREAK,
    CANVAS_H,
    CANVAS_W,
    LIVE_MATCH,
    STARTING_SOON,
    TEMPLATE_MODES,
    builtin_templates,
)

MAX_SCENES = 20
MAX_TEMPLATES = 20
MAX_ELEMENTS = 40
MAX_QUEUE = 10
MAX_TICKER_MESSAGE = 120
MIN_SIZE = 40
MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_START_AHEAD_S = 24 * 3600
REPLAY_SECONDS = 8.0
REPLAY_WINDOW_SECONDS = 20  # match time shown by a replay, ending at the moment
DEFAULT_BANNER_SECONDS = 8
HALF_TIME_BREAK_MINUTES = 2
CHART_METRICS = ("overview", "possession", "shots", "xg", "tactics")
GRAPH_METRICS = ("momentum", "xg", "win_probability")
PREDICTION_VIEWS = ("outcome", "next_goal", "next_action")
PITCH_CAMERAS = ("auto", "broadcast", "tactical")
ELEMENT_TYPES = frozenset(typing.get_args(SceneElement.model_fields["type"].annotation))


class StudioError(Refusal):
    """A change the studio refuses."""


def new_id() -> str:
    return uuid.uuid4().hex[:8]


def _with(doc: Studio, **changes) -> Studio:
    return doc.model_copy(update=changes)


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


# --- elements ----------------------------------------------------------------------------------


def _int_prop(props: dict, key: str, default: int, low: int, high: int) -> int:
    value = props.get(key, default)
    return _clamp(value, low, high) if isinstance(value, int) and not isinstance(value, bool) else default


def _choice_prop(props: dict, key: str, default: str, choices: tuple[str, ...]) -> str:
    value = props.get(key, default)
    return value if value in choices else default


def _normalize_props(type_: str, props: dict) -> dict:
    """Keep only the properties this element type uses, each within its range."""
    if type_ == "pitch":
        return {"pressure": props.get("pressure", True) is not False}
    if type_ == "narration":
        return {"lines": _int_prop(props, "lines", 3, 1, 6)}
    if type_ == "text":
        text = props.get("text", "")
        text = text if isinstance(text, str) else ""
        if len(text) > 200:
            raise StudioError(422, "props.text", "Text can be at most 200 characters.")
        return {
            "text": text,
            "size": _int_prop(props, "size", 48, 12, 200),
            "align": _choice_prop(props, "align", "center", ("left", "center", "right")),
        }
    if type_ == "image":
        image_id = props.get("image_id")
        return {
            "image_id": image_id if isinstance(image_id, str) else None,
            "fit": _choice_prop(props, "fit", "contain", ("contain", "cover")),
        }
    if type_ == "cameras":
        return {"names": props.get("names", True) is not False}
    if type_ == "chart":
        return {"metric": _choice_prop(props, "metric", "overview", CHART_METRICS)}
    if type_ == "graph":
        return {"metric": _choice_prop(props, "metric", "momentum", GRAPH_METRICS)}
    if type_ == "prediction":
        return {"view": _choice_prop(props, "view", "outcome", PREDICTION_VIEWS)}
    if type_ == "pitch3d":
        return {"camera": _choice_prop(props, "camera", "auto", PITCH_CAMERAS)}
    if type_ == "player":
        player_id = props.get("player_id")
        return {"player_id": player_id[:64] if isinstance(player_id, str) and player_id else None}
    if type_ == "comments":
        return {"lines": _int_prop(props, "lines", 4, 1, 8), "liked_only": props.get("liked_only") is True}
    if type_ == "superchat":
        return {"lines": _int_prop(props, "lines", 3, 1, 6)}
    return {}


def normalize_element(element: SceneElement) -> SceneElement:
    width = _clamp(element.width, MIN_SIZE, CANVAS_W)
    height = _clamp(element.height, MIN_SIZE, CANVAS_H)
    return element.model_copy(
        update={
            "width": width,
            "height": height,
            "x": _clamp(element.x, 0, CANVAS_W - width),
            "y": _clamp(element.y, 0, CANVAS_H - height),
            "props": _normalize_props(element.type, element.props),
        }
    )


# --- scenes and templates ----------------------------------------------------------------------


def _find(scenes: list[Scene], scene_id: str, field: str) -> Scene:
    for scene in scenes:
        if scene.id == scene_id:
            return scene
    raise StudioError(404, field, f"There is no {field} with the ID {scene_id}.")


def _first_from(doc: Studio, template: str) -> str | None:
    return next((scene.id for scene in doc.scenes if scene.template == template), None)


def _checked_name(name: str) -> str:
    name = name.strip()
    if not 1 <= len(name) <= 60:
        raise StudioError(422, "name", "A scene name must be 1 to 60 characters.")
    return name


def create_scene(doc: Studio, source: str, ref: str, name: str | None = None) -> Studio:
    if len(doc.scenes) >= MAX_SCENES:
        raise StudioError(422, "scenes", f"A studio can hold at most {MAX_SCENES} scenes.")
    if source == "builtin":
        origin = next((template for template in builtin_templates() if template.name == ref), None)
    elif source == "template":
        origin = next((template for template in doc.templates if template.id == ref), None)
    else:
        origin = next((scene for scene in doc.scenes if scene.id == ref), None)
    if origin is None:
        raise StudioError(404, "ref", f"There is no {source} called {ref}.")
    default_name = f"{origin.name} copy"[:60] if source == "scene" else origin.name
    scene = Scene(
        id=new_id(),
        name=_checked_name(name or default_name),
        template=origin.template,
        mode=origin.mode,
        # Fresh element IDs: a selection or drag is keyed by element ID, and IDs shared between
        # scenes would let it land on another scene's element.
        elements=[element.model_copy(update={"id": new_id()}) for element in origin.elements],
    )
    return _with(doc, scenes=[*doc.scenes, scene])


def replace_scene(doc: Studio, scene_id: str, name: str, elements: list[SceneElement]) -> Studio:
    current = _find(doc.scenes, scene_id, "scene")
    if len(elements) > MAX_ELEMENTS:
        raise StudioError(422, "elements", f"A scene can hold at most {MAX_ELEMENTS} elements.")
    if len({element.id for element in elements}) != len(elements):
        raise StudioError(422, "elements", "Element IDs must be unique within a scene.")
    updated = current.model_copy(
        update={"name": _checked_name(name), "elements": [normalize_element(element) for element in elements]}
    )
    return _with(doc, scenes=[updated if scene.id == scene_id else scene for scene in doc.scenes])


def set_scene_mode(doc: Studio, scene_id: str, mode: str | None) -> Studio:
    current = _find(doc.scenes, scene_id, "scene")
    updated = current.model_copy(update={"mode": mode})
    return _with(doc, scenes=[updated if scene.id == scene_id else scene for scene in doc.scenes])


def delete_scene(doc: Studio, scene_id: str) -> Studio:
    _find(doc.scenes, scene_id, "scene")
    if scene_id == doc.active_scene_id:
        raise StudioError(409, "scene", "The scene on the program cannot be deleted. Switch scenes first.")
    if len(doc.scenes) == 1:
        raise StudioError(409, "scene", "The last scene cannot be deleted.")
    previous = None if doc.previous_scene_id == scene_id else doc.previous_scene_id
    return _with(
        doc, scenes=[scene for scene in doc.scenes if scene.id != scene_id], previous_scene_id=previous
    )


def activate_scene(doc: Studio, scene_id: str) -> Studio:
    _find(doc.scenes, scene_id, "scene")
    # A scene chosen by hand is where the streamer wants to be, so a running break no longer
    # returns anywhere when it ends.
    return _with(doc, active_scene_id=scene_id, previous_scene_id=None)


def save_template(doc: Studio, scene_id: str, name: str | None = None) -> Studio:
    scene = _find(doc.scenes, scene_id, "scene")
    if len(doc.templates) >= MAX_TEMPLATES:
        raise StudioError(422, "templates", f"A studio can hold at most {MAX_TEMPLATES} saved templates.")
    template = scene.model_copy(update={"id": new_id(), "name": _checked_name(name or scene.name)})
    return _with(doc, templates=[*doc.templates, template])


def delete_template(doc: Studio, template_id: str) -> Studio:
    _find(doc.templates, template_id, "template")
    return _with(doc, templates=[template for template in doc.templates if template.id != template_id])


# --- settings and ticker -----------------------------------------------------------------------


def set_settings(doc: Studio, settings: StudioSettings) -> Studio:
    return _with(doc, settings=settings)


def set_ticker(doc: Studio, ticker: Ticker) -> Studio:
    messages = [message.strip() for message in ticker.messages if message.strip()]
    if any(len(message) > MAX_TICKER_MESSAGE for message in messages):
        raise StudioError(
            422, "messages", f"A ticker message can be at most {MAX_TICKER_MESSAGE} characters."
        )
    return _with(doc, ticker=ticker.model_copy(update={"messages": messages}))


# --- banner ------------------------------------------------------------------------------------


def enqueue_banner(
    doc: Studio, text: str, kind: str, duration_s: int, now: float, source_id: str | None = None
) -> Studio:
    text = text.strip()
    if not 1 <= len(text) <= 200:
        raise StudioError(422, "text", "A banner needs 1 to 200 characters of text.")
    if not 3 <= duration_s <= 30:
        raise StudioError(422, "duration_s", "A banner stays up for 3 to 30 seconds.")
    banner = Banner(id=new_id(), text=text, kind=kind, duration_s=duration_s, source_id=source_id)
    if doc.banner is None:
        return _with(doc, banner=banner.model_copy(update={"ends_at": now + duration_s}))
    queue = list(doc.banner_queue)
    if len(queue) >= MAX_QUEUE:
        queue.pop(next((index for index, waiting in enumerate(queue) if waiting.kind != "goal"), 0))
    # Goals go ahead of everything else that is waiting, behind any goals already waiting.
    position = sum(waiting.kind == "goal" for waiting in queue) if kind == "goal" else len(queue)
    queue.insert(position, banner)
    return _with(doc, banner_queue=queue)


def clear_banner(doc: Studio, now: float) -> Studio:
    if not doc.banner_queue:
        return _with(doc, banner=None)
    following, *rest = doc.banner_queue
    return _with(
        doc, banner=following.model_copy(update={"ends_at": now + following.duration_s}), banner_queue=rest
    )


# --- countdown and breaks ----------------------------------------------------------------------


def start_countdown(doc: Studio, starts_at: float, now: float, label: str = "") -> Studio:
    if not now < starts_at <= now + MAX_START_AHEAD_S:
        raise StudioError(422, "starts_at", "The start time must be in the future and within 24 hours.")
    return _with(
        doc,
        countdown=Countdown(kind="start", ends_at=starts_at, label=label[:60]),
        previous_scene_id=None,
        active_scene_id=_first_from(doc, STARTING_SOON) or doc.active_scene_id,
    )


def start_break(doc: Studio, minutes: int, now: float, label: str = "") -> Studio:
    if not 1 <= minutes <= 60:
        raise StudioError(422, "minutes", "A break lasts 1 to 60 minutes.")
    on_break = doc.countdown is not None and doc.countdown.kind == "break"
    return _with(
        doc,
        countdown=Countdown(kind="break", ends_at=now + minutes * 60, label=label[:60]),
        # A break keeps the return point of the break it replaces, unless the streamer cleared
        # that by switching scenes by hand; then this break returns to where they are now.
        previous_scene_id=doc.previous_scene_id
        if on_break and doc.previous_scene_id
        else doc.active_scene_id,
        active_scene_id=_first_from(doc, BREAK) or doc.active_scene_id,
    )


def _back_from_break(doc: Studio) -> Studio:
    remembered = doc.previous_scene_id
    still_there = remembered is not None and any(scene.id == remembered for scene in doc.scenes)
    return _with(
        doc,
        countdown=None,
        previous_scene_id=None,
        active_scene_id=remembered if still_there else doc.active_scene_id,
    )


def end_countdown(doc: Studio) -> Studio:
    if doc.countdown is None:
        return doc
    return _back_from_break(doc) if doc.countdown.kind == "break" else _with(doc, countdown=None)


# --- replay ------------------------------------------------------------------------------------


def start_replay(doc: Studio, moment: KeyMoment, now: float) -> Studio:
    return _with(
        doc,
        replay=Replay(
            match_id=moment.match_id,
            moment_id=moment.id,
            minute=moment.minute,
            started_at=now,
            duration_s=REPLAY_SECONDS,
        ),
    )


def stop_replay(doc: Studio) -> Studio:
    return _with(doc, replay=None)


# --- deadlines ---------------------------------------------------------------------------------


def next_deadline(doc: Studio) -> float | None:
    times = []
    if doc.banner is not None and doc.banner.ends_at is not None:
        times.append(doc.banner.ends_at)
    if doc.countdown is not None:
        times.append(doc.countdown.ends_at)
    if doc.replay is not None:
        times.append(doc.replay.started_at + doc.replay.duration_s)
    return min(times) if times else None


def expire(doc: Studio, now: float) -> tuple[Studio, list[str]]:
    """Settle everything whose time has come. Returns the same object when nothing was due."""
    actions: list[str] = []
    while doc.banner is not None and doc.banner.ends_at is not None and doc.banner.ends_at <= now:
        doc = clear_banner(doc, now)
    if doc.replay is not None and doc.replay.started_at + doc.replay.duration_s <= now:
        doc = stop_replay(doc)
    if doc.countdown is not None and doc.countdown.ends_at <= now:
        if doc.countdown.kind == "break":
            doc = _back_from_break(doc)
        else:
            doc = _with(doc, countdown=None)
            if doc.settings.auto_start:
                actions.append("start_match")
                doc = _with(doc, active_scene_id=_first_from(doc, LIVE_MATCH) or doc.active_scene_id)
    return doc, actions


# --- loading and uploads -----------------------------------------------------------------------


def sanitize_raw(raw: dict) -> dict:
    """Drop elements of a type this version does not know, so a file from another version loads.

    A scene saved before scenes had a mode takes its built-in template's mode.
    """

    def clean(scene: dict) -> dict:
        elements = [element for element in scene.get("elements", []) if element.get("type") in ELEMENT_TYPES]
        mode = scene["mode"] if "mode" in scene else TEMPLATE_MODES.get(scene.get("template"))
        return {**scene, "mode": mode, "elements": elements}

    return {
        **raw,
        "scenes": [clean(scene) for scene in raw.get("scenes", [])],
        "templates": [clean(scene) for scene in raw.get("templates", [])],
    }


def sniff_image(content: bytes) -> str | None:
    """The media type of an upload, judged by its first bytes. None for anything not allowed."""
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp"
    return None
