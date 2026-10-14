import type { CSSProperties, ReactNode } from "react";
import { type Camera, LEVEL, Pitch3D, type View } from "../agents/Pitch3D";
import { CompareBars, Counted, Donut, HeatGrid, type Line, LineGraph, NEUTRAL, ShareBar, type Sides, Swatch } from "../charts/charts";
import type { FanComment, FanPoll, FanZone, MatchStatus, PlayerMetrics, SceneElement, Spotlight, SuperChat } from "../contracts";
import { type Language, type StringKey, t } from "../i18n";
import { pop, rise, SETTLE, slide } from "../motion/motion";
import { PlatformMark } from "../shell/PlatformMark";
import type { MatchData } from "../stream/store";

/** What the fan-zone and agent widgets draw from. `now` is the server's clock in Unix seconds. */
export interface WidgetData {
  match: MatchData;
  fans: FanZone | null;
  now: number;
  language: Language;
}

// The same broadcast look as the other elements: one fixed style, sized for 1080p.
const PANEL: CSSProperties = {
  boxSizing: "border-box", width: "100%", height: "100%", overflow: "hidden", padding: 24, borderRadius: 16,
  color: "#FFFFFF", backgroundColor: "rgba(16, 24, 40, 0.88)", fontSize: 28, lineHeight: 1.3,
  display: "flex", flexDirection: "column", gap: 14,
};
const TITLE: CSSProperties = { fontSize: 20, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.72 };
const MUTED: CSSProperties = { opacity: 0.72 };
const DEFAULT_COLORS: Sides = { home: "#0F6CBD", away: "#C50F1F" };
/** A superchat's colour by its size, as the platforms colour theirs. The amount is always written beside it. */
const TIER: Record<number, { background: string; color: string }> = {
  1: { background: "#1565C0", color: "#FFFFFF" },
  2: { background: "#00897B", color: "#FFFFFF" },
  3: { background: "#F5B301", color: "#1B1B1B" },
  4: { background: "#EF6C00", color: "#FFFFFF" },
  5: { background: "#D50000", color: "#FFFFFF" },
};

const colorsOf = (status: MatchStatus | null): Sides => (status ? { home: status.home.color, away: status.away.color } : DEFAULT_COLORS);
const namesOf = (status: MatchStatus | null): Sides => ({ home: status?.home.name ?? "Home", away: status?.away.name ?? "Away" });
const shortOf = (status: MatchStatus | null): Sides => ({ home: status?.home.short_name ?? "HOME", away: status?.away.short_name ?? "AWAY" });

