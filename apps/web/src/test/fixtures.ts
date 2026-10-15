import type {
  AutoLive, AutoLiveSettings,
  AgentCatalog, AgentRun, AgentSpec, Explanation, FanComment, FanPoll, FanZone, Highlight, PitchScene, PlayerMetrics, PlayerReport,
  PlayEvent, Prediction, SuperChat, TacticalInsight, TeamTactics,
  Broadcast, Broadcasts, CallSeat, Destination, Guest, Invite, Output, People, Reel,
  Envelope, KeyMoment, MatchEvent, MatchStatus, Narrative, Overlay, PressureSnapshot, Recap, StatsSnapshot,
  Scene, SceneElement, Studio, TeamSheet, TeamStats,
} from "../contracts";

export const HOME: TeamSheet = {
  id: "nbr", name: "Northbridge FC", short_name: "NBR", color: "#0F6CBD",
  players: [
    { id: "nbr-1", name: "Tobin Ashgrove", number: 1, position: "GK" },
    { id: "nbr-9", name: "Luca Marrowby", number: 9, position: "FW" },
  ],
};
export const AWAY: TeamSheet = {
  id: "hbc", name: "Harbour City", short_name: "HBC", color: "#C50F1F",
  players: [
    { id: "hbc-1", name: "Osric Pendlebury", number: 1, position: "GK" },
    { id: "hbc-9", name: "Evander Quillfeather", number: 9, position: "FW" },
  ],
};

export const status = (over: Partial<MatchStatus> = {}): MatchStatus => ({
  match_id: "m-1", state: "live", minute: 0, score_home: 0, score_away: 0, speed: 30, home: HOME, away: AWAY, ...over,
});

export const matchEvent = (over: Partial<MatchEvent> = {}): MatchEvent => ({
  id: "m-1-e1", match_id: "m-1", seq: 1, minute: 3, second: 0, type: "pass", team: "home", player_id: "nbr-9",
  x: 60, y: 40, outcome: null, completed: true, player_in_id: null, ...over,
});

const teamStats = (over: Partial<TeamStats> = {}): TeamStats => ({
  goals: 0, possession: 50, shots: 0, shots_on_target: 0, passes: 0, pass_accuracy: 0, fouls: 0, yellow_cards: 0,
  red_cards: 0, xg: 0, ...over,
});

export const stats = (home: Partial<TeamStats> = {}, away: Partial<TeamStats> = {}, momentum = 0): StatsSnapshot => ({
  id: "m-1-s1", match_id: "m-1", minute: 10, home: teamStats(home), away: teamStats(away), momentum, period_end: null,
});

export const pressure = (over: Partial<PressureSnapshot> = {}): PressureSnapshot => ({
  id: "m-1-p1", match_id: "m-1", minute: 10, cols: 6, rows: 4, home: Array(24).fill(0), away: Array(24).fill(0), ...over,
});

export const moment = (over: Partial<KeyMoment> = {}): KeyMoment => ({
  id: "m-1-k1", match_id: "m-1", minute: 23, kind: "goal", team: "home", player_id: "nbr-9", event_id: "m-1-e40",
  score_home: 1, score_away: 0, facts: [{ label: "xg", value: 0.42 }], ...over,
});

export const narrative = (over: Partial<Narrative> = {}): Narrative => ({
  id: "m-1-k1-fan-en", match_id: "m-1", minute: 23, moment_id: "m-1-k1", mode: "fan", language: "en",
  text: "GOAL! Luca Marrowby scores for Northbridge FC in minute 23. It's 1-0!", source: "scripted", agent: "scripted",
  evidence: ["m-1-k1", "m-1-e40", "m-1-s23"], team: "home", player_id: "nbr-9", ...over,
});

export const recap = (over: Partial<Recap> = {}): Recap => ({
  id: "m-1-r-half_time-fan-en", match_id: "m-1", minute: 45, period: "half_time", mode: "fan", language: "en",
  title: "Half-time: Northbridge FC 1-0 Harbour City", bullets: ["Northbridge FC lead 1-0.", "Shots 5-2.", "xG 0.9-0.2."],
  text: "Northbridge FC lead 1-0. 4 key moments so far.", source: "scripted", agent: "scripted", score_home: 1,
  score_away: 0, ...over,
});

export const overlay = (over: Partial<Overlay> = {}): Overlay => ({
  id: "m-1-o1", match_id: "m-1", minute: 23, kind: "lower_third", language: "en", duration_ms: 6000,
  sources: ["m-1-k1-fan-en", "m-1-k1"],
  data: { headline: "GOAL", subline: "GOAL! Luca Marrowby scores.", team: "Northbridge FC", minute: 23 }, ...over,
});

export const envelope = (id: number, type: Envelope["type"], payload: object, highlighted = false): Envelope => ({
  id, type, match_id: "m-1", minute: 0, highlighted, payload: payload as Envelope["payload"],
});

