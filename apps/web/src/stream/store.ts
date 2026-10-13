import { create } from "zustand";
import type {
  AgentRun, Envelope, Explanation, Highlight, KeyMoment, MatchEvent, MatchStatus, Narrative, Overlay, PitchScene,
  PlayerReport, PlayEvent, Prediction, PressureSnapshot, Recap, StatsSnapshot, TacticalInsight,
} from "../contracts";

export type Connection = "idle" | "connecting" | "live" | "reconnecting" | "no_match";

export interface FeedNarrative extends Narrative {
  highlighted: boolean;
}
export interface FeedMoment extends KeyMoment {
  highlighted: boolean;
}

export interface FeedHighlight extends Highlight {
  highlighted: boolean;
}

/** One match minute of the numbers the graphs draw. A value is null until its source has reported. */
export interface SeriesPoint {
  minute: number;
  momentum: number | null;
  xgHome: number | null;
  xgAway: number | null;
  winHome: number | null;
  draw: number | null;
  winAway: number | null;
}

export interface MatchData {
  lastId: number;
  /** The latest match minute seen on any envelope. Drives the header clock. */
  minute: number;
  status: MatchStatus | null;
  events: MatchEvent[];
  stats: StatsSnapshot | null;
  pressure: PressureSnapshot | null;
  moments: FeedMoment[];
  narratives: FeedNarrative[];
  recaps: Recap[];
  overlays: Overlay[];
  /** What the match agents have found. */
  plays: PlayEvent[];
  tactics: TacticalInsight | null;
  prediction: Prediction | null;
  /** Newest first. */
  explanations: Explanation[];
  pitch: PitchScene | null;
  players: PlayerReport | null;
  highlights: FeedHighlight[];
  /** Newest first. */
  runs: AgentRun[];
  series: SeriesPoint[];
}

const MAX_EVENTS = 40;
const MAX_OVERLAYS = 300;
const MAX_PLAYS = 40;
const MAX_EXPLANATIONS = 30;
const MAX_HIGHLIGHTS = 120;
const MAX_RUNS = 80;

export const EMPTY: MatchData = {
  lastId: 0, minute: 0, status: null, events: [], stats: null, pressure: null, moments: [], narratives: [], recaps: [], overlays: [],
  plays: [], tactics: null, prediction: null, explanations: [], pitch: null, players: null, highlights: [], runs: [], series: [],
};

const BLANK_POINT = { momentum: null, xgHome: null, xgAway: null, winHome: null, draw: null, winAway: null };

/** The series with this minute's point changed, added in order when it is new. */
function withPoint(series: SeriesPoint[], minute: number, changes: Partial<SeriesPoint>): SeriesPoint[] {
  const index = series.findIndex((point) => point.minute === minute);
  if (index >= 0) return series.map((point, at) => (at === index ? { ...point, ...changes } : point));
  return [...series, { minute, ...BLANK_POINT, ...changes }].sort((a, b) => a.minute - b.minute);
}

/** Folds one stream envelope into the match data. Pure; replays and duplicates are ignored by id. */
export function reduce(data: MatchData, envelope: Envelope): MatchData {
  if (envelope.id <= data.lastId) return data;
  const next = { ...data, lastId: envelope.id, minute: Math.max(data.minute, envelope.minute ?? 0) };
  const payload = envelope.payload as unknown;
  const { highlighted } = envelope;
  switch (envelope.type) {
    case "match_status":
      return { ...next, status: payload as MatchStatus };
    case "match_event":
      return { ...next, events: [...data.events, payload as MatchEvent].slice(-MAX_EVENTS) };
    case "stats": {
      const stats = payload as StatsSnapshot;
      const series = withPoint(data.series, stats.minute, { momentum: stats.momentum, xgHome: stats.home.xg, xgAway: stats.away.xg });
      return { ...next, stats, series };
    }
    case "pressure":
      return { ...next, pressure: payload as PressureSnapshot };
    case "key_moment":
      return { ...next, moments: [...data.moments, { ...(payload as KeyMoment), highlighted }] };
    case "narrative":
      return { ...next, narratives: [{ ...(payload as Narrative), highlighted }, ...data.narratives] };
    case "recap":
      return { ...next, recaps: [...data.recaps, payload as Recap] };
    case "overlay":
      return { ...next, overlays: [...data.overlays, payload as Overlay].slice(-MAX_OVERLAYS) };
    case "play":
      return { ...next, plays: [...data.plays, payload as PlayEvent].slice(-MAX_PLAYS) };
    case "tactics":
      return { ...next, tactics: payload as TacticalInsight };
    case "prediction": {
      const prediction = payload as Prediction;
      const series = withPoint(data.series, prediction.minute, { winHome: prediction.win_home, draw: prediction.draw, winAway: prediction.win_away });
      return { ...next, prediction, series };
    }
    case "explanation":
      return { ...next, explanations: [payload as Explanation, ...data.explanations].slice(0, MAX_EXPLANATIONS) };
    case "pitch_scene":
      return { ...next, pitch: payload as PitchScene };
    case "players":
      return { ...next, players: payload as PlayerReport };
    case "highlight":
      return { ...next, highlights: [...data.highlights, { ...(payload as Highlight), highlighted }].slice(-MAX_HIGHLIGHTS) };
    case "agent_run":
      return { ...next, runs: [payload as AgentRun, ...data.runs].slice(0, MAX_RUNS) };
    default:
      return next;
  }
}

export function latestOverlays(overlays: Overlay[]): Partial<Record<Overlay["kind"], Overlay>> {
  const latest: Partial<Record<Overlay["kind"], Overlay>> = {};
  for (const overlay of overlays) latest[overlay.kind] = overlay;
  return latest;
}

interface MatchStore {
  data: MatchData;
  connection: Connection;
  selectedId: string | null;
  apply(envelope: Envelope): void;
  /** Folds in several envelopes as one change, so the page draws once for all of them. */
  applyAll(envelopes: readonly Envelope[]): void;
  reset(): void;
  setConnection(connection: Connection): void;
  select(momentId: string | null): void;
}

export const useMatch = create<MatchStore>((set) => ({
  data: EMPTY,
  connection: "idle",
  selectedId: null,
  apply: (envelope) => set((state) => ({ data: reduce(state.data, envelope) })),
  applyAll: (envelopes) => set((state) => ({ data: envelopes.reduce(reduce, state.data) })),
  reset: () => set({ data: EMPTY, selectedId: null, connection: "connecting" }),
  setConnection: (connection) => set({ connection }),
  select: (selectedId) => set({ selectedId }),
}));