function Panel({ title, testId, children, style }: { title?: string; testId: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div data-testid={testId} className="ks-motion" style={{ ...PANEL, ...style }}>
      {title && <span style={TITLE}>{title}</span>}
      {children}
    </div>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <span style={{ ...MUTED, margin: "auto", textAlign: "center" }}>{children}</span>;

// --- score card ----------------------------------------------------------------------------------

function ScorecardView({ match }: { match: MatchData }) {
  const status = match.status;
  const colors = colorsOf(status);
  const names = namesOf(status);
  const scorers = match.moments.filter((moment) => moment.kind === "goal").slice(-4).map((goal) => {
    const sheet = goal.team === "home" ? status?.home : status?.away;
    const player = sheet?.players.find((candidate) => candidate.id === goal.player_id);
    return { id: goal.id, team: goal.team, text: `${goal.minute}' ${player?.name.split(" ").slice(-1)[0] ?? ""}`.trim() };
  });
  const side = (team: "home" | "away") => (
    <div style={{ flex: 1, display: "flex", flexDirection: team === "home" ? "row" : "row-reverse", alignItems: "center", gap: 20, minWidth: 0 }}>
      <span aria-hidden style={{ width: 14, alignSelf: "stretch", borderRadius: 7, backgroundColor: colors[team] }} />
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, textAlign: team === "home" ? "left" : "right" }}>
        <span style={{ fontSize: 34, fontWeight: 700, lineHeight: 1.1 }}>{names[team]}</span>
        <span style={{ fontSize: 22, ...MUTED, minHeight: "1.3em" }}>
          {scorers.filter((scorer) => scorer.team === team).map((scorer) => scorer.text).join(" · ")}
        </span>
      </div>
    </div>
  );
  const digit = (value: number | undefined, team: string) => (
    // Keyed by its value, so a goal makes the number arrive afresh.
    <span key={`${team}-${value}`} style={{ display: "inline-block", minWidth: "0.7em", textAlign: "center", animation: pop() }}>{value ?? "–"}</span>
  );
  return (
    <Panel testId="program-scorecard" style={{ flexDirection: "row", alignItems: "center", gap: 28 }}>
      {side("home")}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
        <span data-testid="scorecard-score" style={{ fontSize: 88, fontWeight: 800, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
          {digit(status?.score_home, "home")}<span style={{ opacity: 0.5, margin: "0 0.12em" }}>:</span>{digit(status?.score_away, "away")}
        </span>
        <span style={{ fontSize: 24, fontWeight: 600, padding: "2px 16px", marginTop: 8, borderRadius: 999, backgroundColor: "rgba(255, 255, 255, 0.14)" }}>
          {status ? `${Math.max(status.minute, match.minute)}'` : "–"}
        </span>
      </div>
      {side("away")}
    </Panel>
  );
}

// --- chart and graph -----------------------------------------------------------------------------

function ChartView({ match, metric, language }: { match: MatchData; metric: string; language: Language }) {
  const { stats, tactics, status } = match;
  const colors = colorsOf(status);
  const names = shortOf(status);
  if (metric === "tactics") {
    return (
      <Panel title={t(language, "tactics")} testId="program-chart">
        {tactics ? (
          <CompareBars colors={colors} names={names} rows={[
            { id: "pressure", label: t(language, "pressure"), home: tactics.home.pressure, away: tactics.away.pressure },
            { id: "tempo", label: t(language, "tempo"), home: tactics.home.tempo, away: tactics.away.tempo, digits: 1 },
            { id: "tilt", label: t(language, "fieldTilt"), home: tactics.home.field_tilt, away: tactics.away.field_tilt },
            { id: "move", label: t(language, "averageMove"), home: tactics.home.avg_sequence, away: tactics.away.avg_sequence, digits: 1 },
          ]} />
        ) : <Empty>{t(language, "graphEmpty")}</Empty>}
      </Panel>
    );
  }
  if (!stats) return <Panel title={t(language, "stats")} testId="program-chart"><Empty>{t(language, "graphEmpty")}</Empty></Panel>;
  if (metric === "possession") {
    return (
      <Panel title={t(language, "possession")} testId="program-chart">
        <Donut home={stats.home.possession} away={stats.away.possession} colors={colors} names={names} label={t(language, "possession")} />
      </Panel>
    );
  }
  const all = {
    possession: { id: "possession", label: t(language, "possession"), home: stats.home.possession, away: stats.away.possession },
    shots: { id: "shots", label: t(language, "shots"), home: stats.home.shots, away: stats.away.shots },
    onTarget: { id: "on-target", label: t(language, "shotsOnTarget"), home: stats.home.shots_on_target, away: stats.away.shots_on_target },
    xg: { id: "xg", label: t(language, "xg"), home: stats.home.xg, away: stats.away.xg, digits: 2 },
    accuracy: { id: "accuracy", label: t(language, "passAccuracy"), home: stats.home.pass_accuracy, away: stats.away.pass_accuracy },
  };
  const rows = metric === "shots" ? [all.shots, all.onTarget] : metric === "xg" ? [all.xg, all.shots] : [all.possession, all.shots, all.onTarget, all.xg];
  return (
    <Panel title={t(language, "stats")} testId="program-chart">
      <CompareBars rows={rows} colors={colors} names={names} />
    </Panel>
  );
}

function GraphView({ match, metric, language }: { match: MatchData; metric: string; language: Language }) {
  const colors = colorsOf(match.status);
  const names = shortOf(match.status);
  const series = match.series;
  const xs = series.map((point) => point.minute);
  const xMax = Math.max(90, match.minute);
  let lines: Line[];
  let range: { yMin: number; yMax: number; baseline?: number };
  let label: string;
  let format = (value: number) => value.toFixed(2);
  if (metric === "xg") {
    lines = [
      { id: "home", label: names.home, color: colors.home, values: series.map((point) => point.xgHome) },
      { id: "away", label: names.away, color: colors.away, values: series.map((point) => point.xgAway) },
    ];
    range = { yMin: 0, yMax: Math.max(1, ...series.flatMap((point) => [point.xgHome ?? 0, point.xgAway ?? 0])) };
    label = t(language, "xg");
  } else if (metric === "win_probability") {
    lines = [
      { id: "home", label: names.home, color: colors.home, values: series.map((point) => (point.winHome === null ? null : point.winHome * 100)) },
      { id: "draw", label: t(language, "draw"), color: NEUTRAL, values: series.map((point) => (point.draw === null ? null : point.draw * 100)) },
      { id: "away", label: names.away, color: colors.away, values: series.map((point) => (point.winAway === null ? null : point.winAway * 100)) },
    ];
    range = { yMin: 0, yMax: 100 };
    label = t(language, "winProbability");
    format = (value) => `${value.toFixed(0)}%`;
  } else {
    // One line with a meaning to each side of zero: above it the home side is on top, below it the away side.
    lines = [{ id: "momentum", label: t(language, "momentum"), color: "#E6E8EB", values: series.map((point) => point.momentum) }];
    range = { yMin: -1, yMax: 1, baseline: 0 };
    label = `${t(language, "momentum")} · ▲ ${names.home} ▼ ${names.away}`;
  }
  const empty = lines.every((line) => line.values.every((value) => value === null));
  return (
    <Panel testId="program-graph" style={{ fontSize: 24 }}>
      {empty ? <Empty>{t(language, "graphEmpty")}</Empty> : <LineGraph lines={lines} xs={xs} xMax={xMax} label={label} format={format} {...range} />}
    </Panel>
  );
}

// --- prediction and insight ----------------------------------------------------------------------

function Meter({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div data-testid="meter" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 4em", alignItems: "center", columnGap: 16 }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}><Swatch color={color} />{label}</span>
      <b style={{ textAlign: "right" }}><Counted value={value * 100} suffix="%" /></b>
      <div aria-hidden style={{ gridColumn: "1 / -1", height: 10, marginTop: 4, borderRadius: 5, backgroundColor: "rgba(255, 255, 255, 0.14)" }}>
        <div style={{ width: `${Math.max(1, value * 100)}%`, height: "100%", borderRadius: 5, backgroundColor: color, transition: `width ${SETTLE}` }} />
      </div>
    </div>
  );
}

function PredictionView({ match, view, language }: { match: MatchData; view: string; language: Language }) {
  const prediction = match.prediction;
  const colors = colorsOf(match.status);
  const names = namesOf(match.status);
  if (!prediction) return <Panel title={t(language, "winProbability")} testId="program-prediction"><Empty>{t(language, "predictionEmpty")}</Empty></Panel>;
  if (view === "next_goal") {
    return (
      <Panel title={t(language, "nextGoal")} testId="program-prediction">
        <Meter label={names.home} value={prediction.next_goal_home} color={colors.home} />
        <Meter label={names.away} value={prediction.next_goal_away} color={colors.away} />
      </Panel>
    );
  }
  if (view === "next_action") {
    const side = prediction.possession ?? null;
    return (
      <Panel title={side ? `${t(language, "nextAction")} · ${names[side]} ${t(language, "onTheBall")}` : t(language, "nextAction")} testId="program-prediction">
        {prediction.next_actions.length === 0 && <Empty>{t(language, "predictionEmpty")}</Empty>}
        {prediction.next_actions.map((action) => (
          <Meter key={action.action} label={t(language, `action_${action.action}` as StringKey)} value={action.probability} color={side ? colors[side] : NEUTRAL} />
        ))}
      </Panel>
    );
  }
  return (
    <Panel title={t(language, "winProbability")} testId="program-prediction">
      <ShareBar label={t(language, "winProbability")} parts={[
        { id: "home", label: names.home, value: prediction.win_home, color: colors.home },
        { id: "draw", label: t(language, "draw"), value: prediction.draw, color: NEUTRAL },
        { id: "away", label: names.away, value: prediction.win_away, color: colors.away },
      ]} />
    </Panel>
  );
}

function InsightView({ match, language }: { match: MatchData; language: Language }) {
  const explanation = match.explanations[0];
  const colors = colorsOf(match.status);
  if (!explanation) return <Panel title={t(language, "whyItMatters")} testId="program-insight"><Empty>{t(language, "insightEmpty")}</Empty></Panel>;
  return (
    <Panel title={`${t(language, "whyItMatters")} · ${explanation.minute}'`} testId="program-insight"
      style={{ borderLeft: `10px solid ${explanation.team ? colors[explanation.team] : NEUTRAL}` }}>
      {/* Keyed by the explanation, so each new one arrives instead of swapping in place. */}
      <div key={explanation.id} style={{ display: "flex", flexDirection: "column", gap: 10, animation: rise() }}>
        <span style={{ fontSize: 36, fontWeight: 700, lineHeight: 1.15 }}>{explanation.headline}</span>
        <span style={{ fontSize: 26, opacity: 0.9 }}>{explanation.why}</span>
      </div>
    </Panel>
  );
}

// --- 3D pitch and player -------------------------------------------------------------------------

const CAMERAS: readonly string[] = ["broadcast", "tactical", "attack_home", "attack_away"] satisfies Camera[];

/** The view a 3D pitch element holds, from its saved settings. */
export function heldView(props: Record<string, unknown>): View {
  const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
  return { zoom: num(props.zoom, LEVEL.zoom), turn: num(props.turn, LEVEL.turn), tilt: num(props.tilt, LEVEL.tilt), panX: num(props.pan_x, LEVEL.panX), panY: num(props.pan_y, LEVEL.panY) };
}

function Pitch3DView({ match, props, language }: { match: MatchData; props: Record<string, unknown>; language: Language }) {
  const camera = typeof props.camera === "string" && CAMERAS.includes(props.camera) ? (props.camera as Camera) : undefined;
  const followId = typeof props.player_id === "string" ? props.player_id : null;
  return (
    <Panel testId="program-pitch3d" style={{ padding: 12, gap: 4, background: "linear-gradient(180deg, #0B1220 0%, #16233B 100%)" }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Pitch3D scene={match.pitch} colors={colorsOf(match.status)} camera={camera} followId={followId} view={heldView(props)} followBall={props.follow_ball === true}
          label={t(language, "pitch3d")} emptyText={t(language, "pitch3dEmpty")} />
      </div>
      {match.pitch && <span style={{ fontSize: 16, ...MUTED, textAlign: "right", paddingRight: 8 }}>{t(language, "estimated")}</span>}
    </Panel>
  );
}

/** The player a card follows: the one chosen, or else whoever is rated highest so far. */
export function trackedPlayer(match: MatchData, playerId: string | null): PlayerMetrics | null {
  const players = match.players?.players ?? [];
  if (players.length === 0) return null;
  const chosen = playerId ? players.find((player) => player.player_id === playerId) : undefined;
  return chosen ?? [...players].sort((a, b) => b.rating - a.rating || b.touches - a.touches)[0];
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span style={{ display: "flex", flexDirection: "column" }}>
      <b style={{ fontSize: 34, lineHeight: 1.1 }}>{children}</b>
      <span style={{ fontSize: 18, ...MUTED }}>{label}</span>
    </span>
  );
}

function PlayerView({ match, playerId, language }: { match: MatchData; playerId: string | null; language: Language }) {
  const player = trackedPlayer(match, playerId);
  if (!player || !match.players) return <Panel title={t(language, "favoritePlayer")} testId="program-player"><Empty>{t(language, "playerEmpty")}</Empty></Panel>;
  const color = colorsOf(match.status)[player.team];
  return (
    <Panel testId="program-player">
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ display: "grid", placeItems: "center", width: 64, height: 64, borderRadius: 16, fontSize: 32, fontWeight: 800, backgroundColor: color, flexShrink: 0 }}>{player.number}</span>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span data-testid="player-name" style={{ fontSize: 32, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{player.name}</span>
          <span style={{ fontSize: 20, ...MUTED }}>{player.position}{player.on_pitch ? "" : ` · ${t(language, "offPitch")}`}</span>
        </div>
        <span style={{ marginLeft: "auto", textAlign: "right" }}><Stat label={t(language, "rating")}><Counted value={player.rating} digits={1} /></Stat></span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <Stat label={t(language, "touches")}><Counted value={player.touches} /></Stat>
        <Stat label={t(language, "passAccuracy")}><Counted value={player.pass_accuracy} /></Stat>
        <Stat label={t(language, "shots")}><Counted value={player.shots} /></Stat>
        <Stat label={t(language, "goals")}><Counted value={player.goals} /></Stat>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "flex-end" }}>
        <HeatGrid cols={match.players.cols} rows={match.players.rows} values={player.heat} color={color} label={`${player.name}: ${t(language, "touches")}`} />
      </div>
    </Panel>
  );
}

