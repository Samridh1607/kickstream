import {
  ArrowResetRegular, ArrowRotateClockwiseRegular, ArrowRotateCounterclockwiseRegular, ChevronDownRegular, ChevronUpRegular, ZoomInRegular,
  ZoomOutRegular,
} from "@fluentui/react-icons";
import {
  type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState,
} from "react";
import type { DangerColumn, PassLane, PitchScene, Point3, ScenePlayer } from "../contracts";
import { EASE } from "../motion/motion";

export type Camera = PitchScene["camera"];

const DEFAULT_COLORS = { home: "#0F6CBD", away: "#C50F1F" };
const GOLD = "#FFB900";
const CHALK = "#F4F6F8";

// The stadium is drawn in world pixels, ten to the metre; the whole camera is then scaled to fit its box.
const M = 10;
const LENGTH = 105 * M;
const WIDTH = 68 * M;
const APRON = 6 * M;
const BOARD = 1.1 * M;
const STAND = { depth: 11 * M, height: 6 * M };
const GOAL = { width: 7.32 * M, height: 3 * M, depth: 2.2 * M };
const FIGURE = { width: 34, height: 54 }; // larger than life, so a player can be read at a glance
const LIFT = 1.6 * M; // how high a metre of the ball's flight is drawn
const DEPTH = 1900; // the perspective distance
const MOVE = `620ms ${EASE}`;
const FLIGHT = "620ms linear";
const CAMERA_MOVE = `800ms ${EASE}`;

interface Pose {
  tilt: number;
  turn: number;
}

/** How the pitch is turned for each view: tilted away, and for the attacking views swung round behind the side going forward. */
const POSES: Record<Camera, Pose> = {
  broadcast: { tilt: 56, turn: 0 },
  tactical: { tilt: 14, turn: 0 },
  attack_home: { tilt: 60, turn: -28 },
  attack_away: { tilt: 60, turn: 28 },
};

/** The viewer's own turn of the camera, on top of the view's pose. */
interface Orbit {
  turn: number;
  tilt: number;
  zoom: number;
}

const LEVEL: Orbit = { turn: 0, tilt: 0, zoom: 1 };
const TURN_LIMIT = 75;
const TILT_RANGE = [6, 76] as const;
const ZOOM_RANGE = [0.8, 2.6] as const;
const STEP = { turn: 15, tilt: 8, zoom: 1.25 };

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const round = (value: number) => Math.round(value * 100) / 100;

function bounded(pose: Pose, orbit: Orbit): Orbit {
  return {
    turn: clamp(orbit.turn, -TURN_LIMIT, TURN_LIMIT),
    tilt: clamp(pose.tilt + orbit.tilt, TILT_RANGE[0], TILT_RANGE[1]) - pose.tilt,
    zoom: clamp(orbit.zoom, ZOOM_RANGE[0], ZOOM_RANGE[1]),
  };
}

type Vec = [number, number, number];

/** Where a point, measured from the centre spot with z up off the grass, lands on screen: the same sums as the CSS transforms. */
function project({ tilt, turn }: Pose, [x, y, z]: Vec): [number, number] {
  const r = (turn * Math.PI) / 180;
  const t = (tilt * Math.PI) / 180;
  const across = x * Math.cos(r) - y * Math.sin(r);
  const along = x * Math.sin(r) + y * Math.cos(r);
  const toward = along * Math.sin(t) + z * Math.cos(t);
  const near = DEPTH / (DEPTH - toward);
  return [across * near, (along * Math.cos(t) - z * Math.sin(t)) * near];
}

/** The outermost points of everything drawn: the apron, whatever stands on the pitch, and the top of the stand. */
function hull(standing: number): Vec[] {
  const ex = LENGTH / 2 + APRON;
  const ey = WIDTH / 2 + APRON;
  const corners = (x: number, y: number, z: number): Vec[] => [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]];
  return [
    ...corners(ex, ey, 0), ...corners(LENGTH / 2, WIDTH / 2, standing),
    [-ex, -ey - STAND.depth, STAND.height], [ex, -ey - STAND.depth, STAND.height],
  ];
}

interface Box {
  width: number;
  height: number;
}

interface Framing {
  scale: number;
  x: number;
  y: number;
}

/** Scales and centres the camera so the whole stadium fits the box; zooming in draws the view towards the ball. */
function frame(pose: Pose, box: Box, standing: number, zoom: number, focus: Vec): Framing {
  const points = hull(standing).map((point) => project(pose, point));
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = Math.min((box.width * 0.95) / (right - left), (box.height * 0.93) / (bottom - top)) * zoom;
  const [fx, fy] = project(pose, focus);
  const toward = 1 - 1 / zoom;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  return { scale, x: -(cx + (fx - cx) * toward) * scale, y: -(cy + (fy - cy) * toward) * scale };
}

