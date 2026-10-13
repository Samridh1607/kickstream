import { makeStyles, mergeClasses, Text, tokens } from "@fluentui/react-components";
import { FlashRegular, VideoRegular } from "@fluentui/react-icons";
import type { ReactElement } from "react";
import type { AgentCatalog } from "../contracts";
import { MotionStyles } from "../motion/motion";
import type { MatchData } from "../stream/store";
import { type AgentId, type AgentState, agentState } from "./api";
import { AGENT_ICONS } from "./cards";

// The flow is laid out on a 1000 x 400 board and scaled to the box it is given.
const BOARD = { width: 1000, height: 400 };
const NODE = { width: 176, height: 64 };

type NodeId = AgentId | "feed" | "moments";

const PLACE: Record<NodeId, { x: number; y: number }> = {
  feed: { x: 96, y: 130 },
  moments: { x: 96, y: 330 },
  event_interpreter: { x: 300, y: 130 },
  tactical_analyst: { x: 520, y: 44 },
  prediction: { x: 520, y: 130 },
  player_tracking: { x: 520, y: 216 },
  visualization: { x: 520, y: 302 },
  highlights: { x: 724, y: 330 },
  explainability: { x: 904, y: 130 },
};

const SOURCES: { id: "feed" | "moments"; name: string; detail: string; icon: ReactElement; feeds: AgentId }[] = [
  { id: "feed", name: "Match feed", detail: "Detections", icon: <VideoRegular />, feeds: "event_interpreter" },
  { id: "moments", name: "Analytics", detail: "Key moments", icon: <FlashRegular />, feeds: "highlights" },
];

const STATE_LABEL: Record<AgentState, string> = { off: "Off", working: "Working", idle: "Idle" };

const useStyles = makeStyles({
  scroll: { overflowX: "auto" },
  board: { position: "relative", minWidth: "760px", aspectRatio: `${BOARD.width} / ${BOARD.height}` },
  edges: { position: "absolute", inset: 0, width: "100%", height: "100%" },
  node: {
    position: "absolute", display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS, boxSizing: "border-box",
    padding: `0 ${tokens.spacingHorizontalS}`, borderRadius: tokens.borderRadiusLarge, textAlign: "left", fontFamily: "inherit",
    color: tokens.colorNeutralForeground1, backgroundColor: tokens.colorNeutralBackground1,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`, boxShadow: tokens.shadow4,
    transitionProperty: "transform, box-shadow, border-color, opacity", transitionDuration: "200ms",
  },
  agent: {
    cursor: "pointer",
    ":hover": { boxShadow: tokens.shadow16, border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke1}` },
    ":focus-visible": { outline: `${tokens.strokeWidthThick} solid ${tokens.colorStrokeFocus2}` },
  },
  source: { backgroundColor: tokens.colorNeutralBackground3, borderTopStyle: "dashed", borderRightStyle: "dashed", borderBottomStyle: "dashed", borderLeftStyle: "dashed" },
  selected: { border: `${tokens.strokeWidthThick} solid ${tokens.colorBrandStroke1}`, boxShadow: tokens.shadow16 },
  off: { opacity: 0.55 },
  icon: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", width: "30px", height: "30px", flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium, fontSize: "18px", color: tokens.colorBrandForeground1, backgroundColor: tokens.colorBrandBackground2,
  },
  text: { display: "flex", flexDirection: "column", minWidth: 0, lineHeight: 1.2 },
  name: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  state: { display: "inline-flex", alignItems: "center", gap: tokens.spacingHorizontalXXS, color: tokens.colorNeutralForeground3 },
  dot: { width: "8px", height: "8px", borderRadius: "50%", backgroundColor: tokens.colorNeutralForeground4 },
  working: { backgroundColor: tokens.colorPaletteGreenForeground1, animationName: "ks-pulse", animationDuration: "1.2s", animationIterationCount: "infinite" },
  idle: { backgroundColor: tokens.colorPaletteBlueForeground2 },
});

