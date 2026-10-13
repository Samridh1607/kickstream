/* Generated from packages/contracts/kickstream.schema.json. Do not edit. Run `pnpm gen:contracts`. */

export interface KickstreamContracts {
  [k: string]: unknown;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "Player".
 */
export interface Player {
  id: string;
  name: string;
  number: number;
  position: "GK" | "DF" | "MF" | "FW";
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "TeamSheet".
 */
export interface TeamSheet {
  id: string;
  name: string;
  short_name: string;
  color: string;
  players: Player[];
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "MatchStatus".
 */
export interface MatchStatus {
  match_id: string;
  state: "live" | "half_time" | "finished" | "abandoned";
  minute: number;
  score_home: number;
  score_away: number;
  speed: number;
  home: TeamSheet;
  away: TeamSheet;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "MatchEvent".
 */
export interface MatchEvent {
  id: string;
  match_id: string;
  seq: number;
  minute: number;
  second: number;
  type:
    | "kickoff"
    | "pass"
    | "shot"
    | "goal"
    | "save"
    | "foul"
    | "yellow_card"
    | "red_card"
    | "corner"
    | "substitution"
    | "half_time"
    | "full_time";
  team?: "home" | "away" | null;
  player_id?: string | null;
  x: number;
  y: number;
  outcome?: "goal" | "saved" | "off_target" | "blocked" | null;
  completed?: boolean | null;
  player_in_id?: string | null;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "TeamStats".
 */
export interface TeamStats {
  goals: number;
  possession: number;
  shots: number;
  shots_on_target: number;
  passes: number;
  pass_accuracy: number;
  fouls: number;
  yellow_cards: number;
  red_cards: number;
  xg: number;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "StatsSnapshot".
 */
export interface StatsSnapshot {
  id: string;
  match_id: string;
  minute: number;
  home: TeamStats;
  away: TeamStats;
  momentum: number;
  period_end?: "half_time" | "full_time" | null;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "PressureSnapshot".
 */
export interface PressureSnapshot {
  id: string;
  match_id: string;
  minute: number;
  cols: number;
  rows: number;
  home: number[];
  away: number[];
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "StatFact".
 */
export interface StatFact {
  label: "xg" | "shots" | "shots_on_target" | "possession" | "pressure" | "momentum" | "players_on_pitch" | "fouls";
  value: number;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "KeyMoment".
 */
export interface KeyMoment {
  id: string;
  match_id: string;
  minute: number;
  kind: "goal" | "red_card" | "big_chance" | "momentum_swing" | "sustained_pressure";
  team: "home" | "away";
  player_id?: string | null;
  event_id?: string | null;
  score_home: number;
  score_away: number;
  facts: StatFact[];
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "Narrative".
 */
export interface Narrative {
  id: string;
  match_id: string;
  minute: number;
  moment_id: string;
  mode: "fan" | "analyst";
  language: "en" | "es" | "hi";
  text: string;
  source: "agent" | "scripted";
  agent: string;
  evidence: string[];
  team: "home" | "away";
  player_id?: string | null;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "Recap".
 */
export interface Recap {
  id: string;
  match_id: string;
  minute: number;
  period: "half_time" | "full_time";
  mode: "fan" | "analyst";
  language: "en" | "es" | "hi";
  title: string;
  /**
   * @minItems 3
   * @maxItems 3
   */
  bullets: [string, string, string, ...string[]];
  text: string;
  source: "agent" | "scripted";
  agent: string;
  score_home: number;
  score_away: number;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "LowerThirdData".
 */
export interface LowerThirdData {
  headline: string;
  subline: string;
  team: string;
  minute: number;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "StatRow".
 */
export interface StatRow {
  label: string;
  home: number;
  away: number;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "StatCardData".
 */
export interface StatCardData {
  /**
   * @maxItems 4
   */
  stat_rows: StatRow[];
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "PressureMapData".
 */
export interface PressureMapData {
  cols: number;
  rows: number;
  home: number[];
  away: number[];
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "RecapCardData".
 */
export interface RecapCardData {
  title: string;
  score: string;
  /**
   * @minItems 3
   * @maxItems 3
   */
  bullets: [string, string, string, ...string[]];
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "Overlay".
 */
export interface Overlay {
  id: string;
  match_id: string;
  minute: number;
  kind: "lower_third" | "stat_card" | "pressure_map" | "recap_card";
  language?: "en" | "es" | "hi" | null;
  duration_ms: number;
  sources: string[];
  data: LowerThirdData | StatCardData | PressureMapData | RecapCardData;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "ViewerProfile".
 */
export interface ViewerProfile {
  mode: "fan" | "analyst";
  language: "en" | "es" | "hi";
  club?: string | null;
  player?: string | null;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "Envelope".
 */
export interface Envelope {
  id: number;
  type: "match_status" | "match_event" | "stats" | "pressure" | "key_moment" | "narrative" | "recap" | "overlay";
  match_id: string;
  minute: number;
  highlighted: boolean;
  payload: {
    [k: string]: unknown;
  };
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "SceneElement".
 */
export interface SceneElement {
  id: string;
  type:
    | "scoreboard"
    | "pitch"
    | "narration"
    | "stats"
    | "banner"
    | "ticker"
    | "timeline"
    | "recap"
    | "replay"
    | "countdown"
    | "text"
    | "image";
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  visible: boolean;
  props: {
    [k: string]: unknown;
  };
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "Scene".
 */
export interface Scene {
  id: string;
  name: string;
  template?: string | null;
  mode?: "fan" | "analyst" | null;
  /**
   * @maxItems 40
   */
  elements: SceneElement[];
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "StudioSettings".
 */
export interface StudioSettings {
  mode: "fan" | "analyst";
  language: "en" | "es" | "hi";
  auto_banner: boolean;
  auto_start: boolean;
  auto_half_time_break: boolean;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "Banner".
 */
export interface Banner {
  id: string;
  text: string;
  kind: "goal" | "card" | "info" | "custom";
  duration_s: number;
  ends_at?: number | null;
  source_id?: string | null;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "Ticker".
 */
export interface Ticker {
  enabled: boolean;
  speed: number;
  /**
   * @maxItems 20
   */
  messages: string[];
  show_score: boolean;
  show_stats: boolean;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "Countdown".
 */
export interface Countdown {
  kind: "start" | "break";
  ends_at: number;
  label: string;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "Replay".
 */
export interface Replay {
  match_id: string;
  moment_id: string;
  minute: number;
  started_at: number;
  duration_s: number;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "Studio".
 */
export interface Studio {
  revision: number;
  server_time: number;
  /**
   * @minItems 1
   * @maxItems 20
   */
  scenes: [Scene, ...Scene[]];
  active_scene_id: string;
  previous_scene_id?: string | null;
  /**
   * @maxItems 20
   */
  templates: Scene[];
  settings: StudioSettings;
  banner?: Banner | null;
  /**
   * @maxItems 10
   */
  banner_queue: Banner[];
  ticker: Ticker;
  countdown?: Countdown | null;
  replay?: Replay | null;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "Destination".
 */
export interface Destination {
  id: string;
  name: string;
  platform: "youtube" | "x" | "facebook" | "twitch" | "custom" | "file";
  url: string;
  enabled: boolean;
  key_hint: string;
  status: "idle" | "connecting" | "live" | "retrying" | "failed";
  reason?: string | null;
  live_since?: number | null;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "Recording".
 */
export interface Recording {
  file: string;
  size_bytes: number;
  made_at: number;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "Output".
 */
export interface Output {
  revision: number;
  server_time: number;
  /**
   * @maxItems 10
   */
  destinations: Destination[];
  quality: "720p30" | "1080p30";
  state: "idle" | "starting" | "live" | "stopping";
  started_at?: number | null;
  problem?: string | null;
  /**
   * @maxItems 20
   */
  recordings: Recording[];
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "BroadcastDestination".
 */
export interface BroadcastDestination {
  id: string;
  name: string;
  platform: "youtube" | "x" | "facebook" | "twitch" | "custom" | "file";
  outcome: "off" | "live" | "failed";
  reason?: string | null;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "BroadcastSession".
 */
export interface BroadcastSession {
  started_at: number;
  ended_at?: number | null;
  /**
   * @maxItems 10
   */
  destinations: BroadcastDestination[];
  problem?: string | null;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "BroadcastRecording".
 */
export interface BroadcastRecording {
  file: string;
  size_bytes: number;
  started_at: number;
  made_at: number;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "BroadcastMoment".
 */
export interface BroadcastMoment {
  id: string;
  kind: "goal" | "red_card" | "big_chance" | "momentum_swing" | "sustained_pressure";
  team: "home" | "away";
  minute: number;
  at: number;
  score_home: number;
  score_away: number;
  commentary?: string | null;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "BroadcastScore".
 */
export interface BroadcastScore {
  home: string;
  away: string;
  score_home: number;
  score_away: number;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "BroadcastStats".
 */
export interface BroadcastStats {
  live_s: number;
  score?: BroadcastScore | null;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "Reel".
 */
export interface Reel {
  id: string;
  recording: string;
  moment_id?: string | null;
  start_s: number;
  duration_s: number;
  title: string;
  caption: string;
  /**
   * @maxItems 6
   */
  hashtags: string[];
  state: "rendering" | "ready" | "failed";
  agent: string;
  size_bytes?: number | null;
  reason?: string | null;
  made_at: number;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "Broadcast".
 */
export interface Broadcast {
  id: string;
  title: string;
  description: string;
  record: boolean;
  state: "ready" | "live" | "ended";
  created_at: number;
  /**
   * @maxItems 50
   */
  sessions: BroadcastSession[];
  /**
   * @maxItems 50
   */
  recordings: BroadcastRecording[];
  /**
   * @maxItems 100
   */
  moments: BroadcastMoment[];
  stats: BroadcastStats;
  /**
   * @maxItems 12
   */
  reels: Reel[];
  generating: boolean;
  problem?: string | null;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "Broadcasts".
 */
export interface Broadcasts {
  revision: number;
  server_time: number;
  /**
   * @maxItems 100
   */
  broadcasts: Broadcast[];
  current_id?: string | null;
  ai: boolean;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "Invite".
 */
export interface Invite {
  id: string;
  role: "speaker" | "cohost" | "member";
  name?: string | null;
  link: string;
  made_at: number;
  joined_name?: string | null;
  acs_id?: string | null;
  present: boolean;
  revoked: boolean;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "StagePerson".
 */
export interface StagePerson {
  id: string;
  name: string;
  acs_id?: string | null;
  present: boolean;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "People".
 */
export interface People {
  revision: number;
  server_time: number;
  broadcast_id: string;
  service?: "acs" | "fake" | null;
  room_id?: string | null;
  public_origin?: string | null;
  /**
   * @maxItems 12
   */
  invites: Invite[];
  /**
   * @maxItems 4
   */
  stage: StagePerson[];
  host_name: string;
  host_acs_id?: string | null;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "Guest".
 */
export interface Guest {
  revision: number;
  server_time: number;
  valid: boolean;
  service?: "acs" | "fake" | null;
  broadcast_id?: string | null;
  broadcast_title: string;
  broadcast_state: "ready" | "live" | "ended";
  role: "speaker" | "cohost" | "member";
  name?: string | null;
  joined: boolean;
  joined_name?: string | null;
  room_id?: string | null;
  on_stage: boolean;
  muted_live: boolean;
}
/**
 * This interface was referenced by `KickstreamContracts`'s JSON-Schema
 * via the `definition` "CallSeat".
 */
export interface CallSeat {
  room_id: string;
  acs_id: string;
  token: string;
  expires_at: number;
  service: "acs" | "fake";
}
