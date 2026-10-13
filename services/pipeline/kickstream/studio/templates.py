"""The built-in scene templates and the studio a new installation starts with."""

from kickstream.contracts import Scene, SceneElement, Studio, StudioSettings, Ticker

CANVAS_W = 1920
CANVAS_H = 1080

STARTING_SOON = "Starting soon"
LIVE_MATCH = "Live match"
ANALYST_DESK = "Analyst desk"
BREAK = "Break"
FULL_TIME = "Full-time"

# Whose commentary each built-in scene carries; the others follow the studio's mode.
TEMPLATE_MODES = {LIVE_MATCH: "fan", ANALYST_DESK: "analyst"}


def _el(layer: int, type_: str, x: int, y: int, width: int, height: int, **props) -> SceneElement:
    return SceneElement(
        id=f"e{layer}",
        type=type_,
        x=x,
        y=y,
        width=width,
        height=height,
        layer=layer,
        visible=True,
        props=props,
    )


def _title(layer: int, text: str, y: int, size: int) -> SceneElement:
    return _el(layer, "text", 360, y, 1200, 160, text=text, size=size, align="center")


def builtin_templates() -> list[Scene]:
    layouts = {
        STARTING_SOON: [
            _title(1, "Kick-off soon", 160, 96),
            _el(2, "countdown", 660, 380, 600, 260),
            _title(3, "Northbridge FC vs Harbour City", 700, 56),
            _el(4, "ticker", 0, 1000, 1920, 80),
        ],
        LIVE_MATCH: [
            _el(1, "scoreboard", 40, 40, 1100, 120),
            _el(2, "pitch", 40, 180, 1100, 700, pressure=True),
            _el(3, "narration", 1180, 40, 700, 620, lines=4),
            _el(4, "banner", 1180, 680, 700, 200),
            _el(5, "ticker", 0, 1000, 1920, 80),
        ],
        ANALYST_DESK: [
            _el(1, "scoreboard", 40, 40, 900, 120),
            _el(2, "stats", 40, 180, 900, 420),
            _el(3, "timeline", 40, 620, 900, 140),
            _el(4, "narration", 980, 40, 900, 420, lines=4),
            _el(5, "pitch", 980, 480, 900, 560, pressure=True),
            _el(6, "banner", 40, 780, 900, 180),
        ],
        BREAK: [
            _title(1, "Back soon", 100, 96),
            _el(2, "countdown", 660, 280, 600, 220),
            _el(3, "recap", 460, 520, 1000, 440),
            _el(4, "ticker", 0, 1000, 1920, 80),
        ],
        FULL_TIME: [
            _el(1, "scoreboard", 400, 40, 1120, 120),
            _el(2, "recap", 160, 200, 800, 560),
            _el(3, "stats", 1000, 200, 760, 560),
            _el(4, "banner", 400, 800, 1120, 180),
        ],
    }
    return [
        Scene(
            id=f"builtin-{name.lower().replace(' ', '-')}",
            name=name,
            template=name,
            mode=TEMPLATE_MODES.get(name),
            elements=elements,
        )
        for name, elements in layouts.items()
    ]


def default_studio() -> Studio:
    scenes = [
        template.model_copy(update={"id": f"scene-{n}"}) for n, template in enumerate(builtin_templates(), 1)
    ]
    return Studio(
        revision=0,
        server_time=0.0,
        scenes=scenes,
        active_scene_id=scenes[0].id,
        templates=[],
        settings=StudioSettings(
            mode="fan", language="en", auto_banner=True, auto_start=True, auto_half_time_break=False
        ),
        banner_queue=[],
        ticker=Ticker(enabled=True, speed=120, messages=[], show_score=True, show_stats=True),
    )