/** A scriptable stand-in for the browser EventSource. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static get last(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }

  readyState = 0;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  emit(item: Envelope) {
    this.emitRaw(JSON.stringify(item));
  }

  emitRaw(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }

  fail(readyState: 0 | 2) {
    this.readyState = readyState;
    this.onerror?.(new Event("error"));
  }
}

export const FakeEventSourceCtor = FakeEventSource as unknown as new (url: string) => EventSource;


export const element = (over: Partial<SceneElement> = {}): SceneElement => ({
  id: "e1", type: "text", x: 100, y: 100, width: 400, height: 200, layer: 1, visible: true,
  props: { text: "Hello", size: 48, align: "center" }, ...over,
});

export const scene = (over: Partial<Scene> = {}): Scene => ({
  id: "s1", name: "Live match", template: "Live match",
  elements: [
    element({ id: "score", type: "scoreboard", x: 40, y: 40, width: 1100, height: 120, layer: 1, props: {} }),
    element({ id: "banner", type: "banner", x: 1180, y: 680, width: 700, height: 200, layer: 2, props: {} }),
  ],
  ...over,
});

export const studio = (over: Partial<Studio> = {}): Studio => ({
  revision: 1, server_time: 1000,
  scenes: [scene(), scene({ id: "s2", name: "Break", template: "Break", elements: [element({ id: "cd", type: "countdown", props: {} })] })],
  active_scene_id: "s1", previous_scene_id: null, templates: [],
  settings: { mode: "fan", language: "en", auto_banner: true, auto_start: true, auto_half_time_break: false },
  banner: null, banner_queue: [],
  ticker: { enabled: true, speed: 120, messages: [], show_score: true, show_stats: true },
  countdown: null, replay: null, ...over,
});

export const destination = (over: Partial<Destination> = {}): Destination => ({
  id: "d1", name: "YouTube", platform: "youtube", url: "rtmp://a.rtmp.youtube.com/live2", enabled: true,
  key_hint: "wxyz", status: "idle", reason: null, live_since: null, ...over,
});

export const output = (over: Partial<Output> = {}): Output => ({
  revision: 1, server_time: 1000, destinations: [], quality: "720p30", state: "idle", started_at: null,
  problem: null, recordings: [], ...over,
});

export const reel = (over: Partial<Reel> = {}): Reel => ({
  id: "r1", recording: "2026-10-13-140000-rec.mp4", moment_id: "m-1-k1", start_s: 34, duration_s: 15,
  title: "GOAL! Northbridge FC score in the 23'", caption: "Top corner!", hashtags: ["#Kickstream", "#Goal"],
  state: "ready", agent: "AI agents", size_bytes: 4000, reason: null, made_at: 2000, ...over,
});

export const broadcast = (over: Partial<Broadcast> = {}): Broadcast => ({
  id: "b1", title: "Derby day", description: "Matchday 12", record: true, state: "ready", created_at: 1000,
  sessions: [], recordings: [], moments: [], stats: { live_s: 0, score: null },
  reels: [], generating: false, problem: null, ...over,
});

/** A broadcast that was live for two minutes, recorded, with a goal and a reel. */
export const endedBroadcast = (over: Partial<Broadcast> = {}): Broadcast => broadcast({
  state: "ended",
  sessions: [{
    started_at: 1000, ended_at: 1120, problem: null,
    destinations: [
      { id: "d1", name: "YouTube", platform: "youtube", outcome: "live", reason: null },
      { id: "rec", name: "Recording", platform: "file", outcome: "live", reason: null },
      { id: "d2", name: "Twitch", platform: "twitch", outcome: "failed", reason: "Connection refused" },
    ],
  }],
  recordings: [{ file: "2026-10-13-140000-rec.mp4", size_bytes: 5 * 1024 * 1024, started_at: 1000, made_at: 1120 }],
  moments: [{ id: "m-1-k1", kind: "goal", team: "home", minute: 23, at: 1042, score_home: 1, score_away: 0, commentary: "Top corner!" }],
  stats: {
    live_s: 120,
    score: { home: "Northbridge FC", away: "Harbour City", score_home: 1, score_away: 0 },
  },
  reels: [reel()],
  ...over,
});

export const broadcasts = (over: Partial<Broadcasts> = {}): Broadcasts => ({
  revision: 1, server_time: 1000, broadcasts: [], current_id: null, ai: true, ...over,
});

export const invitation = (over: Partial<Invite> = {}): Invite => ({
  id: "i1", role: "speaker", name: "Sam", link: "/guest/abc", made_at: 1000, joined_name: null, acs_id: null,
  present: false, revoked: false, ...over,
});

