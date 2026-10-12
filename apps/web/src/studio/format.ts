import type { Countdown, MatchStatus, StatsSnapshot, Ticker } from "../contracts";
import { type Language, t } from "../i18n";

/** Remaining time as m:ss, or h:mm:ss from an hour up. Never negative. */
export function formatRemaining(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function countdownLabel(countdown: Countdown, language: Language): string {
  return countdown.label.trim() || t(language, countdown.kind === "start" ? "kickoffIn" : "backIn");
}

/** What the ticker scrolls: the streamer's messages, then the automatic lines that are switched on. */
export function tickerItems(ticker: Ticker, status: MatchStatus | null, stats: StatsSnapshot | null, language: Language): string[] {
  if (!ticker.enabled) return [];
  const items = [...ticker.messages];
  if (ticker.show_score && status) {
    items.push(`${status.home.name} ${status.score_home}-${status.score_away} ${status.away.name}`);
  }
  if (ticker.show_stats && stats) {
    items.push(
      `${t(language, "shots")} ${stats.home.shots}-${stats.away.shots} · ` +
        `${t(language, "possession")} ${stats.home.possession}-${stats.away.possession}`,
    );
  }
  return items;
}