const STYLES = `
.ks-pitch3d .ks-p3 { position: absolute; width: 0; height: 0; transform-style: preserve-3d; }
.ks-pitch3d .ks-face { position: absolute; transform: var(--ks-face); transform-origin: 50% 100%; transition: transform var(--ks-cam); }
.ks-pitch3d .ks-ground { position: absolute; transform: translateZ(1px); pointer-events: none; }
.ks-pitch3d .ks-figure { position: absolute; inset: 0; transform: scale(var(--ks-fig)); transform-origin: 50% 100%; }
.ks-pitch3d .ks-ring { animation: ks-pitch-ring 1.6s ease-in-out infinite; }
.ks-pitch3d .ks-flow { animation: ks-pitch-flow 1.4s linear infinite; }
.ks-pitch3d .ks-hop { animation: ks-pitch-hop 620ms both; }
.ks-pitch3d .ks-landing { animation: ks-pitch-landing 620ms both; }
.ks-pitch3d:focus-visible { outline: 2px solid #FFFFFF; outline-offset: -2px; }
.ks-pitch3d-tools { position: absolute; top: 8px; right: 8px; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 8px;
  background: rgba(8, 14, 26, 0.72); border: 1px solid rgba(255, 255, 255, 0.14); backdrop-filter: blur(6px); }
.ks-pitch3d-tools hr { width: 1px; height: 18px; margin: 0 2px; border: 0; background: rgba(255, 255, 255, 0.18); }
.ks-pitch3d-tool { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; cursor: pointer;
  background: transparent; color: #FFFFFF; font-size: 18px; }
.ks-pitch3d-tool:hover:not(:disabled) { background: rgba(255, 255, 255, 0.14); }
.ks-pitch3d-tool:focus-visible { outline: 2px solid #FFFFFF; outline-offset: -2px; }
.ks-pitch3d-tool:disabled { opacity: 0.38; cursor: default; }
@keyframes ks-pitch-hop {
  0% { transform: translateZ(0); animation-timing-function: cubic-bezier(0.33, 0.67, 0.67, 1); }
  50% { transform: translateZ(var(--peak)); animation-timing-function: cubic-bezier(0.33, 0, 0.67, 0.33); }
  100% { transform: translateZ(0); }
}
@keyframes ks-pitch-landing { 50% { transform: translateZ(1px) scale(0.55); opacity: 0.45; } }
@keyframes ks-pitch-ring { 0%, 100% { transform: translateZ(2px) scale(1); opacity: 1; } 50% { transform: translateZ(2px) scale(1.3); opacity: 0.45; } }
@keyframes ks-pitch-flow { to { stroke-dashoffset: -42; } }
@media (prefers-reduced-motion: reduce) {
  .ks-pitch3d, .ks-pitch3d * { transition: none !important; animation: none !important; }
}
`;

interface WallProps {
  x: number;
  y: number;
  /** The direction the wall runs from (x, y), clockwise from the length of the pitch. */
  angle: number;
  width: number;
  height: number;
  /** How far up from the grass it stands: 90 is upright. */
  lean?: number;
  style?: CSSProperties;
  children?: ReactNode;
}

/** A plane standing on the pitch. */
function Wall({ x, y, angle, width, height, lean = 90, style, children }: WallProps) {
  return (
    <div className="ks-p3" style={{ left: x, top: y, transform: `rotateZ(${angle}deg)` }}>
      <div style={{ position: "absolute", left: 0, bottom: 0, width, height, transformOrigin: "0 100%", transform: `rotateX(${-lean}deg)`, ...style }}>
        {children}
      </div>
    </div>
  );
}

const NET: CSSProperties = {
  backgroundColor: "rgba(255, 255, 255, 0.06)",
  backgroundImage: "repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.34) 0 1px, transparent 1px 5px), repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.34) 0 1px, transparent 1px 5px)",
};
const FRAME: CSSProperties = { boxSizing: "border-box", border: `3px solid ${CHALK}`, borderBottom: 0, boxShadow: "0 0 6px rgba(255, 255, 255, 0.4)" };