/** A curve from the right edge of one node to the left edge of the next. Every edge runs left to right. */
function path(from: NodeId, to: NodeId): string {
  const a = PLACE[from];
  const b = PLACE[to];
  const startX = a.x + NODE.width / 2;
  const endX = b.x - NODE.width / 2;
  const bend = (endX - startX) / 2;
  return `M${startX} ${a.y} C${startX + bend} ${a.y} ${endX - bend} ${b.y} ${endX} ${b.y}`;
}

interface AgentFlowProps {
  catalog: AgentCatalog;
  match: MatchData;
  selected: AgentId | null;
  onSelect(agentId: AgentId): void;
}

/** The agents as a flow: who listens to whom, with the edges moving where work is being handed on. */
export function AgentFlow({ catalog, match, selected, onSelect }: AgentFlowProps) {
  const styles = useStyles();
  const states = new Map(catalog.agents.map((agent) => [agent.id, agentState(agent, match)]));
  const edges: { from: NodeId; to: AgentId; flowing: boolean }[] = [
    ...SOURCES.map((source) => ({ from: source.id as NodeId, to: source.feeds, flowing: states.get(source.feeds) === "working" })),
    ...catalog.agents.flatMap((agent) =>
      agent.upstream.map((from) => ({ from: from as NodeId, to: agent.id, flowing: states.get(agent.id) === "working" && states.get(from) !== "off" })),
    ),
  ];
  const position = (id: NodeId) => ({
    left: `${(PLACE[id].x / BOARD.width) * 100}%`, top: `${(PLACE[id].y / BOARD.height) * 100}%`,
    width: `${(NODE.width / BOARD.width) * 100}%`, height: `${(NODE.height / BOARD.height) * 100}%`, transform: "translate(-50%, -50%)",
  });
  return (
    <div className={mergeClasses(styles.scroll, "ks-motion")}>
      <MotionStyles />
      <div className={styles.board} data-testid="agent-flow">
        <svg className={styles.edges} viewBox={`0 0 ${BOARD.width} ${BOARD.height}`} preserveAspectRatio="none" aria-hidden>
          {edges.map((edge) => (
            <path key={`${edge.from}-${edge.to}`} data-testid="flow-edge" data-flowing={edge.flowing} d={path(edge.from, edge.to)} fill="none" strokeLinecap="round"
              stroke={edge.flowing ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke1} strokeWidth={edge.flowing ? 2.5 : 1.5}
              strokeDasharray={edge.flowing ? "8 4" : undefined} vectorEffect="non-scaling-stroke"
              style={{ animation: edge.flowing ? "ks-flow 800ms linear infinite" : undefined, transition: "stroke 300ms ease" }} />
          ))}
        </svg>
        {SOURCES.map((source) => (
          <div key={source.id} className={mergeClasses(styles.node, styles.source)} style={position(source.id)}>
            <span className={styles.icon} aria-hidden>{source.icon}</span>
            <span className={styles.text}>
              <Text size={200} weight="semibold" className={styles.name}>{source.name}</Text>
              <Text size={100} className={styles.state}>{source.detail}</Text>
            </span>
          </div>
        ))}
        {catalog.agents.map((agent) => {
          const state = states.get(agent.id) ?? "idle";
          return (
            <button key={agent.id} type="button" data-testid={`flow-${agent.id}`} data-state={state} aria-pressed={selected === agent.id}
              aria-label={`${agent.name}: ${STATE_LABEL[state]}`}
              className={mergeClasses(styles.node, styles.agent, selected === agent.id && styles.selected, state === "off" && styles.off)}
              style={position(agent.id)} onClick={() => onSelect(agent.id)}>
              <span className={styles.icon} aria-hidden>{AGENT_ICONS[agent.id]}</span>
              <span className={styles.text}>
                <Text size={200} weight="semibold" className={styles.name}>{agent.name}</Text>
                <Text size={100} className={styles.state}>
                  <span className={mergeClasses(styles.dot, state === "working" && styles.working, state === "idle" && styles.idle)} aria-hidden />
                  {STATE_LABEL[state]}
                </Text>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
