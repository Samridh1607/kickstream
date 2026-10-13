import type {
  Audience, Broadcast, Broadcasts, Destination, Output, Poll, Question, Reel,
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

export const poll = (over: Partial<Poll> = {}): Poll => ({
  id: "p1", question: "Who will win?", state: "open", closes_at: null,
  options: [
    { id: "o1", text: "Northbridge FC", votes: 3 },
    { id: "o2", text: "Draw", votes: 0 },
    { id: "o3", text: "Harbour City", votes: 1 },
  ],
  ...over,
});

export const fanQuestion = (over: Partial<Question> = {}): Question => ({
  id: "q1", text: "Why the change?", nickname: "Ann", votes: 2, state: "open", answer: null, asked_at: 100, ...over,
});

export const audience = (over: Partial<Audience> = {}): Audience => ({
  revision: 1, server_time: 1000, poll: null, poll_on_air: false, history: [], questions: [], draft: null, qa: null, ...over,
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
  sessions: [], recordings: [], moments: [], stats: { live_s: 0, polls: [], questions: 0, score: null },
  reels: [], generating: false, problem: null, ...over,
});

/** A broadcast that was live for two minutes, recorded, with a goal, a poll and a reel. */
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
    live_s: 120, questions: 3,
    polls: [{ id: "p1", question: "Who will win?", votes: 7 }],
    score: { home: "Northbridge FC", away: "Harbour City", score_home: 1, score_away: 0 },
  },
  reels: [reel()],
  ...over,
});

export const broadcasts = (over: Partial<Broadcasts> = {}): Broadcasts => ({
  revision: 1, server_time: 1000, broadcasts: [], current_id: null, ai: true, ...over,
});
