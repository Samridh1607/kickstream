import type { CSSProperties } from "react";
import { SETTLE, useTween } from "../motion/motion";

/**
 * Small charts drawn in SVG and HTML, used on the broadcast canvas and on the match page.
 *
 * Colour follows the side, never its rank: the home and away colours come from the team sheets,
 * and a draw is a neutral grey. Values and labels are always written out in text ink, so nothing
 * is told by colour alone.
 */

export const NEUTRAL = "#8A8F98";

export interface Sides {
  home: string;
  away: string;
}

const TRACK = "color-mix(in srgb, currentColor 14%, transparent)";
const MUTED: CSSProperties = { opacity: 0.72 };
const tabular: CSSProperties = { fontVariantNumeric: "tabular-nums" };

/** A number that counts to its value. `digits` fixes the decimals shown. */
export function Counted({ value, digits = 0, suffix = "" }: { value: number; digits?: number; suffix?: string }) {
  const shown = useTween(value);
  return <span style={tabular}>{shown.toFixed(digits)}{suffix}</span>;
}

export interface CompareRow {
  id: string;
  label: string;
  home: number;
  away: number;
  digits?: number;
  suffix?: string;
}

/** One row per measure: the two sides' values, and a bar split in their proportion. */
export function CompareBars({ rows, colors, names }: { rows: CompareRow[]; colors: Sides; names: Sides }) {
  return (
    <div role="table" aria-label={`${names.home} compared with ${names.away}`} style={{ display: "flex", flexDirection: "column", gap: "0.7em", width: "100%" }}>
      <div role="row" style={{ display: "flex", justifyContent: "space-between", fontWeight: 600 }}>
        <span role="columnheader" style={{ display: "inline-flex", alignItems: "center", gap: "0.4em" }}><Swatch color={colors.home} />{names.home}</span>
        <span role="columnheader" style={{ display: "inline-flex", alignItems: "center", gap: "0.4em" }}>{names.away}<Swatch color={colors.away} /></span>
      </div>
      {rows.map((row) => {
        const total = row.home + row.away;
        const share = total === 0 ? 50 : (row.home / total) * 100;
        return (
          <div role="row" key={row.id} data-testid={`compare-${row.id}`}>
            <div style={{ display: "grid", gridTemplateColumns: "4em 1fr 4em", alignItems: "baseline" }}>
              <span role="cell" style={{ fontWeight: 700 }}><Counted value={row.home} digits={row.digits} suffix={row.suffix} /></span>
              <span role="rowheader" style={{ textAlign: "center", fontSize: "0.8em", ...MUTED }}>{row.label}</span>
              <span role="cell" style={{ fontWeight: 700, textAlign: "right" }}><Counted value={row.away} digits={row.digits} suffix={row.suffix} /></span>
            </div>
            <div aria-hidden style={{ display: "flex", gap: 2, height: "0.42em", marginTop: "0.25em" }}>
              <div style={{ width: `${share}%`, minWidth: 4, borderRadius: 4, backgroundColor: colors.home, transition: `width ${SETTLE}` }} />
              <div style={{ flex: 1, minWidth: 4, borderRadius: 4, backgroundColor: colors.away }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Swatch({ color }: { color: string }) {
  return <span aria-hidden style={{ display: "inline-block", width: "0.7em", height: "0.7em", borderRadius: 3, backgroundColor: color, flexShrink: 0 }} />;
}

export interface Part {
  id: string;
  label: string;
  value: number;
  color: string;
}

/** Parts of a whole on one bar, each labelled with its share beneath. */
export function ShareBar({ parts, label }: { parts: Part[]; label: string }) {
  const total = parts.reduce((sum, part) => sum + part.value, 0) || 1;
  return (
    <div role="group" aria-label={label} style={{ width: "100%" }}>
      <div aria-hidden style={{ display: "flex", gap: 2, height: "0.9em" }}>
        {parts.map((part) => (
          <div key={part.id} style={{ width: `${(part.value / total) * 100}%`, minWidth: 4, borderRadius: 4, backgroundColor: part.color, transition: `width ${SETTLE}` }} />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "1em", marginTop: "0.45em" }}>
        {parts.map((part) => (
          <span key={part.id} data-testid={`share-${part.id}`} style={{ display: "inline-flex", flexDirection: "column", minWidth: 0 }}>
            <span style={{ fontWeight: 700, fontSize: "1.3em" }}><Counted value={(part.value / total) * 100} suffix="%" /></span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35em", fontSize: "0.75em", ...MUTED }}><Swatch color={part.color} />{part.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** A ring split between the two sides, with the home side's share in the middle. */
export function Donut({ home, away, colors, names, label }: { home: number; away: number; colors: Sides; names: Sides; label: string }) {
  const total = home + away || 1;
  const share = home / total;
  const radius = 42;
  const around = 2 * Math.PI * radius;
  const gap = 3;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "1.2em", width: "100%", height: "100%" }}>
      <svg viewBox="0 0 100 100" role="img" aria-label={`${label}: ${names.home} ${Math.round(share * 100)}%, ${names.away} ${Math.round((1 - share) * 100)}%`} style={{ height: "100%", maxHeight: "9em", flexShrink: 0 }}>
        <g transform="rotate(-90 50 50)" fill="none" strokeWidth={11}>
          <circle cx={50} cy={50} r={radius} stroke={colors.away} />
          <circle cx={50} cy={50} r={radius} stroke={colors.home} strokeDasharray={`${Math.max(0, share * around - gap)} ${around}`} style={{ transition: `stroke-dasharray ${SETTLE}` }} />
        </g>
        <text x={50} y={49} textAnchor="middle" fontSize={20} fontWeight={700} fill="currentColor">{Math.round(share * 100)}%</text>
        <text x={50} y={63} textAnchor="middle" fontSize={7} fill="currentColor" opacity={0.7}>{label}</text>
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5em", minWidth: 0 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4em" }}><Swatch color={colors.home} />{names.home} <b><Counted value={share * 100} suffix="%" /></b></span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4em" }}><Swatch color={colors.away} />{names.away} <b><Counted value={(1 - share) * 100} suffix="%" /></b></span>
      </div>
    </div>
  );
}

export interface Line {
  id: string;
  label: string;
  color: string;
  /** One value per x; null where there is nothing to draw yet. */
  values: (number | null)[];
}

interface LineGraphProps {
  lines: Line[];
  /** The x of each value, such as the match minute. */
  xs: number[];
  /** The x-axis runs from 0 to this. */
  xMax: number;
  yMin: number;
  yMax: number;
  /** Draws a faint line at this y, and fills a single line down to it. */
  baseline?: number;
  label: string;
  format?(value: number): string;
  xLabel?(x: number): string;
  /** The colour behind the graph, which rings each end dot so it stands clear of the lines. */
  surface?: string;
}

const LABEL_ROOM = "3.4em"; // right of the plot, for each line's latest value
const AXIS_ROOM = "1.3em";

/**
 * Lines over time on one shared axis. Each line is labelled at its end with its latest value.
 * The lines are an SVG stretched to the box; the dots and text are HTML placed over it, so they
 * keep their shape whatever the box's proportions.
 */
export function LineGraph({ lines, xs, xMax, yMin, yMax, baseline, label, format = (value) => value.toFixed(1), xLabel = (x) => `${x}'`, surface = "#101828" }: LineGraphProps) {
  const px = (x: number) => (Math.min(x, xMax) / (xMax || 1)) * 100;
  const py = (y: number) => (1 - (Math.max(yMin, Math.min(yMax, y)) - yMin) / (yMax - yMin || 1)) * 100;
  const drawn = lines.map((line) => {
    const points = line.values.flatMap((value, index) => (value === null || xs[index] === undefined ? [] : [{ x: px(xs[index]), y: py(value), value }]));
    return { line, points, path: points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ") };
  });
  // End labels that would sit on top of one another are spread apart, keeping their order.
  const ends = drawn.filter(({ points }) => points.length > 0).map(({ line, points }) => ({ line, last: points[points.length - 1], y: points[points.length - 1].y }));
  const summary = ends.map(({ line, last }) => `${line.label} ${format(last.value)}`).join(", ");
  ends.sort((a, b) => a.y - b.y);
  for (let index = 1; index < ends.length; index += 1) ends[index].y = Math.max(ends[index].y, ends[index - 1].y + 16);
  const base = baseline === undefined ? null : py(baseline);
  const ticks = [0, 0.5, 1].map((share) => Math.round(share * xMax));
  return (
    <figure role="img" aria-label={summary ? `${label}: ${summary}` : `${label}: no data yet`}
      style={{ margin: 0, width: "100%", height: "100%", display: "flex", flexDirection: "column", gap: "0.3em" }}>
      <figcaption style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.9em", fontSize: "0.8em" }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        {lines.length > 1 && lines.map((line) => (
          <span key={line.id} style={{ display: "inline-flex", alignItems: "center", gap: "0.35em", ...MUTED }}><Swatch color={line.color} />{line.label}</span>
        ))}
      </figcaption>
      <div style={{ position: "relative", flex: 1, minHeight: 0, marginRight: LABEL_ROOM, marginBottom: AXIS_ROOM }}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}>
          <line x1={0} x2={100} y1={100} y2={100} stroke={TRACK} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {base !== null && <line x1={0} x2={100} y1={base} y2={base} stroke={TRACK} strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
          {drawn.map(({ line, points, path }) => (
            <g key={line.id} data-testid={`line-${line.id}`}>
              {lines.length === 1 && base !== null && points.length > 1 && (
                <path d={`${path} L${points[points.length - 1].x.toFixed(2)} ${base} L${points[0].x.toFixed(2)} ${base} Z`} fill={line.color} opacity={0.18} />
              )}
              <path d={path} fill="none" stroke={line.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            </g>
          ))}
        </svg>
        {ends.map(({ line, last, y }) => (
          <span key={line.id} aria-hidden>
            <span style={{ position: "absolute", left: `${last.x}%`, top: `${last.y}%`, width: 9, height: 9, margin: "-4.5px 0 0 -4.5px", borderRadius: "50%", backgroundColor: line.color, boxShadow: `0 0 0 2px ${surface}`, transition: `left ${SETTLE}, top ${SETTLE}` }} />
            <span data-testid={`end-${line.id}`} style={{ position: "absolute", left: `${last.x}%`, top: `${Math.min(y, 100)}%`, transform: "translate(0.6em, -50%)", fontSize: "0.8em", fontWeight: 700, whiteSpace: "nowrap", transition: `left ${SETTLE}, top ${SETTLE}`, ...tabular }}>
              {format(last.value)}
            </span>
          </span>
        ))}
        {ticks.map((tick) => (
          <span key={tick} aria-hidden style={{ position: "absolute", top: "100%", left: `${px(tick)}%`, transform: `translateX(${tick === 0 ? "0" : tick === xMax ? "-100%" : "-50%"})`, paddingTop: "0.15em", fontSize: "0.7em", ...MUTED }}>
            {xLabel(tick)}
          </span>
        ))}
      </div>
    </figure>
  );
}

/** A grid of cells shaded by one value, 0 to 1: a single hue from faint to strong. */
export function HeatGrid({ cols, rows, values, color, label }: { cols: number; rows: number; values: number[]; color: string; label: string }) {
  const peak = Math.max(1e-9, ...values);
  return (
    <div role="img" aria-label={label} style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)`, gap: 2, width: "100%", aspectRatio: `${cols * 1.05} / ${rows * 0.68}` }}>
      {Array.from({ length: cols * rows }, (_, index) => (
        <div key={index} style={{ borderRadius: 3, backgroundColor: color, opacity: 0.08 + 0.92 * ((values[index] ?? 0) / peak), transition: `opacity ${SETTLE}` }} />
      ))}
    </div>
  );
}
