import type { Competition, Fixture, MatchListing, SourceInfo, Sources } from "../contracts";
import { send } from "../studio/api";

export type SourceId = SourceInfo["id"];
export type LiveSourceId = Fixture["source"];

export interface StartRequest {
  source: SourceId;
  ref?: string;
  speed: number;
}

export const SPEEDS = [1, 2, 5, 10, 30] as const;

export const fetchSources = () => send<Sources>("GET", "/api/sources");
export const fetchCompetitions = () => send<Competition[]>("GET", "/api/sources/statsbomb/competitions");
export const fetchReplayMatches = (competitionId: number, seasonId: number) =>
  send<MatchListing[]>("GET", `/api/sources/statsbomb/competitions/${competitionId}/${seasonId}/matches`);
export const fetchFixtures = (source: LiveSourceId, day: string) =>
  send<Fixture[]>("GET", `/api/sources/${source}/fixtures?date=${encodeURIComponent(day)}`);

export const startMatchFrom = async (request: StartRequest) =>
  (await send<{ match_id: string }>("POST", "/api/matches", request)).match_id;

export const stopMatch = () => send<void>("POST", "/api/matches/stop");

const pad = (value: number) => String(value).padStart(2, "0");

/** "YYYY-MM-DD" in the browser's time zone. */
export function localDay(at = new Date()): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export function speedLabel(speed: number): string {
  return speed === 1 ? "Real time" : `${speed}×`;
}