// --- the fan zone --------------------------------------------------------------------------------

function DemoChip({ language }: { language: Language }) {
  return <span style={{ fontSize: 14, fontWeight: 700, padding: "1px 8px", borderRadius: 6, letterSpacing: "0.06em", textTransform: "uppercase", backgroundColor: "rgba(255, 255, 255, 0.18)" }}>{t(language, "demo")}</span>;
}

function CommentRow({ comment, language }: { comment: FanComment; language: Language }) {
  return (
    <div data-testid="fan-comment" style={{ display: "flex", gap: 14, alignItems: "flex-start", padding: "10px 14px", borderRadius: 14, backgroundColor: comment.liked ? "rgba(255, 185, 0, 0.16)" : "rgba(255, 255, 255, 0.07)", animation: slide() }}>
      <PlatformMark platform={comment.platform === "other" ? "custom" : comment.platform} size={34} />
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 20, fontWeight: 700 }}>
          {comment.author}
          {comment.liked && <span aria-hidden style={{ color: "#FFB900" }}>★</span>}
          {comment.demo && <DemoChip language={language} />}
        </span>
        <span style={{ fontSize: 24, lineHeight: 1.25, overflowWrap: "anywhere" }}>{comment.text}</span>
      </div>
    </div>
  );
}

function CommentsView({ fans, lines, likedOnly, language }: { fans: FanZone | null; lines: number; likedOnly: boolean; language: Language }) {
  const all = fans?.comments ?? [];
  const shown = (likedOnly ? all.filter((comment) => comment.liked) : all).slice(-lines);
  return (
    <Panel title={t(language, "comments")} testId="program-comments" style={{ justifyContent: "flex-end" }}>
      {shown.length === 0 && <Empty>{t(language, "commentsEmpty")}</Empty>}
      {shown.map((comment) => <CommentRow key={comment.id} comment={comment} language={language} />)}
    </Panel>
  );
}