function Goal({ end }: { end: "left" | "right" }) {
  const line = end === "left" ? 0 : LENGTH;
  const back = end === "left" ? -GOAL.depth : LENGTH + GOAL.depth;
  const outward = end === "left" ? 180 : 0;
  const top = (WIDTH - GOAL.width) / 2;
  const floor = { left: Math.min(line, back), top, width: GOAL.depth, height: GOAL.width };
  return (
    <div className="ks-p3" data-testid="pitch-goal" data-end={end}>
      <div className="ks-ground" style={{ ...floor, background: "rgba(0, 0, 0, 0.22)" }} />
      <Wall x={back} y={top} angle={90} width={GOAL.width} height={GOAL.height} style={NET} />
      <Wall x={line} y={top} angle={outward} width={GOAL.depth} height={GOAL.height} style={NET} />
      <Wall x={line} y={top + GOAL.width} angle={outward} width={GOAL.depth} height={GOAL.height} style={NET} />
      <div style={{ position: "absolute", ...floor, transform: `translateZ(${GOAL.height}px)`, ...NET }} />
      <Wall x={line} y={top} angle={90} width={GOAL.width} height={GOAL.height} style={FRAME} />
    </div>
  );
}

function Flag({ x, y }: { x: number; y: number }) {
  return (
    <div className="ks-p3" data-testid="corner-flag" style={{ left: x, top: y }}>
      <div className="ks-face" style={{ left: -7, bottom: 0, width: 14, height: 30 }}>
        <div style={{ position: "absolute", left: 6, bottom: 0, width: 2, height: 30, background: CHALK }} />
        <div style={{ position: "absolute", left: 8, top: 0, width: 11, height: 8, background: GOLD, clipPath: "polygon(0 0, 100% 50%, 0 100%)" }} />
      </div>
    </div>
  );
}

const BOARDS: CSSProperties = {
  background: "linear-gradient(180deg, rgba(255, 255, 255, 0.28), rgba(255, 255, 255, 0) 45%), repeating-linear-gradient(90deg, #123C7A 0 140px, #0F6CBD 140px 280px, #4A2A86 280px 420px)",
  boxShadow: "inset 0 -2px 0 rgba(0, 0, 0, 0.45)",
};
const SEATS: CSSProperties = {
  background: [
    "linear-gradient(to top, rgba(11, 18, 32, 0), rgba(11, 18, 32, 0.9))",
    "radial-gradient(circle, rgba(255, 255, 255, 0.16) 1px, transparent 1.6px) 0 0 / 7px 6px",
    "repeating-linear-gradient(0deg, #1B2A40 0 7px, #24364F 7px 10px)",
  ].join(", "),
};

/** The boards round the pitch and a stand behind the far touchline. */
function Stadium() {
  const run = LENGTH + 2 * APRON;
  const across = WIDTH + 2 * APRON;
  const slope = Math.hypot(STAND.depth, STAND.height);
  const rake = (Math.atan2(STAND.height, STAND.depth) * 180) / Math.PI;
  return (
    <>
      <Wall x={-APRON} y={-APRON - 2} angle={0} width={run} height={slope} lean={rake} style={SEATS} />
      <Wall x={-APRON} y={-APRON} angle={0} width={run} height={BOARD} style={BOARDS} />
      <Wall x={LENGTH + APRON} y={-APRON} angle={90} width={across} height={BOARD} style={BOARDS} />
      <Wall x={LENGTH + APRON} y={WIDTH + APRON} angle={180} width={run} height={BOARD} style={BOARDS} />
      <Wall x={-APRON} y={WIDTH + APRON} angle={270} width={across} height={BOARD} style={BOARDS} />
    </>
  );
}

const at = (point: { x: number; y: number }): [number, number] => [(point.x / 100) * LENGTH, (point.y / 100) * WIDTH];

/** A smooth path through the points: Catmull-Rom, drawn as cubic curves. */
function smooth(points: [number, number][]): string {
  const f = (value: number) => round(value).toString();
  let path = `M${f(points[0][0])} ${f(points[0][1])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const [p0, p1, p2, p3] = [points[Math.max(0, i - 1)], points[i], points[i + 1], points[Math.min(points.length - 1, i + 2)]];
    path += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return path;
}

/** The ball's last flight, drawn in the upright plane over its path along the ground. */
function Trail({ trail, gradient }: { trail: Point3[]; gradient: string }) {
  if (trail.length < 2) return null;
  const [sx, sy] = at(trail[0]);
  const [ex, ey] = at(trail[trail.length - 1]);
  const run = Math.hypot(ex - sx, ey - sy);
  const rise = Math.max(0, ...trail.map((point) => point.z)) * LIFT;
  if (rise < 2) return null;
  const [ux, uy] = run > 0 ? [(ex - sx) / run, (ey - sy) / run] : [1, 0];
  const width = Math.max(run, 1);
  const height = rise + 6;
  const points = trail.map((point): [number, number] => {
    const [x, y] = at(point);
    return [(x - sx) * ux + (y - sy) * uy, height - point.z * LIFT];
  });
  return (
    <Wall x={sx} y={sy} angle={(Math.atan2(uy, ux) * 180) / Math.PI} width={width} height={height}>
      <svg data-testid="ball-trail" data-points={trail.length} aria-hidden viewBox={`0 0 ${round(width)} ${round(height)}`} overflow="visible"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        <defs>
          <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1={0} y1={0} x2={round(width)} y2={0}>
            <stop offset={0} stopColor="#FFFFFF" stopOpacity={0.1} />
            <stop offset={1} stopColor="#FFFFFF" stopOpacity={0.95} />
          </linearGradient>
        </defs>
        <path data-testid="trail-arc" d={smooth(points)} fill="none" stroke={`url(#${gradient})`} strokeWidth={3} strokeLinecap="round" />
        {points.slice(1, -1).map(([x, y], index) => (
          <circle key={index} cx={round(x)} cy={round(y)} r={2.4} fill="#FFFFFF" opacity={0.35 + (0.5 * (index + 1)) / points.length} />
        ))}
      </svg>
    </Wall>
  );
}

