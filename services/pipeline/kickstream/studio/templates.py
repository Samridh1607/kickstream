"""The built-in scene templates and the studio a new installation starts with."""

from kickstream.contracts import Scene, SceneElement, Studio, StudioSettings, Ticker

CANVAS_W = 1920
CANVAS_H = 1080

STARTING_SOON = "Starting soon"
LIVE_MATCH = "Live match"
ANALYST_DESK = "Analyst desk"
BREAK = "Break"
FULL_TIME = "Full-time"
INTERVIEW = "Interview"
MATCH_INTELLIGENCE = "Match intelligence"
FAN_ZONE = "Fan zone"
PITCH_3D = "3D pitch"
# Offered for new scenes, but not in the studio a new installation starts with.
EXTRAS = frozenset({INTERVIEW, MATCH_INTELLIGENCE, FAN_ZONE, PITCH_3D})

# Whose commentary each built-in scene carries; the others follow the studio's mode.
TEMPLATE_MODES = {LIVE_MATCH: "fan", ANALYST_DESK: "analyst", MATCH_INTELLIGENCE: "analyst", FAN_ZONE: "fan"}


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


PITCH_VIEW = {
    "camera": "auto",
    "zoom": 1.0,
    "turn": 0.0,
    "tilt": 0.0,
    "pan_x": 0.0,
    "pan_y": 0.0,
    "follow_ball": False,
}


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
        INTERVIEW: [
            _el(1, "cameras", 40, 40, 1840, 820, names=True),
            _el(2, "scoreboard", 410, 880, 1100, 120),
        ],
        MATCH_INTELLIGENCE: [
            _el(1, "scorecard", 40, 40, 900, 200),
            _el(2, "pitch3d", 40, 260, 900, 560, **PITCH_VIEW),
            _el(3, "graph", 40, 840, 900, 200, metric="momentum"),
            _el(4, "prediction", 980, 40, 900, 260, view="outcome"),
            _el(5, "insight", 980, 320, 900, 300),
            _el(6, "chart", 980, 640, 440, 400, metric="overview"),
            _el(7, "player", 1440, 640, 440, 400, player_id=None),
        ],
        FAN_ZONE: [
            _el(1, "scorecard", 40, 40, 900, 200),
            _el(2, "pitch", 40, 260, 900, 540, pressure=True),
            _el(3, "comments", 980, 40, 900, 470, lines=4, liked_only=False),
            _el(4, "poll", 980, 530, 900, 350),
            _el(5, "superchat", 40, 820, 900, 240, lines=2),
            _el(6, "spotlight", 980, 900, 900, 160),
        ],
        PITCH_3D: [
            _el(1, "pitch3d", 0, 0, CANVAS_W, CANVAS_H, **PITCH_VIEW),
            _el(2, "scoreboard", 410, 32, 1100, 120),
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
    starting = [template for template in builtin_templates() if template.name not in EXTRAS]
    scenes = [template.model_copy(update={"id": f"scene-{n}"}) for n, template in enumerate(starting, 1)]
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
