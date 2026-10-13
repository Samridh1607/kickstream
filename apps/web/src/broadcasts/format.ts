import type { Broadcast, BroadcastMoment, Reel } from "../contracts";

/** `1:02:03` or `4:05`. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(whole % 60)}` : `${minutes}:${pad(whole % 60)}`;
}

/** `1 h 5 min`, `12 min`, `45 s`. */
export function duration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole} s`;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

export function when(epochSeconds: number): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    .format(new Date(epochSeconds * 1000));
}

export function bytes(size: number): string {
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(1)} GB`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export const STATE = {
  ready: { label: "Ready", color: "brand" },
  live: { label: "Live", color: "danger" },
  ended: { label: "Ended", color: "subtle" },
} as const;

export const MOMENT_LABELS: Record<BroadcastMoment["kind"], string> = {
  goal: "Goal",
  red_card: "Red card",
  big_chance: "Big chance",
  momentum_swing: "Momentum swing",
  sustained_pressure: "Sustained pressure",
};

/** Time on air up to `now` (server time, in seconds): every session, the open one counted so far. */
export function onAir(broadcast: Broadcast, now: number): number {
  return broadcast.sessions.reduce((sum, session) => sum + Math.max(0, (session.ended_at ?? now) - session.started_at), 0);
}

export function votes(broadcast: Broadcast): number {
  return broadcast.stats.polls.reduce((sum, poll) => sum + poll.votes, 0);
}

/** Destinations that received the stream at least once, of all that were on in any session. */
export function reach(broadcast: Broadcast): { reached: number; total: number } {
  const outcomes = new Map<string, boolean>();
  for (const session of broadcast.sessions) {
    for (const destination of session.destinations) {
      outcomes.set(destination.id, (outcomes.get(destination.id) ?? false) || destination.outcome === "live");
    }
  }
  return { reached: [...outcomes.values()].filter(Boolean).length, total: outcomes.size };
}

export function teamName(broadcast: Broadcast, side: "home" | "away"): string | null {
  const score = broadcast.stats.score;
  return score ? (side === "home" ? score.home : score.away) : null;
}

/** Seconds into the broadcast: from the start of its first session. */
export function intoBroadcast(broadcast: Broadcast, at: number): number {
  return broadcast.sessions.length > 0 ? Math.max(0, at - broadcast.sessions[0].started_at) : 0;
}

/** The text to paste when posting a reel. */
export function post(reel: Reel): string {
  return [reel.title, reel.caption, reel.hashtags.join(" ")].filter(Boolean).join("\n\n");
}
