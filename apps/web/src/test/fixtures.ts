import type {
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
