import { makeStyles, tokens } from "@fluentui/react-components";
import type { MatchEvent, MatchStatus, PressureSnapshot } from "../contracts";
import { type Language, t } from "../i18n";

const WIDTH = 100;
const HEIGHT = 64;
const MAX_MARKERS = 12;
const MAX_HEAT_OPACITY = 0.6;
const DEFAULT_COLORS = { home: "#0F6CBD", away: "#C50F1F" };

const useStyles = makeStyles({
  root: { width: "100%", display: "block", borderRadius: tokens.borderRadiusMedium },
});

export interface HeatCell {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  side: "home" | "away";
  opacity: number;
}

/** One cell per zone where a side has the upper hand, shaded by how large the difference is. */
export function heatCells(pressure: PressureSnapshot): HeatCell[] {
  const net = pressure.home.map((home, index) => home - (pressure.away[index] ?? 0));
  const peak = Math.max(1, ...net.map(Math.abs));
  const width = WIDTH / pressure.cols;
  const height = HEIGHT / pressure.rows;
  return net.flatMap((value, index) =>
    value === 0
      ? []
      : [{
          index,
          x: (index % pressure.cols) * width,
          y: Math.floor(index / pressure.cols) * height,
          width,
          height,
          side: value > 0 ? ("home" as const) : ("away" as const),
          opacity: (Math.abs(value) / peak) * MAX_HEAT_OPACITY,
        }],
  );
}

interface PitchProps {
  events: MatchEvent[];
  pressure: PressureSnapshot | null;
  status: MatchStatus | null;
  showPressure: boolean;
  language: Language;
}

export function Pitch({ events, pressure, status, showPressure, language }: PitchProps) {
  const styles = useStyles();
  const colors = status ? { home: status.home.color, away: status.away.color } : DEFAULT_COLORS;
  const markers = events.filter((event) => event.team).slice(-MAX_MARKERS);
  const cells = showPressure && pressure ? heatCells(pressure) : [];
  return (
    <svg className={styles.root} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={t(language, "pitch")}>
      <rect width={WIDTH} height={HEIGHT} fill="#2E7D32" />
      <g fill="none" stroke="#FFFFFF" strokeWidth={0.4} opacity={0.75}>
        <rect x={1} y={1} width={WIDTH - 2} height={HEIGHT - 2} />
        <line x1={WIDTH / 2} y1={1} x2={WIDTH / 2} y2={HEIGHT - 1} />
        <circle cx={WIDTH / 2} cy={HEIGHT / 2} r={8} />
        <rect x={1} y={HEIGHT / 2 - 14} width={15} height={28} />
        <rect x={WIDTH - 16} y={HEIGHT / 2 - 14} width={15} height={28} />
      </g>
      {cells.map((cell) => (
        <rect key={cell.index} data-testid="heat" x={cell.x} y={cell.y} width={cell.width} height={cell.height}
          fill={colors[cell.side]} opacity={cell.opacity} />
      ))}
      {markers.map((event, index) => (
        <circle key={event.id} data-testid="marker" cx={event.x} cy={(event.y / 100) * HEIGHT}
          r={event.type === "goal" ? 2.2 : 1.2} fill={colors[event.team as "home" | "away"]} stroke="#FFFFFF"
          strokeWidth={0.3} opacity={0.35 + (0.65 * (index + 1)) / markers.length}>
          <title>{event.type}</title>
        </circle>
      ))}
    </svg>
  );
}
