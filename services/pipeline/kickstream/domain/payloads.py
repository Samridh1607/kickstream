"""The name each match payload goes by in the match log and on the stream."""

from kickstream.contracts import (
    AgentRun,
    Explanation,
    Highlight,
    KeyMoment,
    MatchEvent,
    MatchStatus,
    Narrative,
    Overlay,
    PitchScene,
    PlayerReport,
    PlayEvent,
    Prediction,
    PressureSnapshot,
    Recap,
    StatsSnapshot,
    TacticalInsight,
)

TYPE_NAMES: dict[type, str] = {
    MatchStatus: "match_status",
    MatchEvent: "match_event",
    StatsSnapshot: "stats",
    PressureSnapshot: "pressure",
    KeyMoment: "key_moment",
    Narrative: "narrative",
    Recap: "recap",
    Overlay: "overlay",
    PlayEvent: "play",
    TacticalInsight: "tactics",
    Prediction: "prediction",
    Explanation: "explanation",
    PitchScene: "pitch_scene",
    PlayerReport: "players",
    Highlight: "highlight",
    AgentRun: "agent_run",
}