interface TurfProps {
  scene: PitchScene | null;
  ids: { mow: string; sheen: string; shade: string };
}

/** The grass, its lines, and the ball's path along the ground. */
function Turf({ scene, ids }: TurfProps) {
  const outer = { x: -APRON, y: -APRON, width: LENGTH + 2 * APRON, height: WIDTH + 2 * APRON };
  const box = { y: (WIDTH - 40.32 * M) / 2, depth: 16.5 * M, width: 40.32 * M };
  const six = { y: (WIDTH - 18.32 * M) / 2, depth: 5.5 * M, width: 18.32 * M };
  const spot = 11 * M;
  const ring = 9.15 * M;
  const arc = Math.sqrt(ring ** 2 - (box.depth - spot) ** 2);
  const stripe = LENGTH / 18;
  const trail = scene && scene.trail.length > 1 ? [at(scene.trail[0]), at(scene.trail[scene.trail.length - 1])] : null;
  return (
    <svg aria-hidden viewBox={`${outer.x} ${outer.y} ${outer.width} ${outer.height}`}
      style={{ position: "absolute", left: outer.x, top: outer.y, width: outer.width, height: outer.height, boxShadow: "0 0 0 5px #1A2537, 0 40px 90px rgba(0, 0, 0, 0.6)" }}>
      <defs>
        <pattern id={ids.mow} width={stripe * 2} height={outer.height} x={0} y={outer.y} patternUnits="userSpaceOnUse">
          <rect width={stripe} height={outer.height} fill="#2F7F35" />
          <rect x={stripe} width={stripe} height={outer.height} fill="#38903E" />
        </pattern>
        <radialGradient id={ids.sheen} cx="50%" cy="42%" r="62%">
          <stop offset={0} stopColor="#FFFFFF" stopOpacity={0.16} />
          <stop offset={1} stopColor="#FFFFFF" stopOpacity={0} />
        </radialGradient>
        <radialGradient id={ids.shade} cx="50%" cy="50%" r="72%">
          <stop offset={0.6} stopColor="#000000" stopOpacity={0} />
          <stop offset={1} stopColor="#000000" stopOpacity={0.42} />
        </radialGradient>
      </defs>
      <rect {...outer} fill={`url(#${ids.mow})`} />
      <rect {...outer} fill="#06140A" opacity={0.32} />
      <rect width={LENGTH} height={WIDTH} fill={`url(#${ids.mow})`} />
      <rect {...outer} fill={`url(#${ids.sheen})`} />
      <rect {...outer} fill={`url(#${ids.shade})`} />
      <g fill="none" stroke={CHALK} strokeWidth={2.6} opacity={0.92}>
        <rect width={LENGTH} height={WIDTH} />
        <line x1={LENGTH / 2} y1={0} x2={LENGTH / 2} y2={WIDTH} />
        <circle cx={LENGTH / 2} cy={WIDTH / 2} r={ring} />
        <rect y={box.y} width={box.depth} height={box.width} />
        <rect x={LENGTH - box.depth} y={box.y} width={box.depth} height={box.width} />
        <rect y={six.y} width={six.depth} height={six.width} />
        <rect x={LENGTH - six.depth} y={six.y} width={six.depth} height={six.width} />
        <path d={`M${box.depth} ${WIDTH / 2 - arc} A${ring} ${ring} 0 0 1 ${box.depth} ${WIDTH / 2 + arc}`} />
        <path d={`M${LENGTH - box.depth} ${WIDTH / 2 - arc} A${ring} ${ring} 0 0 0 ${LENGTH - box.depth} ${WIDTH / 2 + arc}`} />
        <path d={`M${M} 0 A${M} ${M} 0 0 1 0 ${M} M${LENGTH - M} 0 A${M} ${M} 0 0 0 ${LENGTH} ${M} M0 ${WIDTH - M} A${M} ${M} 0 0 1 ${M} ${WIDTH} M${LENGTH} ${WIDTH - M} A${M} ${M} 0 0 0 ${LENGTH - M} ${WIDTH}`} />
      </g>
      <g fill={CHALK} opacity={0.92}>
        <circle cx={LENGTH / 2} cy={WIDTH / 2} r={3.5} />
        <circle cx={spot} cy={WIDTH / 2} r={3} />
        <circle cx={LENGTH - spot} cy={WIDTH / 2} r={3} />
      </g>
      {trail && (
        <line data-testid="trail-shadow" x1={trail[0][0]} y1={trail[0][1]} x2={trail[1][0]} y2={trail[1][1]}
          stroke="#000000" strokeOpacity={0.3} strokeWidth={3} strokeDasharray="4 7" strokeLinecap="round" />
      )}
    </svg>
  );
}

