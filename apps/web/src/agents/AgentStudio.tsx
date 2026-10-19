import { Badge, makeStyles, mergeClasses, MessageBar, MessageBarBody, Switch, Text, tokens } from "@fluentui/react-components";
import { AppsListDetailRegular, CodeRegular, FlowRegular, HistoryRegular, SportSoccerRegular } from "@fluentui/react-icons";
import type { ReactNode } from "react";
import type { AgentCatalog, AgentSpec } from "../contracts";
import { type Language, t } from "../i18n";
import { MotionStyles, rise } from "../motion/motion";
import { useCanUseStudio } from "../shell/viewer";
import type { MatchData } from "../stream/store";
import { AgentFlow } from "./AgentFlow";
import { type AgentId, agentState, type AgentState, downstream, runsOf } from "./api";
import {
  ActivityList, AGENT_ICONS, Card, ExplanationsCard, HighlightsCard, PitchCard, PlayerCard, PlaysCard, PredictionCard, TacticsCard, TheirMomentsCard,
} from "./cards";

/** What the page shows: the overview, one agent, or one of the two views the page had before the agents. */
export type StudioView = "overview" | AgentId | "match" | "overlay";

export const isAgentView = (view: StudioView): view is AgentId => view !== "overview" && view !== "match" && view !== "overlay";

const STATE_TEXT: Record<AgentState, string> = { off: "Off", working: "Working", idle: "Idle" };