export const peopleDoc = (over: Partial<People> = {}): People => ({
  revision: 1, server_time: 1000, broadcast_id: "b1", service: "fake", room_id: "room-1",
  public_origin: "https://guests.example", invites: [], stage: [], host_name: "Host", host_acs_id: null, ...over,
});

export const guestDoc = (over: Partial<Guest> = {}): Guest => ({
  revision: 1, server_time: 1000, valid: true, service: "fake", broadcast_id: null, broadcast_title: "Derby day",
  broadcast_state: "ready", role: "speaker", name: "Sam", joined: false, joined_name: null, room_id: null,
  on_stage: false, muted_live: false, ...over,
});

export const callSeat = (over: Partial<CallSeat> = {}): CallSeat => ({
  room_id: "room-1", acs_id: "8:fake:2", token: "t1", expires_at: 2000, service: "fake", ...over,
});

// --- the match agents and the fan zone ---------------------------------------------------------------

export const play = (over: Partial<PlayEvent> = {}): PlayEvent => ({
  id: "m-1-y1", match_id: "m-1", minute: 12, second: 5, event_id: "m-1-e1", type: "pass", team: "home", player_id: "nbr-9",
  x: 70, y: 40, zone: "attacking_third", lane: "centre", phase: "final_third", sequence: 4, sequence_length: 3, danger: 0.42,
  outcome: null, completed: true, player_in_id: null, ...over,
});

const teamTactics = (over: Partial<TeamTactics> = {}): TeamTactics => ({
  pressure: 60, tempo: 3.2, field_tilt: 64, avg_sequence: 4.1, lanes: [0.5, 0.3, 0.2], patterns: [], ...over,
});

export const tactics = (over: Partial<TacticalInsight> = {}): TacticalInsight => ({
  id: "m-1-t12", match_id: "m-1", minute: 12, home: teamTactics({ patterns: ["high_press"] }), away: teamTactics({ pressure: 20, field_tilt: 36 }),
  rhythm: "fast", summary: "Northbridge FC are winning the ball high up the pitch. The rhythm is fast.", ...over,
});

export const prediction = (over: Partial<Prediction> = {}): Prediction => ({
  id: "m-1-f12", match_id: "m-1", minute: 12, win_home: 0.5, draw: 0.3, win_away: 0.2, next_goal_home: 0.24, next_goal_away: 0.1,
  possession: "home", cols: 6, rows: 4, danger: Array(24).fill(0),
  next_actions: [{ action: "pass", probability: 0.7 }, { action: "shot", probability: 0.1 }, { action: "turnover", probability: 0.2 }],
  ...over,
});

export const explanation = (over: Partial<Explanation> = {}): Explanation => ({
  id: "m-1-t12-x-fan", match_id: "m-1", minute: 12, subject_id: "m-1-t12", subject_kind: "tactics", mode: "fan",
  headline: "Northbridge FC are winning the ball high up the pitch", why: "They are not letting Harbour City settle.",
  evidence: ["pressure: 60 out of 100", "field tilt: 64%"], source: "scripted", agent: "scripted", team: "home", ...over,
});

export const pitchScene = (over: Partial<PitchScene> = {}): PitchScene => ({
  id: "m-1-v1", match_id: "m-1", minute: 12, second: 5, ball: { x: 70, y: 40, z: 0 },
  trail: [{ x: 50, y: 50, z: 0 }, { x: 60, y: 45, z: 2 }, { x: 70, y: 40, z: 0 }],
  players: [
    { id: "nbr-9", team: "home", number: 9, x: 70, y: 40, on_ball: true, estimated: false },
    { id: "hbc-1", team: "away", number: 1, x: 95, y: 50, on_ball: false, estimated: true },
  ],
  columns: [{ x: 66.67, y: 25, width: 16.67, depth: 25, team: "home", intensity: 1 }],
  lanes: [{ from_x: 50, from_y: 50, to_x: 70, to_y: 40, team: "home", weight: 1 }],
  camera: "attack_home", focus_x: 70, focus_y: 40, ...over,
});

export const playerLine = (over: Partial<PlayerMetrics> = {}): PlayerMetrics => ({
  player_id: "nbr-9", team: "home", name: "Luca Marrowby", number: 9, position: "FW", on_pitch: true, touches: 18, passes: 12,
  pass_accuracy: 83.3, shots: 3, shots_on_target: 2, goals: 1, xg: 0.62, fouls: 1, yellow_cards: 0, red_cards: 0, rating: 7.8,
  heat: Array(24).fill(0), ...over,
});

export const playerReport = (over: Partial<PlayerReport> = {}): PlayerReport => ({
  id: "m-1-pl12", match_id: "m-1", minute: 12, cols: 6, rows: 4,
  players: [playerLine(), playerLine({ player_id: "hbc-1", team: "away", name: "Osric Pendlebury", number: 1, position: "GK", rating: 6.4, goals: 0, touches: 4 })],
  ...over,
});