/** A pass lane, painted on the grass. Each is its own small layer, so its moving dashes do not repaint the whole pitch. */
function Lane({ lane, color, arrow }: { lane: PassLane; color: string; arrow: string }) {
  const [x1, y1] = at({ x: lane.from_x, y: lane.from_y });
  const [x2, y2] = at({ x: lane.to_x, y: lane.to_y });
  const length = round(Math.hypot(x2 - x1, y2 - y1));
  const angle = round((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI);
  return (
    <div className="ks-p3" data-testid="pass-lane" data-team={lane.team} style={{ left: x1, top: y1, transform: `rotateZ(${angle}deg) translateZ(1.5px)` }}>
      <svg aria-hidden viewBox={`-6 -6 ${length + 12} 12`} overflow="visible"
        style={{ position: "absolute", left: -6, top: -6, width: length + 12, height: 12, opacity: 0.3 + 0.7 * lane.weight }}>
        <defs>
          <marker id={arrow} viewBox="0 0 10 10" refX={5} refY={5} markerWidth={3.2} markerHeight={3.2} orient="auto">
            <path d="M0 0 L10 5 L0 10 z" fill="#FFFFFF" />
          </marker>
        </defs>
        <line x2={length} stroke={color} strokeOpacity={0.55} strokeWidth={10} strokeLinecap="round" />
        <line className="ks-flow" x2={length} stroke="#FFFFFF" strokeWidth={3} strokeDasharray="12 9" strokeLinecap="round" markerEnd={`url(#${arrow})`} />
      </svg>
    </div>
  );
}

function Column({ column, color }: { column: DangerColumn; color: string }) {
  const half = Math.min((column.width / 100) * LENGTH, (column.depth / 100) * WIDTH) * 0.15;
  const height = round(20 + 100 * column.intensity);
  const light = `color-mix(in srgb, ${color} 55%, white)`;
  const side: CSSProperties = {
    background: `linear-gradient(to top, color-mix(in srgb, ${color} 75%, transparent), color-mix(in srgb, ${color} 4%, transparent))`,
    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${light} 45%, transparent)`,
    transition: `height ${MOVE}`,
  };
  return (
    <div className="ks-p3" data-testid="danger-column" data-team={column.team}
      style={{ left: `${column.x}%`, top: `${column.y}%`, width: `${column.width}%`, height: `${column.depth}%` }}>
      <div className="ks-ground" style={{
        inset: "6%", borderRadius: 14, boxSizing: "border-box", border: `2px solid color-mix(in srgb, ${light} 60%, transparent)`,
        background: `radial-gradient(closest-side, color-mix(in srgb, ${color} 55%, transparent), color-mix(in srgb, ${color} 8%, transparent))`,
        opacity: 0.35 + 0.55 * column.intensity, transition: `opacity ${MOVE}`,
      }} />
      <div className="ks-p3" style={{ left: "50%", top: "50%" }}>
        <Wall x={-half} y={-half} angle={0} width={half * 2} height={height} style={side} />
        <Wall x={half} y={-half} angle={90} width={half * 2} height={height} style={side} />
        <Wall x={half} y={half} angle={180} width={half * 2} height={height} style={side} />
        <Wall x={-half} y={half} angle={270} width={half * 2} height={height} style={side} />
        <div style={{
          position: "absolute", left: -half, top: -half, width: half * 2, height: half * 2, boxSizing: "border-box", transform: `translateZ(${height}px)`,
          border: `2px solid ${light}`, backgroundColor: `color-mix(in srgb, ${color} 30%, transparent)`, boxShadow: `0 0 14px ${color}`,
          transition: `transform ${MOVE}`,
        }} />
      </div>
    </div>
  );
}

function Player({ player, color, followed }: { player: ScenePlayer; color: string; followed: boolean }) {
  const outline = followed ? GOLD : CHALK;
  return (
    <div className="ks-p3" data-testid="pitch-player" data-player={player.id} data-estimated={player.estimated} data-followed={followed || undefined}
      style={{ left: `${player.x}%`, top: `${player.y}%`, transition: `left ${MOVE}, top ${MOVE}` }}>
      <div className="ks-ground" style={{ left: -16, top: -16, width: 32, height: 32, borderRadius: "50%", background: "radial-gradient(closest-side, rgba(0, 0, 0, 0.55), transparent)" }} />
      {(followed || player.on_ball) && (
        <div className={followed ? "ks-ground ks-ring" : "ks-ground"}
          style={{ left: -22, top: -22, width: 44, height: 44, boxSizing: "border-box", borderRadius: "50%", border: `3px solid ${outline}`, boxShadow: `0 0 10px ${outline}` }} />
      )}
      <div className="ks-face" style={{ left: -FIGURE.width / 2, bottom: 0, width: FIGURE.width, height: FIGURE.height }}>
        <div className="ks-figure" style={player.on_ball ? { transform: "scale(calc(var(--ks-fig) * 1.12))" } : undefined}>
          <svg aria-hidden viewBox={`0 0 ${FIGURE.width} ${FIGURE.height}`} width="100%" height="100%" overflow="visible"
            style={{ opacity: player.estimated ? 0.82 : 1, filter: player.on_ball ? "drop-shadow(0 0 5px rgba(255, 255, 255, 0.9))" : "drop-shadow(0 2px 2px rgba(0, 0, 0, 0.45))" }}>
            <rect x={10} y={40} width={5} height={10} rx={1.5} fill={color} />
            <rect x={19} y={40} width={5} height={10} rx={1.5} fill={color} />
            <rect x={9.5} y={48.5} width={6} height={4.5} rx={1.8} fill="#11151C" />
            <rect x={18.5} y={48.5} width={6} height={4.5} rx={1.8} fill="#11151C" />
            <rect x={8.5} y={33} width={17} height={9} rx={2.5} fill="#151B26" />
            <path d="M8 13 L13 10.5 L21 10.5 L26 13 L33 20.5 L28.5 25 L26 22.5 L26 36 L8 36 L8 22.5 L5.5 25 L1 20.5 Z" fill={color} stroke={outline}
              strokeWidth={followed ? 2 : 1.4} strokeLinejoin="round" strokeDasharray={player.estimated && !followed ? "2.6 1.8" : undefined} />
            <circle cx={17} cy={5.6} r={5} fill="#D7DCE3" stroke={outline} strokeWidth={1} />
            <text x={17} y={29.5} textAnchor="middle" fontSize={14} fontWeight={800} fill="#FFFFFF" stroke="rgba(0, 0, 0, 0.35)" strokeWidth={2}
              paintOrder="stroke" fontFamily="'Segoe UI', system-ui, sans-serif">
              {player.number}
            </text>
          </svg>
        </div>
      </div>
    </div>
  );
}

function Ball({ scene }: { scene: PitchScene }) {
  const peak = round(Math.min(8, Math.max(0, ...scene.trail.map((point) => point.z))) * LIFT);
  return (
    <div className="ks-p3" data-testid="pitch-ball" style={{ left: `${scene.ball.x}%`, top: `${scene.ball.y}%`, transition: `left ${FLIGHT}, top ${FLIGHT}` }}>
      <div key={`${scene.id}-shadow`} className="ks-ground ks-landing"
        style={{ left: -10, top: -10, width: 20, height: 20, borderRadius: "50%", background: "radial-gradient(closest-side, rgba(0, 0, 0, 0.6), transparent)" }} />
      <div className="ks-p3" style={{ transform: `translateZ(${round(scene.ball.z * LIFT)}px)` }}>
        <div key={`${scene.id}-hop`} className="ks-p3 ks-hop" style={{ ["--peak" as string]: `${peak}px` }}>
          <div className="ks-face" style={{ left: -8, bottom: 0, width: 16, height: 16 }}>
            <div className="ks-figure" style={{
              borderRadius: "50%", boxShadow: "0 0 10px rgba(255, 255, 255, 0.75)",
              background: "radial-gradient(circle at 56% 58%, #2A303A 0 14%, transparent 15%), radial-gradient(circle at 35% 30%, #FFFFFF 0 28%, #D5DAE1 68%, #8E98A6)",
            }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function useBox(ref: RefObject<HTMLDivElement | null>): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const { clientWidth: width, clientHeight: height } = node;
      if (width > 0 && height > 0) setBox((current) => (current?.width === width && current.height === height ? current : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return box;
}

const UNMEASURED: Box = { width: 800, height: 450 };

interface Pitch3DProps {
  scene: PitchScene | null;
  colors?: { home: string; away: string };
  /** The view to hold; without it the scene's own camera hint is followed. */
  camera?: Camera;
  /** Rings this player, such as the viewer's favourite. */
  followId?: string | null;
  /** Lets the viewer turn, tilt and zoom the camera, with the mouse, the keyboard or the buttons shown. */
  controls?: boolean;
  label: string;
  emptyText: string;
}

/**
 * The pitch in three dimensions, drawn with CSS transforms from the Visualization Agent's scene:
 * the ball and its flight, the players, columns over the dangerous zones, and the current pass lanes.
 * Only the player on the ball is a known position; the fainter ones are estimated.
 */
export function Pitch3D({ scene, colors = DEFAULT_COLORS, camera, followId = null, controls = false, label, emptyText }: Pitch3DProps) {
  const view = camera ?? scene?.camera ?? "broadcast";
  const preset = camera ?? "auto";
  const base = POSES[view];
  const [user, setUser] = useState<{ preset: Camera | "auto"; orbit: Orbit }>({ preset, orbit: LEVEL });
  if (user.preset !== preset) setUser({ preset, orbit: LEVEL });
  const orbit = user.preset === preset ? bounded(base, user.orbit) : LEVEL;
  const pose: Pose = { tilt: base.tilt + orbit.tilt, turn: base.turn + orbit.turn };
  const level = orbit.turn === 0 && orbit.tilt === 0 && orbit.zoom === 1;

  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const box = useBox(root) ?? UNMEASURED;
  const [settled, setSettled] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const ids = { mow: `${id}-mow`, sheen: `${id}-sheen`, shade: `${id}-shade` };

  useEffect(() => {
    if (typeof requestAnimationFrame === "undefined") return;
    const frameId = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frameId);
  }, []);

  const change = (next: (orbit: Orbit) => Partial<Orbit>) =>
    setUser((current) => {
      const from = current.preset === preset ? bounded(base, current.orbit) : LEVEL;
      return { preset, orbit: bounded(base, { ...from, ...next(from) }) };
    });
  const turnBy = (degrees: number) => change((from) => ({ turn: from.turn + degrees }));
  const tiltBy = (degrees: number) => change((from) => ({ tilt: from.tilt + degrees }));
  const zoomBy = (factor: number) => change((from) => ({ zoom: from.zoom * factor }));
  const reset = () => setUser({ preset, orbit: LEVEL });

  const zoomRef = useRef(zoomBy);
  zoomRef.current = zoomBy;
  const zoomNow = useRef(orbit.zoom);
  zoomNow.current = orbit.zoom;
  useEffect(() => {
    const node = stage.current;
    if (!controls || !node) return;
    const onWheel = (event: WheelEvent) => {
      const factor = Math.exp(-event.deltaY * 0.0015);
      const next = clamp(zoomNow.current * factor, ZOOM_RANGE[0], ZOOM_RANGE[1]);
      if (next === zoomNow.current) return;
      event.preventDefault();
      zoomRef.current(factor);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [controls]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!controls || event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (!from) return;
    const [dx, dy] = [event.clientX - from.x, event.clientY - from.y];
    drag.current = { x: event.clientX, y: event.clientY };
    change((current) => ({ turn: current.turn - dx * 0.35, tilt: current.tilt - dy * 0.25 }));
  };
  const onPointerUp = () => {
    drag.current = null;
    setDragging(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, () => void> = {
      ArrowLeft: () => turnBy(-STEP.turn), ArrowRight: () => turnBy(STEP.turn), ArrowUp: () => tiltBy(-STEP.tilt), ArrowDown: () => tiltBy(STEP.tilt),
      "+": () => zoomBy(STEP.zoom), "=": () => zoomBy(STEP.zoom), "-": () => zoomBy(1 / STEP.zoom), _: () => zoomBy(1 / STEP.zoom), "0": reset, Home: reset,
    };
    const act = keys[event.key];
    if (!act) return;
    event.preventDefault();
    act();
  };

  const firstFit = frame(pose, box, FIGURE.height, 1, [0, 0, 0]);
  const figure = round(clamp(0.72 / firstFit.scale, 1, 2));
  const focus: Vec = scene ? [(scene.ball.x / 100 - 0.5) * LENGTH, (scene.ball.y / 100 - 0.5) * WIDTH, 0] : [0, 0, 0];
  const fit = frame(pose, box, FIGURE.height * figure * 1.15, orbit.zoom, focus);
  const animate = settled && !dragging;

  const tool = (name: string, icon: ReactNode, act: () => void, disabled = false) => (
    <button type="button" className="ks-pitch3d-tool" aria-label={name} title={name} disabled={disabled} onClick={act}>{icon}</button>
  );

  return (
    <div ref={root} className="ks-pitch3d" data-testid="pitch3d" data-camera={view} role={controls ? "group" : "img"} aria-label={label}
      aria-describedby={controls ? `${id}-hint` : undefined} aria-keyshortcuts={controls ? "ArrowLeft ArrowRight ArrowUp ArrowDown + - 0" : undefined}
      tabIndex={controls ? 0 : undefined} onKeyDown={controls ? onKeyDown : undefined}
      style={{ position: "relative", width: "100%", height: "100%", minHeight: 0, overflow: "hidden", userSelect: "none", ["--ks-cam" as string]: animate ? CAMERA_MOVE : "0s" }}>
      <style>{STYLES}</style>
      <div ref={stage} data-testid="pitch-view" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        style={{ position: "absolute", inset: 0, cursor: controls ? (dragging ? "grabbing" : "grab") : undefined, touchAction: controls ? "none" : undefined }}>
        <div data-testid="pitch-camera" style={{
          position: "absolute", left: "50%", top: "50%", width: LENGTH, height: WIDTH, marginLeft: -LENGTH / 2, marginTop: -WIDTH / 2,
          perspective: DEPTH, perspectiveOrigin: "50% 50%", transform: `translate(${round(fit.x)}px, ${round(fit.y)}px) scale(${round(fit.scale * 1000) / 1000})`,
          transition: "transform var(--ks-cam)",
        }}>
          <div data-testid="pitch-stage" style={{
            position: "absolute", inset: 0, transformStyle: "preserve-3d", transform: `rotateX(${round(pose.tilt)}deg) rotateZ(${round(pose.turn)}deg)`,
            transition: "transform var(--ks-cam)", ["--ks-face" as string]: `rotateZ(${round(-pose.turn)}deg) rotateX(${round(-pose.tilt)}deg)`, ["--ks-fig" as string]: figure,
          }}>
            <Stadium />
            <Turf scene={scene} ids={ids} />
            <Goal end="left" />
            <Goal end="right" />
            <Flag x={0} y={0} />
            <Flag x={LENGTH} y={0} />
            <Flag x={0} y={WIDTH} />
            <Flag x={LENGTH} y={WIDTH} />
            {scene?.lanes.map((lane, index) => (
              <Lane key={`${index}-${lane.from_x}-${lane.to_x}`} lane={lane} color={colors[lane.team]} arrow={`${id}-arrow-${index}`} />
            ))}
            {scene?.columns.map((column) => <Column key={`${column.team}-${column.x}-${column.y}`} column={column} color={colors[column.team]} />)}
            {scene && <Trail key={scene.id} trail={scene.trail} gradient={`${id}-trail`} />}
            {scene?.players.map((player) => <Player key={player.id} player={player} color={colors[player.team]} followed={player.id === followId} />)}
            {scene && <Ball scene={scene} />}
          </div>
        </div>
        <div aria-hidden style={{
          position: "absolute", inset: 0, pointerEvents: "none",
          background: "linear-gradient(to bottom, rgba(11, 18, 32, 0.4), rgba(11, 18, 32, 0) 40%), radial-gradient(ellipse 75% 85% at 50% 52%, rgba(5, 9, 18, 0) 60%, rgba(5, 9, 18, 0.5))",
        }} />
      </div>
      {controls && (
        <>
          <span id={`${id}-hint`} hidden>Drag to turn the view, scroll to zoom. Arrow keys turn and tilt, plus and minus zoom, zero resets.</span>
          <div role="group" aria-label="Camera controls" className="ks-pitch3d-tools">
            {tool("Rotate left", <ArrowRotateCounterclockwiseRegular />, () => turnBy(-STEP.turn), orbit.turn <= -TURN_LIMIT)}
            {tool("Rotate right", <ArrowRotateClockwiseRegular />, () => turnBy(STEP.turn), orbit.turn >= TURN_LIMIT)}
            <hr />
            {tool("Tilt up", <ChevronUpRegular />, () => tiltBy(-STEP.tilt), pose.tilt <= TILT_RANGE[0])}
            {tool("Tilt down", <ChevronDownRegular />, () => tiltBy(STEP.tilt), pose.tilt >= TILT_RANGE[1])}
            <hr />
            {tool("Zoom in", <ZoomInRegular />, () => zoomBy(STEP.zoom), orbit.zoom >= ZOOM_RANGE[1])}
            {tool("Zoom out", <ZoomOutRegular />, () => zoomBy(1 / STEP.zoom), orbit.zoom <= ZOOM_RANGE[0])}
            <hr />
            {tool("Reset view", <ArrowResetRegular />, reset, level)}
          </div>
        </>
      )}
      {!scene && (
        <span style={{
          position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", maxWidth: "80%", padding: "8px 14px", borderRadius: 8,
          textAlign: "center", background: "rgba(8, 14, 26, 0.72)", color: "#FFFFFF",
        }}>{emptyText}</span>
      )}
    </div>
  );
}