const useStyles = makeStyles({
  rail: {
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXXS, padding: tokens.spacingVerticalM, boxSizing: "border-box",
    backgroundColor: tokens.colorNeutralBackground1, borderRight: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    "@media (max-width: 900px)": { flexDirection: "row", flexWrap: "wrap", borderRight: "none", borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}` },
  },
  railLabel: { padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS} ${tokens.spacingVerticalXXS}`, color: tokens.colorNeutralForeground3, "@media (max-width: 900px)": { display: "none" } },
  railItem: {
    display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium, border: "none", backgroundColor: "transparent", color: tokens.colorNeutralForeground2,
    fontFamily: "inherit", fontSize: tokens.fontSizeBase300, textAlign: "left", cursor: "pointer", position: "relative",
    transitionProperty: "background-color, color", transitionDuration: "160ms",
    ":hover": { backgroundColor: tokens.colorNeutralBackground1Hover, color: tokens.colorNeutralForeground1 },
    ":focus-visible": { outline: `${tokens.strokeWidthThick} solid ${tokens.colorStrokeFocus2}` },
    "& svg": { fontSize: "18px", flexShrink: 0 },
  },
  railCurrent: {
    color: tokens.colorBrandForeground1, backgroundColor: tokens.colorBrandBackground2, fontWeight: tokens.fontWeightSemibold,
    ":hover": { color: tokens.colorBrandForeground1, backgroundColor: tokens.colorBrandBackground2Hover },
  },
  railName: { flexGrow: 1, whiteSpace: "nowrap" },
  dot: { width: "8px", height: "8px", borderRadius: "50%", flexShrink: 0, backgroundColor: tokens.colorNeutralForeground4 },
  working: { backgroundColor: tokens.colorPaletteGreenForeground1, animationName: "ks-pulse", animationDuration: "1.2s", animationIterationCount: "infinite" },
  idle: { backgroundColor: tokens.colorPaletteBlueForeground2 },
  page: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL, padding: tokens.spacingHorizontalXL, minWidth: 0 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: tokens.spacingHorizontalL, alignItems: "start" },
  wide: { gridColumn: "1 / -1" },
  followed: { padding: `${tokens.spacingHorizontalXL} ${tokens.spacingHorizontalXL} 0` },
  hero: {
    display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalL, padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke3}`,
  },
  heroIcon: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", width: "56px", height: "56px", flexShrink: 0,
    borderRadius: tokens.borderRadiusXLarge, fontSize: "30px", color: tokens.colorNeutralForegroundOnBrand, backgroundColor: tokens.colorBrandBackground,
  },
  heroText: { display: "flex", flexDirection: "column", flexGrow: 1, minWidth: "200px" },
  muted: { color: tokens.colorNeutralForeground3 },
  chips: { display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalXS },
  chip: {
    display: "inline-flex", alignItems: "center", gap: tokens.spacingHorizontalXS, padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusCircular, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1, fontFamily: "inherit", fontSize: tokens.fontSizeBase200, cursor: "pointer",
    ":hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  tools: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  tool: { display: "flex", flexDirection: "column", padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  code: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
  instructions: { whiteSpace: "pre-wrap", lineHeight: tokens.lineHeightBase400 },
  activity: { maxHeight: "560px", overflowY: "auto" },
});

interface RailProps {
  catalog: AgentCatalog | null;
  match: MatchData;
  view: StudioView;
  language: Language;
  onView(view: StudioView): void;
}

/** The page's navigation, down its left side: the overview, each agent, and the two older views. */
export function AgentRail({ catalog, match, view, language, onView }: RailProps) {
  const styles = useStyles();
  const item = (target: StudioView, label: string, icon: ReactNode, state?: AgentState) => (
    <button key={target} type="button" className={mergeClasses(styles.railItem, view === target && styles.railCurrent)}
      aria-current={view === target ? "page" : undefined} onClick={() => onView(target)}>
      {icon}
      <span className={styles.railName}>{label}</span>
      {state && <span className={mergeClasses(styles.dot, state === "working" && styles.working, state === "idle" && styles.idle)} title={STATE_TEXT[state]} aria-hidden />}
    </button>
  );
  return (
    <nav className={mergeClasses(styles.rail, "ks-motion")} aria-label="Match intelligence">
      <MotionStyles />
      {item("overview", "Overview", <FlowRegular />)}
      <Text size={200} className={styles.railLabel}>Agents</Text>
      {catalog?.agents.map((agent) => item(agent.id, agent.name, AGENT_ICONS[agent.id], agentState(agent, match)))}
      <Text size={200} className={styles.railLabel}>Match</Text>
      {item("match", t(language, "matchTab"), <SportSoccerRegular />)}
      {item("overlay", t(language, "overlayTab"), <CodeRegular />)}
    </nav>
  );
}

interface StudioProps {
  catalog: AgentCatalog | null;
  match: MatchData;
  language: Language;
  /** The viewer's favourite player, followed by the Player Tracking Agent's card. */
  playerId: string | null;
  onFollow(playerId: string | null): void;
  onView(view: StudioView): void;
  onToggle(agentId: AgentId, enabled: boolean): void;
  problem: string | null;
}

/** Whether the viewer follows a player who is in this match: one on either team sheet. */
export function follows(match: MatchData, playerId: string | null): playerId is string {
  if (playerId === null) return false;
  const sheets = match.status ? [...match.status.home.players, ...match.status.away.players] : [];
  return sheets.some((player) => player.id === playerId) || (match.players?.players.some((player) => player.player_id === playerId) ?? false);
}

interface FollowedProps {
  match: MatchData;
  language: Language;
  playerId: string;
  view: StudioView;
  onFollow(playerId: string | null): void;
}

/**
 * The followed player's card, the pitch following them and their moments, kept above every view for
 * the rest of the match. An agent's own page that already shows one of them is not given it twice.
 */
export function FollowedPlayer({ match, language, playerId, view, onFollow }: FollowedProps) {
  const styles = useStyles();
  return (
    <section className={mergeClasses(styles.grid, styles.followed)} aria-label={t(language, "following")} data-testid="followed-player">
      {view !== "player_tracking" && <PlayerCard match={match} language={language} playerId={playerId} onChoose={onFollow} />}
      {view !== "visualization" && <PitchCard match={match} language={language} followId={playerId} />}
      <TheirMomentsCard match={match} language={language} playerId={playerId} onStop={() => onFollow(null)} />
    </section>
  );
}

/** Every agent at once: the flow, then what each has most recently found. */
export function AgentOverview({ catalog, match, language, playerId, onFollow, onView, problem }: StudioProps) {
  const styles = useStyles();
  // A followed player's card and pitch are kept above the page instead.
  const pinned = follows(match, playerId);
  return (
    <div className={styles.page}>
      {problem && (
        <MessageBar intent="error">
          <MessageBarBody>{problem}</MessageBarBody>
        </MessageBar>
      )}
      {catalog && (
        <Card title="Agent flow" extra={<Text size={200} className={styles.muted}>Select an agent to open it</Text>}>
          <AgentFlow catalog={catalog} match={match} selected={null} onSelect={onView} />
        </Card>
      )}
      <div className={styles.grid}>
        {!pinned && <div className={styles.wide}><PitchCard match={match} language={language} followId={playerId} /></div>}
        <PredictionCard match={match} language={language} />
        <TacticsCard match={match} language={language} />
        {!pinned && <PlayerCard match={match} language={language} playerId={playerId} onChoose={onFollow} />}
        <ExplanationsCard match={match} language={language} />
        <HighlightsCard match={match} language={language} />
        <Card title="Activity" extra={<HistoryRegular aria-hidden />}>
          <div className={styles.activity}><ActivityList runs={match.runs.slice(0, 14)} onPick={onView} /></div>
        </Card>
      </div>
    </div>
  );
}

function Output({ agent, match, language, playerId, onFollow }: { agent: AgentSpec; match: MatchData; language: Language; playerId: string | null; onFollow(playerId: string | null): void }) {
  switch (agent.id) {
    case "event_interpreter":
      return <PlaysCard match={match} limit={14} />;
    case "tactical_analyst":
      return <TacticsCard match={match} language={language} />;
    case "prediction":
      return <PredictionCard match={match} language={language} detailed />;
    case "explainability":
      return <ExplanationsCard match={match} language={language} limit={12} evidence />;
    case "visualization":
      return <PitchCard match={match} language={language} followId={playerId} tall />;
    case "player_tracking":
      return <PlayerCard match={match} language={language} playerId={playerId} onChoose={onFollow} detailed />;
    case "highlights":
      return <HighlightsCard match={match} language={language} limit={30} />;
  }
}

/** One agent, as Copilot Studio shows one: what it is told to do, what sets it off, its tools, and its work. */
export function AgentDetail({ agent, catalog, match, language, playerId, onFollow, onView, onToggle, problem }: StudioProps & { agent: AgentSpec; catalog: AgentCatalog }) {
  const styles = useStyles();
  const studio = useCanUseStudio();
  const state = agentState(agent, match);
  const listeners = downstream(catalog, agent.id);
  const name = (agentId: AgentId) => catalog.agents.find((other) => other.id === agentId)?.name ?? agentId;
  const link = (agentId: AgentId) => (
    <button key={agentId} type="button" className={styles.chip} onClick={() => onView(agentId)}>
      {AGENT_ICONS[agentId]}{name(agentId)}
    </button>
  );
  return (
    <div className={styles.page} key={agent.id}>
      {problem && (
        <MessageBar intent="error">
          <MessageBarBody>{problem}</MessageBarBody>
        </MessageBar>
      )}
      <header className={mergeClasses(styles.hero, "ks-motion")} style={{ animation: rise() }}>
        <span className={styles.heroIcon} aria-hidden>{AGENT_ICONS[agent.id]}</span>
        <div className={styles.heroText}>
          <Text as="h2" size={600} weight="semibold">{agent.name}</Text>
          <Text className={styles.muted}>{agent.description}</Text>
        </div>
        <Badge appearance="tint" color={state === "working" ? "success" : state === "off" ? "subtle" : "informative"} data-testid="agent-state">{STATE_TEXT[state]}</Badge>
        {agent.id === "explainability" && <Badge appearance="outline">{catalog.model ? "Written by a model" : "Written from a script"}</Badge>}
        <Switch label={agent.enabled ? "On" : "Off"} checked={agent.enabled} aria-label={`${agent.name} on`} disabled={!studio}
          onChange={(_, data) => onToggle(agent.id, data.checked)} />
      </header>
      {!agent.enabled && listeners.length > 0 && (
        <MessageBar intent="warning">
          <MessageBarBody>While this agent is off, {listeners.map((other) => other.name).join(", ")} {listeners.length === 1 ? "has" : "have"} less to work on.</MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.grid}>
        <Card title="Instructions" extra={<AppsListDetailRegular aria-hidden />}>
          <Text className={styles.instructions}>{agent.instructions}</Text>
        </Card>
        <Card title="Triggers and outputs">
          <Text size={200} className={styles.muted}>Runs when it receives</Text>
          <div className={styles.chips}>{agent.triggers.map((trigger) => <Badge key={trigger} appearance="tint" color="brand" className={styles.code}>{trigger}</Badge>)}</div>
          <Text size={200} className={styles.muted}>Produces</Text>
          <div className={styles.chips}>{agent.outputs.map((output) => <Badge key={output} appearance="tint" color="success" className={styles.code}>{output}</Badge>)}</div>
          <Text size={200} className={styles.muted}>Connected agents</Text>
          <div className={styles.chips} aria-label="Connected agents">
            {agent.upstream.length === 0 && listeners.length === 0 && <Text size={200}>None</Text>}
            {agent.upstream.map((agentId) => link(agentId))}
            {listeners.map((other) => link(other.id))}
          </div>
          <Text size={200} className={styles.muted}>
            {agent.upstream.length > 0 ? `Listens to ${agent.upstream.map(name).join(", ")}.` : "Listens to the match feed."}
            {listeners.length > 0 ? ` Heard by ${listeners.map((other) => other.name).join(", ")}.` : ""}
          </Text>
        </Card>
        <Card title="Tools">
          <ul className={styles.tools}>
            {agent.tools.map((tool) => (
              <li key={tool.name} className={styles.tool}>
                <Text weight="semibold" className={styles.code}>{tool.name}</Text>
                <Text size={200}>{tool.description}</Text>
              </li>
            ))}
          </ul>
        </Card>
        <div className={styles.wide}><Output agent={agent} match={match} language={language} playerId={playerId} onFollow={onFollow} /></div>
        <div className={styles.wide}>
          <Card title="Activity" extra={<HistoryRegular aria-hidden />}>
            <div className={styles.activity}><ActivityList runs={runsOf(match.runs, agent.id).slice(0, 20)} /></div>
          </Card>
        </div>
      </div>
    </div>
  );
}