/** Opaque: a poll put on air often sits on top of other elements, which must not show through it. */
export function PollView({ poll, language }: { poll: FanPoll; language: Language }) {
  const total = poll.options.reduce((sum, option) => sum + option.votes, 0);
  const most = Math.max(...poll.options.map((option) => option.votes));
  return (
    <Panel title={`${t(language, "poll")} · ${total} ${t(language, "pollVotes")}`} testId="program-poll" style={{ animation: rise(), backgroundColor: "#101828", boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)" }}>
      <span style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.15 }}>{poll.question}</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0, justifyContent: "center" }}>
        {poll.options.map((option, index) => {
          const share = total === 0 ? 0 : (option.votes / total) * 100;
          const leading = total > 0 && option.votes === most;
          return (
            <div key={option.id} data-testid="poll-option" style={{ position: "relative", overflow: "hidden", flexShrink: 0, borderRadius: 12, backgroundColor: "rgba(255, 255, 255, 0.1)" }}>
              <div aria-hidden style={{ position: "absolute", inset: 0, width: `${share}%`, borderRadius: 12, backgroundColor: leading ? "#8448EA" : "rgba(132, 72, 234, 0.45)", transition: `width ${SETTLE}, background-color ${SETTLE}` }} />
              <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 14, padding: "6px 14px", fontSize: 24 }}>
                <span style={{ display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: 8, fontWeight: 800, backgroundColor: "rgba(0, 0, 0, 0.35)", flexShrink: 0 }}>{index + 1}</span>
                <span style={{ flex: 1, minWidth: 0, fontWeight: leading ? 700 : 500 }}>{option.text}</span>
                <b><Counted value={share} suffix="%" /></b>
              </div>
            </div>
          );
        })}
      </div>
      <span style={{ fontSize: 18, ...MUTED }}>{t(language, poll.state === "open" ? "pollHow" : "pollClosed")}</span>
    </Panel>
  );
}

