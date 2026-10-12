import { create } from "zustand";
import type {
  Envelope, KeyMoment, MatchEvent, MatchStatus, Narrative, Overlay, PressureSnapshot, Recap, StatsSnapshot,
} from "../contracts";

export type Connection = "idle" | "connecting" | "live" | "reconnecting" | "no_match";

export interface FeedNarrative extends Narrative {
  highlighted: boolean;
}
export interface FeedMoment extends KeyMoment {
  highlighted: boolean;
}

export interface MatchData {
  lastId: number;
  status: MatchStatus | null;
  events: MatchEvent[];
  stats: StatsSnapshot | null;
  pressure: PressureSnapshot | null;
  moments: FeedMoment[];
  narratives: FeedNarrative[];
  recaps: Recap[];
  overlays: Overlay[];
}

const MAX_EVENTS = 40;
const MAX_OVERLAYS = 300;

export const EMPTY: MatchData = {
  lastId: 0, status: null, events: [], stats: null, pressure: null, moments: [], narratives: [], recaps: [], overlays: [],
};

/** Folds one stream envelope into the match data. Pure; replays and duplicates are ignored by id. */
export function reduce(data: MatchData, envelope: Envelope): MatchData {
  if (envelope.id <= data.lastId) return data;
  const next = { ...data, lastId: envelope.id };
  const payload = envelope.payload as unknown;
  const { highlighted } = envelope;
  switch (envelope.type) {
    case "match_status":
      return { ...next, status: payload as MatchStatus };
    case "match_event":
      return { ...next, events: [...data.events, payload as MatchEvent].slice(-MAX_EVENTS) };
    case "stats":
      return { ...next, stats: payload as StatsSnapshot };
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
  reset(): void;
  setConnection(connection: Connection): void;
  select(momentId: string | null): void;
}

export const useMatch = create<MatchStore>((set) => ({
  data: EMPTY,
  connection: "idle",
  selectedId: null,
  apply: (envelope) => set((state) => ({ data: reduce(state.data, envelope) })),
  reset: () => set({ data: EMPTY, selectedId: null, connection: "connecting" }),
  setConnection: (connection) => set({ connection }),
  select: (selectedId) => set({ selectedId }),
}));