export const highlight = (over: Partial<Highlight> = {}): Highlight => ({
  id: "m-1-h1", match_id: "m-1", minute: 23, kind: "key", category: "goal", team: "home", player_id: "nbr-9",
  title: "Goal for Northbridge FC: Luca Marrowby", reason: "expected goals 0.42; the score is 1-0.", score: 95, moment_id: "m-1-k1",
  event_ids: ["m-1-e40"], ...over,
});

export const agentRun = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: "m-1-run-prediction-12", match_id: "m-1", minute: 12, agent: "prediction", trigger: "play", produced: "prediction", count: 1,
  duration_ms: 0.4, source: "scripted", note: "home 50%, draw 30%, away 20%", ...over,
});

const AGENTS: [AgentSpec["id"], string, string, AgentSpec["id"][]][] = [
  ["event_interpreter", "Event Interpreter", "Converts video detections into structured events.", []],
  ["tactical_analyst", "Tactical Analyst", "Detects pressure, rhythm, and tactical patterns.", ["event_interpreter"]],
  ["prediction", "Prediction Agent", "Forecasts likely next moves or danger areas.", ["event_interpreter"]],
  ["player_tracking", "Player Tracking Agent", "Follows favorite player and computes personal metrics.", ["event_interpreter"]],
  ["visualization", "Visualization Agent", "Generates 3D pitch and overlay data.", ["event_interpreter"]],
  ["highlights", "Highlights Agent", "Selects key moments and hidden events.", ["event_interpreter", "player_tracking"]],
  ["explainability", "Explainability Agent", 'Writes clear "why this matters" explanations.', ["tactical_analyst", "prediction", "highlights"]],
];

export const agentCatalog = (off: AgentSpec["id"][] = []): AgentCatalog => ({
  model: false,
  agents: AGENTS.map(([id, name, description, upstream]) => ({
    id, name, description, instructions: `Instructions for the ${name}.`, triggers: ["play"],
    tools: [{ name: "tool_one", description: `What the ${name} uses.` }], outputs: ["output"], upstream, enabled: !off.includes(id),
  })),
});

export const fanComment = (over: Partial<FanComment> = {}): FanComment => ({
  id: "c1", platform: "x", author: "Priya K", handle: "@priya", text: "What a goal!", likes: 3, at: 990, liked: false,
  mood: "positive", demo: false, ...over,
});

export const superchat = (over: Partial<SuperChat> = {}): SuperChat => ({
  id: "s1", platform: "youtube", name: "Asha", amount: 20, currency: "USD", message: "Go on!", tier: 4, at: 995, demo: false, ...over,
});

export const fanPoll = (over: Partial<FanPoll> = {}): FanPoll => ({
  id: "p1", question: "Who wins?", state: "open", opened_at: 900, closes_at: null,
  options: [{ id: "o1", text: "Home", votes: 3 }, { id: "o2", text: "Away", votes: 1 }], ...over,
});

export const autoLiveSettings = (over: Partial<AutoLiveSettings> = {}): AutoLiveSettings => ({
  enabled: true, rotate: true, min_minutes: 5, max_minutes: 10, commentary: true, talk_minutes: 2, narration: true,
  voice: "en-GB-RyanNeural", rate: 1, scenes: ["welcome", "agent-tactics"], keep_match: true, match_speed: 1, stream: false, ...over,
});

export const autoLive = (over: Partial<AutoLive> = {}): AutoLive => ({
  revision: 1, server_time: 1000, settings: autoLiveSettings(),
  scenes: [
    { id: "welcome", name: "Welcome", kind: "show", agent: null, blurb: "The opening card.",
      elements: [element({ id: "e1", type: "scoreboard", x: 40, y: 112, width: 1100, height: 120, props: {} })] },
    { id: "agent-tactics", name: "Tactical Analyst", kind: "agent", agent: "tactics", blurb: "Patterns.",
      elements: [element({ id: "e1", type: "countdown", props: {} })] },
  ],
  scene_id: "welcome", changed_at: 900, next_at: 1300, transition: "fade", commentary: null,
  speech: { azure: true, region: "centralindia", chars_today: 120, chars_limit: 200000, problem: null },
  matches_started: 0, stream_restarts: 0, problem: null, ...over,
});

export const fanZone = (over: Partial<FanZone> = {}): FanZone => ({
  revision: 1, server_time: 1000, settings: { source: "demo", auto_superchat: false }, source_state: "demo", problem: null,
  x_available: false, comments: [], poll: null, poll_on_air: false, superchats: [], spotlight: null, spotlight_queue: [],
  summary: { text: "No comments yet.", per_minute: 0, total: 0, mood: { positive: 0, neutral: 0, negative: 0 }, topics: [], platforms: [], raised: [] },
  ...over,
});