function SuperchatChip({ superchat, language }: { superchat: SuperChat; language: Language }) {
  const tier = TIER[superchat.tier] ?? TIER[1];
  return (
    <div data-testid="superchat" data-tier={superchat.tier} style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 16px", borderRadius: 14, color: tier.color, backgroundColor: tier.background, animation: slide() }}>
      <b style={{ fontSize: 24, whiteSpace: "nowrap" }}>{superchat.name}</b>
      <b style={{ fontSize: 22, padding: "2px 10px", borderRadius: 8, backgroundColor: "rgba(0, 0, 0, 0.22)", whiteSpace: "nowrap" }}>{superchat.currency} {superchat.amount.toFixed(2)}</b>
      <span style={{ fontSize: 22, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{superchat.message}</span>
      {superchat.demo && <span style={{ marginLeft: "auto" }}><DemoChip language={language} /></span>}
    </div>
  );
}

function SuperchatView({ fans, lines, language }: { fans: FanZone | null; lines: number; language: Language }) {
  const shown = (fans?.superchats ?? []).slice(-lines).reverse();
  return (
    <Panel title={t(language, "superchats")} testId="program-superchats">
      {shown.length === 0 && <Empty>{t(language, "superchatsEmpty")}</Empty>}
      {shown.map((superchat) => <SuperchatChip key={superchat.id} superchat={superchat} language={language} />)}
    </Panel>
  );
}

/** What a spotlight is headed with. A message and a poll result carry their own title. */
function spotlightHeading(spotlight: Spotlight, language: Language): string {
  if (spotlight.kind === "message" || spotlight.kind === "poll_result") return spotlight.title;
  return t(language, spotlight.kind === "comment" ? "fanComment" : spotlight.kind === "superchat" ? "thanks" : "winner");
}
const SPOTLIGHT_COLOR: Record<Spotlight["kind"], string> = {
  comment: "#0F6CBD", superchat: "#EF6C00", message: "#5C2E91", winner: "#107C10", poll_result: "#8448EA",
};

export function SpotlightView({ spotlight, now, language }: { spotlight: Spotlight; now: number; language: Language }) {
  const tier = spotlight.kind === "superchat" && spotlight.tier ? TIER[spotlight.tier] : null;
  const background = tier?.background ?? SPOTLIGHT_COLOR[spotlight.kind];
  const color = tier?.color ?? "#FFFFFF";
  const left = spotlight.ends_at ? Math.max(0, Math.min(1, (spotlight.ends_at - now) / spotlight.duration_s)) : 1;
  const heading = spotlightHeading(spotlight, language);
  return (
    // Keyed by the spotlight where it is used, so each one pops in.
    <div data-testid="program-spotlight" data-kind={spotlight.kind} className="ks-motion"
      style={{ ...PANEL, position: "relative", justifyContent: "center", gap: 6, color, backgroundColor: background, animation: `${pop()}, ks-glow 2.4s ease-in-out 600ms infinite` }}>
      {heading && <span style={{ ...TITLE, opacity: 0.85 }}>{heading}</span>}
      {spotlight.name && (
        <span style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: 16 }}>
          <span data-testid="spotlight-name" style={{ fontSize: spotlight.kind === "winner" ? 56 : 40, fontWeight: 800, lineHeight: 1.1 }}>
            {spotlight.kind === "winner" && <span aria-hidden>🏆 </span>}{spotlight.name}
          </span>
          {spotlight.detail && <b style={{ fontSize: 28, padding: "2px 14px", borderRadius: 10, backgroundColor: "rgba(0, 0, 0, 0.22)" }}>{spotlight.detail}</b>}
        </span>
      )}
      {spotlight.text && <span style={{ fontSize: spotlight.name ? 28 : 40, fontWeight: spotlight.name ? 500 : 700, lineHeight: 1.2, overflowWrap: "anywhere" }}>{spotlight.text}</span>}
      {!spotlight.name && spotlight.detail && <span style={{ fontSize: 24, opacity: 0.9 }}>{spotlight.detail}</span>}
      <div aria-hidden style={{ position: "absolute", left: 0, bottom: 0, height: 6, width: `${left * 100}%`, backgroundColor: "rgba(255, 255, 255, 0.7)", transition: `width 300ms linear` }} />
    </div>
  );
}

