import type { TeamSheet, ViewerProfile } from "./contracts";

export interface Teams {
  home: TeamSheet;
  away: TeamSheet;
}

const DEFAULT_SPEED = 30;
const MAX_SPEED = 600;

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`request failed with status ${response.status}`);
  return (await response.json()) as T;
}

export async function fetchTeams(): Promise<Teams> {
  return json<Teams>(await fetch("/api/teams"));
}

/** The running (or most recent) match, or null when none has been started. */
export async function fetchCurrentMatch(): Promise<string | null> {
  const response = await fetch("/api/matches/current");
  if (response.status === 404) return null;
  return (await json<{ match_id: string }>(response)).match_id;
}

export async function startMatch(speed: number): Promise<string> {
  const response = await fetch("/api/matches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ speed }),
  });
  return (await json<{ match_id: string }>(response)).match_id;
}

export function streamUrl(matchId: string, profile: ViewerProfile): string {
  const query = new URLSearchParams({ mode: profile.mode, lang: profile.language });
  if (profile.club) query.set("club", profile.club);
  if (profile.player) query.set("player", profile.player);
  return `/api/matches/${encodeURIComponent(matchId)}/stream?${query}`;
}

/** Playback speed from `?speed=`, used by the end-to-end test. Out-of-range values give the default. */
export function speedFromLocation(search: string): number {
  const speed = Number(new URLSearchParams(search).get("speed"));
  return Number.isFinite(speed) && speed >= 1 && speed <= MAX_SPEED ? speed : DEFAULT_SPEED;
}
