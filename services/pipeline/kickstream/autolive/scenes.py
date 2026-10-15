"""The screens auto live rotates through: the match agents' own, and the match, analysis, fan and show screens.

The page draws a header band over the top 96 pixels of the 1920 x 1080 canvas, so screens start below it.
"""

from kickstream.contracts import AutoLiveScene, SceneElement

TOP = 112
TRANSITIONS = ("fade", "slide", "zoom", "wipe", "push", "iris")

_VIEW = {"zoom": 1.0, "turn": 0.0, "tilt": 0.0, "pan_x": 0.0, "pan_y": 0.0}


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


def _pitch3d(
    layer: int, x: int, y: int, width: int, height: int, camera: str = "auto", *, follow_ball: bool = False
) -> SceneElement:
    return _el(layer, "pitch3d", x, y, width, height, camera=camera, follow_ball=follow_ball, **_VIEW)


def _ticker(layer: int) -> SceneElement:
    return _el(layer, "ticker", 0, 1000, 1920, 80)


def _scene(
    id_: str, name: str, kind: str, blurb: str, elements: list[SceneElement], agent: str | None = None
):
    return AutoLiveScene(id=id_, name=name, kind=kind, agent=agent, blurb=blurb, elements=elements)


def auto_scenes() -> list[AutoLiveScene]:
    return [
        _scene(
            "welcome",
            "Welcome",
            "show",
            "The stream's opening card: tonight's teams and the score.",
            [
                _el(1, "text", 160, 190, 1600, 160, text="{home} vs {away}", size=96, align="center"),
                _el(2, "scorecard", 460, 400, 1000, 210),
                _el(
                    3,
                    "text",
                    210,
                    660,
                    1500,
                    120,
                    text="Football around the clock: seven AI agents, live data and live commentary",
                    size=40,
                    align="center",
                ),
                _ticker(4),
            ],
        ),
        _scene(
            "live-match",
            "Live match",
            "match",
            "The match as it happens: pitch, pressure, narration and banners.",
            [
                _el(1, "scoreboard", 40, TOP, 1100, 120),
                _el(2, "pitch", 40, 248, 1100, 736, pressure=True),
                _el(3, "narration", 1180, TOP, 700, 560, lines=4),
                _el(4, "banner", 1180, 688, 700, 296),
                _ticker(5),
            ],
        ),
        _scene(
            "score-centre",
            "Score centre",
            "match",
            "The score with the numbers behind it: shots, xG and possession.",
            [
                _el(1, "scorecard", 360, TOP, 1200, 220),
                _el(2, "chart", 40, 352, 900, 688, metric="overview"),
                _el(3, "graph", 980, 352, 900, 688, metric="xg"),
            ],
        ),
        _scene(
            "stadium-3d",
            "3D stadium",
            "show",
            "The whole pitch in 3D, following the ball.",
            [
                _pitch3d(1, 0, 96, 1920, 984, camera="broadcast", follow_ball=True),
                _el(2, "scorecard", 560, 120, 800, 170),
            ],
        ),
        _scene(
            "pressure-map",
            "Pressure map",
            "analysis",
            "Where each side has been pressing, and how hard.",
            [
                _el(1, "scorecard", 40, TOP, 1840, 180),
                _el(2, "pitch", 40, 312, 1240, 728, pressure=True),
                _el(3, "chart", 1320, 312, 560, 728, metric="tactics"),
            ],
        ),
        _scene(
            "momentum",
            "Momentum swing",
            "analysis",
            "Which side is on top, minute by minute.",
            [
                _el(1, "graph", 40, TOP, 1840, 520, metric="momentum"),
                _el(2, "chart", 40, 652, 600, 388, metric="possession"),
                _el(3, "insight", 680, 652, 1200, 388),
            ],
        ),
        _scene(
            "xg-race",
            "Expected goals race",
            "analysis",
            "Chance quality over the match: who deserves to be ahead.",
            [
                _el(1, "graph", 40, TOP, 1200, 928, metric="xg"),
                _el(2, "chart", 1280, TOP, 600, 450, metric="xg"),
                _el(3, "chart", 1280, 582, 600, 458, metric="shots"),
            ],
        ),
        _scene(
            "win-probability",
            "Win probability",
            "analysis",
            "How the odds of a win, draw or loss have moved.",
            [
                _el(1, "graph", 40, TOP, 1200, 928, metric="win_probability"),
                _el(2, "prediction", 1280, TOP, 600, 300, view="outcome"),
                _el(3, "prediction", 1280, 432, 600, 300, view="next_goal"),
                _el(4, "insight", 1280, 752, 600, 288),
            ],
        ),
        _scene(
            "key-moments",
            "Key moments",
            "match",
            "The goals, chances and swings so far, with their commentary.",
            [
                _el(1, "timeline", 40, TOP, 1840, 300),
                _el(2, "narration", 40, 432, 1100, 608, lines=5),
                _el(3, "insight", 1180, 432, 700, 608),
            ],
        ),
        _scene(
            "analyst-desk",
            "Analyst desk",
            "analysis",
            "The analysts' view: stats, timeline, narration and the pitch.",
            [
                _el(1, "scoreboard", 40, TOP, 900, 120),
                _el(2, "stats", 40, 248, 900, 460),
                _el(3, "timeline", 40, 724, 900, 316),
                _el(4, "narration", 980, TOP, 900, 420, lines=4),
                _el(5, "pitch", 980, 548, 900, 492, pressure=True),
            ],
        ),
        _scene(
            "fan-zone",
            "Fan zone",
            "fans",
            "The audience: comments, the poll and superchats.",
            [
                _el(1, "scorecard", 40, TOP, 900, 200),
                _el(2, "superchat", 40, 332, 900, 300, lines=3),
                _el(3, "pitch", 40, 652, 900, 388, pressure=True),
                _el(4, "comments", 980, TOP, 900, 560, lines=4, liked_only=False),
                _el(5, "poll", 980, 692, 900, 348),
            ],
        ),
        _scene(
            "story-so-far",
            "The story so far",
            "show",
            "The match told in its key lines, beside the full numbers.",
            [
                _el(1, "scoreboard", 400, TOP, 1120, 120),
                _el(2, "narration", 160, 252, 800, 788, lines=6),
                _el(3, "stats", 1000, 252, 760, 788),
            ],
        ),
        _scene(
            "possession",
            "Possession battle",
            "analysis",
            "Who has the ball, and what they do with it.",
            [
                _el(1, "chart", 40, TOP, 700, 928, metric="possession"),
                _el(2, "pitch", 780, TOP, 1100, 600, pressure=True),
                _el(3, "graph", 780, 732, 1100, 308, metric="momentum"),
            ],
        ),
        _scene(
            "headlines",
            "Headlines",
            "show",
            "The latest lines of commentary, with the score.",
            [
                _el(
                    1,
                    "text",
                    160,
                    130,
                    1600,
                    120,
                    text="Kickstream Live: {home} vs {away}",
                    size=64,
                    align="center",
                ),
                _el(2, "narration", 160, 280, 1600, 520, lines=3),
                _el(3, "scorecard", 460, 820, 1000, 160),
                _ticker(4),
            ],
        ),
        _scene(
            "agent-interpreter",
            "Event Interpreter",
            "agent",
            "Turns every detection into a structured event: third, flank, phase and danger.",
            [
                _el(1, "pitch", 40, TOP, 1200, 700, pressure=False),
                _el(2, "narration", 1280, TOP, 600, 700, lines=4),
                _el(3, "timeline", 40, 832, 1840, 208),
            ],
            agent="interpreter",
        ),
        _scene(
            "agent-tactics",
            "Tactical Analyst",
            "agent",
            "Each side's pressure, tempo and field tilt, and the patterns they play.",
            [
                _el(1, "chart", 40, TOP, 760, 560, metric="tactics"),
                _pitch3d(2, 840, TOP, 1040, 560, camera="tactical"),
                _el(3, "graph", 40, 692, 1100, 348, metric="momentum"),
                _el(4, "insight", 1180, 692, 700, 348),
            ],
            agent="tactics",
        ),
        _scene(
            "agent-prediction",
            "Prediction Agent",
            "agent",
            "Win, draw and loss, the next goal, and what the side on the ball does next.",
            [
                _el(1, "prediction", 40, TOP, 900, 260, view="outcome"),
                _el(2, "prediction", 980, TOP, 900, 260, view="next_goal"),
                _el(3, "prediction", 40, 392, 900, 648, view="next_action"),
                _el(4, "graph", 980, 392, 900, 648, metric="win_probability"),
            ],
            agent="prediction",
        ),
        _scene(
            "agent-explainability",
            "Explainability Agent",
            "agent",
            "Why it matters: what the patterns and the odds mean, in plain words.",
            [
                _el(1, "scorecard", 40, TOP, 1840, 180),
                _el(2, "insight", 40, 312, 1200, 728),
                _el(3, "narration", 1280, 312, 600, 728, lines=4),
            ],
            agent="explainability",
        ),
        _scene(
            "agent-visualization",
            "Visualization Agent",
            "agent",
            "The 3D pitch: the ball's flight, the players, danger and passing lanes.",
            [
                _pitch3d(1, 40, TOP, 1840, 928, follow_ball=True),
                _el(2, "scoreboard", 410, 136, 1100, 110),
            ],
            agent="visualization",
        ),
        _scene(
            "agent-tracking",
            "Player Tracking Agent",
            "agent",
            "The best player so far: touches, passing, shots, rating and heat map.",
            [
                _el(1, "player", 40, TOP, 900, 928, player_id=None),
                _pitch3d(2, 980, TOP, 900, 560),
                _el(3, "chart", 980, 692, 900, 348, metric="overview"),
            ],
            agent="tracking",
        ),
        _scene(
            "agent-highlights",
            "Highlights Agent",
            "agent",
            "The key moments ranked, and the hidden ones a scoreline never shows.",
            [
                _el(1, "timeline", 40, TOP, 1840, 280),
                _el(2, "insight", 40, 412, 900, 628),
                _el(3, "narration", 980, 412, 900, 628, lines=4),
            ],
            agent="highlights",
        ),
        _scene(
            "agent-squad",
            "Seven agents at work",
            "agent",
            "Every match agent's latest finding on one screen.",
            [
                _el(1, "chart", 40, TOP, 600, 454, metric="tactics"),
                _el(2, "prediction", 660, TOP, 600, 454, view="outcome"),
                _el(3, "insight", 1280, TOP, 600, 454),
                _el(4, "player", 40, 586, 600, 454, player_id=None),
                _el(5, "graph", 660, 586, 600, 454, metric="momentum"),
                _pitch3d(6, 1280, 586, 600, 454),
            ],
        ),
    ]


SCENE_IDS = tuple(scene.id for scene in auto_scenes())