// --- all of them ---------------------------------------------------------------------------------

export const WIDGET_TYPES = [
  "scorecard", "chart", "graph", "prediction", "insight", "pitch3d", "player", "comments", "poll", "superchat", "spotlight",
] as const satisfies readonly SceneElement["type"][];
export type WidgetType = (typeof WIDGET_TYPES)[number];

export const isWidget = (type: SceneElement["type"]): type is WidgetType => (WIDGET_TYPES as readonly string[]).includes(type);

const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);

/** Draws one agent or fan-zone widget. Returns null for a widget with nothing on air to show. */
export function WidgetView({ element, data }: { element: SceneElement & { type: WidgetType }; data: WidgetData }) {
  const { match, fans, language } = data;
  const props = element.props as Record<string, unknown>;
  switch (element.type) {
    case "scorecard":
      return <ScorecardView match={match} />;
    case "chart":
      return <ChartView match={match} metric={text(props.metric, "overview")} language={language} />;
    case "graph":
      return <GraphView match={match} metric={text(props.metric, "momentum")} language={language} />;
    case "prediction":
      return <PredictionView match={match} view={text(props.view, "outcome")} language={language} />;
    case "insight":
      return <InsightView match={match} language={language} />;
    case "pitch3d":
      return <Pitch3DView match={match} props={props} language={language} />;
    case "player":
      return <PlayerView match={match} playerId={typeof props.player_id === "string" ? props.player_id : null} language={language} />;
    case "comments":
      return <CommentsView fans={fans} lines={typeof props.lines === "number" ? props.lines : 4} likedOnly={props.liked_only === true} language={language} />;
    case "poll":
      return fans?.poll && fans.poll_on_air ? <PollView key={fans.poll.id} poll={fans.poll} language={language} /> : null;
    case "superchat":
      return <SuperchatView fans={fans} lines={typeof props.lines === "number" ? props.lines : 3} language={language} />;
    case "spotlight":
      return fans?.spotlight ? <SpotlightView key={fans.spotlight.id} spotlight={fans.spotlight} now={data.now} language={language} /> : null;
  }
}
