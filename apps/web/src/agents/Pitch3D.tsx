import {
  ArrowResetRegular, ArrowRotateClockwiseRegular, ArrowRotateCounterclockwiseRegular, ChevronDownRegular, ChevronUpRegular, FullScreenMaximizeRegular,
  FullScreenMinimizeRegular, ZoomFitRegular, ZoomInRegular, ZoomOutRegular,
} from "@fluentui/react-icons";
import {
  type CSSProperties, type KeyboardEvent, memo, type PointerEvent, type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState,
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
const COLUMN_TOP = 120;
const MOVE = `620ms ${EASE}`;
const CAMERA_MOVE = `800ms ${EASE}`;
const CAMERA_QUICK = "240ms cubic-bezier(0.2, 0.8, 0.3, 1)";
const FLIGHT_EASE = "cubic-bezier(0.25, 0.4, 0.5, 1)";
/** How long a figure takes to reach its next spot: a little longer than the time between scenes, so it is still moving when the next arrives. */
const CADENCE = { start: 700, low: 250, high: 2400, lead: 1.1, pause: 6000 };

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

/** The viewer's own view on top of the camera's pose: turned, tilted, zoomed, and moved across when zoomed in. */
export interface View {
  turn: number;
  tilt: number;
  zoom: number;
  /** How far the view is moved, in the camera's unscaled pixels. */
  panX: number;
  panY: number;
}

export const LEVEL: View = { turn: 0, tilt: 0, zoom: 1, panX: 0, panY: 0 };
const TURN_LIMIT = 75;
const TILT_RANGE = [6, 76] as const;
export const ZOOM_RANGE = [0.5, 4] as const;
const STEP = { turn: 15, tilt: 8, zoom: 1.25, pan: 48 };

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const round = (value: number) => Math.round(value * 100) / 100;
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

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

/** What the camera has to frame for a pose in a box: the stadium's outline on screen and the scale that fits all of it. */
interface Room {
  box: Box;
  left: number;
  right: number;
  top: number;
  bottom: number;
  fit: number;
  /** How much larger than life the figures are drawn, so they can still be read in a small box. */
  figure: number;
}

function outline(pose: Pose, box: Box, standing: number) {
  const points = hull(standing).map((point) => project(pose, point));
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return { left, right, top, bottom, fit: Math.min((box.width * 0.95) / (right - left), (box.height * 0.93) / (bottom - top)) };
}

function roomFor(pose: Pose, box: Box): Room {
  const figure = round(clamp(0.72 / outline(pose, box, FIGURE.height).fit, 1, 2));
  return { box, figure, ...outline(pose, box, FIGURE.height * figure * 1.15) };
}

/** Keeps a view within its limits: the turn and tilt, the zoom, and a move that never takes the stadium off screen. */
function settle(base: Pose, box: Box, view: View): { view: View; pose: Pose; room: Room } {
  const turn = clamp(view.turn, -TURN_LIMIT, TURN_LIMIT);
  const tilt = clamp(base.tilt + view.tilt, TILT_RANGE[0], TILT_RANGE[1]) - base.tilt;
  const zoom = clamp(view.zoom, ZOOM_RANGE[0], ZOOM_RANGE[1]);
  const pose = { tilt: base.tilt + tilt, turn: base.turn + turn };
  const room = roomFor(pose, box);
  const reach = (span: number, side: number) => Math.max(0, span / 2 - side / (2 * room.fit * zoom));
  const x = reach(room.right - room.left, box.width);
  const y = reach(room.bottom - room.top, box.height);
  return { view: { turn, tilt, zoom, panX: round(clamp(view.panX, -x, x)), panY: round(clamp(view.panY, -y, y)) }, pose, room };
}

/** A change to the view: turned and tilted by degrees, moved by screen pixels, and zoomed by a factor about a point measured from the middle of the box. */
interface Change {
  turn: number;
  tilt: number;
  dx: number;
  dy: number;
  zoom: number;
  anchor: [number, number] | null;
}

const NO_CHANGE: Change = { turn: 0, tilt: 0, dx: 0, dy: 0, zoom: 1, anchor: null };

function applied(base: Pose, box: Box, view: View, change: Partial<Change>): View {
  const { turn, tilt, dx, dy, zoom: factor, anchor } = { ...NO_CHANGE, ...change };
  const before = settle(base, box, view).view;
  const fit = roomFor({ tilt: base.tilt + before.tilt, turn: base.turn + before.turn }, box).fit;
  const zoom = clamp(before.zoom * factor, ZOOM_RANGE[0], ZOOM_RANGE[1]);
  const [mx, my] = anchor ?? [0, 0];
  const toward = 1 / (fit * zoom) - 1 / (fit * before.zoom);
  return settle(base, box, {
    turn: before.turn + turn, tilt: before.tilt + tilt, zoom,
    panX: before.panX + mx * toward + dx / (fit * zoom), panY: before.panY + my * toward + dy / (fit * zoom),
  }).view;
}

interface Framing {
  scale: number;
  x: number;
  y: number;
}

/** Scales and centres the camera on the stadium, moved by the view; following the ball, a zoomed view is drawn towards it instead. */
function frame(pose: Pose, room: Room, view: View, ball: Vec | null): Framing {
  const scale = room.fit * view.zoom;
  const cx = (room.left + room.right) / 2;
  const cy = (room.top + room.bottom) / 2;
  if (ball) {
    const [fx, fy] = project(pose, ball);
    const toward = Math.max(0, 1 - 1 / view.zoom);
    return { scale, x: -(cx + (fx - cx) * toward) * scale, y: -(cy + (fy - cy) * toward) * scale };
  }
  return { scale, x: (view.panX - cx) * scale, y: (view.panY - cy) * scale };
}

const STYLES = `
.ks-pitch3d .ks-p3 { position: absolute; width: 0; height: 0; transform-style: preserve-3d; }
.ks-pitch3d .ks-face { position: absolute; transform-origin: 50% 100%; }
.ks-pitch3d .ks-ground { position: absolute; transform: translateZ(1px); pointer-events: none; }
.ks-pitch3d .ks-figure { position: absolute; inset: 0; transform: scale(var(--ks-fig)); transform-origin: 50% 100%; }
.ks-pitch3d .ks-mover { left: 0; top: 0; }
.ks-pitch3d[data-zooming] .ks-plane { will-change: transform; }
.ks-pitch3d .ks-ring { animation: ks-pitch-ring 1.6s ease-in-out infinite; }
.ks-pitch3d .ks-flow { animation: ks-pitch-flow 1.4s linear infinite; }
.ks-pitch3d:focus-visible { outline: 2px solid #FFFFFF; outline-offset: -2px; }
.ks-pitch3d:fullscreen { background: linear-gradient(180deg, #0B1220 0%, #16233B 100%); }
.ks-pitch3d-tools { position: absolute; top: 8px; right: 8px; max-width: calc(100% - 16px); box-sizing: border-box; display: flex; flex-wrap: wrap;
  justify-content: flex-end; align-items: center; gap: 2px; padding: 3px; border-radius: 8px; background: rgba(8, 14, 26, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.14); color: #FFFFFF; font: 600 12px/1 'Segoe UI', system-ui, sans-serif; }
.ks-pitch3d-tools hr { width: 1px; height: 18px; margin: 0 2px; border: 0; background: rgba(255, 255, 255, 0.18); }
.ks-pitch3d-tools output { min-width: 38px; text-align: center; font-variant-numeric: tabular-nums; }
.ks-pitch3d-zoom { width: 96px; margin: 0 4px; accent-color: #FFFFFF; cursor: pointer; }
.ks-pitch3d-zoom:focus-visible { outline: 2px solid #FFFFFF; outline-offset: 2px; }
.ks-pitch3d-tool { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; cursor: pointer;
  background: transparent; color: #FFFFFF; font-size: 18px; }
.ks-pitch3d-tool:hover:not(:disabled) { background: rgba(255, 255, 255, 0.14); }
.ks-pitch3d-tool:focus-visible { outline: 2px solid #FFFFFF; outline-offset: -2px; }
.ks-pitch3d-tool:disabled { opacity: 0.38; cursor: default; }
@keyframes ks-pitch-ring { 0%, 100% { transform: translateZ(2px) scale(1); opacity: 1; } 50% { transform: translateZ(2px) scale(1.3); opacity: 0.45; } }
@keyframes ks-pitch-flow { from { transform: translateX(0); } to { transform: translateX(21px); } }
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
      <div className="ks-plane" style={{ position: "absolute", left: 0, bottom: 0, width, height, transformOrigin: "0 100%", transform: `rotateX(${-lean}deg)`, ...style }}>
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
    "repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.09) 0 2px, transparent 2px 7px)",
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

/** The ball's path along the ground, dashed under its flight. */
function TrailShadow({ trail }: { trail: Point3[] }) {
  if (trail.length < 2) return null;
  const [x1, y1] = at(trail[0]);
  const [x2, y2] = at(trail[trail.length - 1]);
  return (
    <div className="ks-p3" style={{ left: x1, top: y1, transform: `rotateZ(${round((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI)}deg) translateZ(1px)` }}>
      <div data-testid="trail-shadow" style={{ position: "absolute", left: 0, top: -1.5, width: round(Math.hypot(x2 - x1, y2 - y1)), height: 3,
        background: "repeating-linear-gradient(90deg, rgba(0, 0, 0, 0.3) 0 4px, transparent 4px 11px)", borderRadius: 2 }} />
    </div>
  );
}

/** The grass and its lines. */
const Turf = memo(function Turf({ id }: { id: string }) {
  const ids = { mow: `${id}-mow`, sheen: `${id}-sheen`, shade: `${id}-shade` };
  const outer = { x: -APRON, y: -APRON, width: LENGTH + 2 * APRON, height: WIDTH + 2 * APRON };
  const box = { y: (WIDTH - 40.32 * M) / 2, depth: 16.5 * M, width: 40.32 * M };
  const six = { y: (WIDTH - 18.32 * M) / 2, depth: 5.5 * M, width: 18.32 * M };
  const spot = 11 * M;
  const ring = 9.15 * M;
  const arc = Math.sqrt(ring ** 2 - (box.depth - spot) ** 2);
  const stripe = LENGTH / 18;
  return (
    <svg aria-hidden className="ks-plane" viewBox={`${outer.x} ${outer.y} ${outer.width} ${outer.height}`}
      style={{ position: "absolute", left: outer.x, top: outer.y, width: outer.width, height: outer.height, boxShadow: "0 0 0 5px #1A2537" }}>
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
    </svg>
  );
});

/** Everything that never moves: the stand, the boards, the grass, the goals and the corner flags. */
const Scenery = memo(function Scenery({ id }: { id: string }) {
  return (
    <>
      <Stadium />
      <Turf id={id} />
      <Goal end="left" />
      <Goal end="right" />
      <Flag x={0} y={0} />
      <Flag x={LENGTH} y={0} />
      <Flag x={0} y={WIDTH} />
      <Flag x={LENGTH} y={WIDTH} />
    </>
  );
});

/** A pass lane, painted on the grass. Its dashes move by a transform, so they never repaint the pitch. */
function Lane({ lane, color }: { lane: PassLane; color: string }) {
  const [x1, y1] = at({ x: lane.from_x, y: lane.from_y });
  const [x2, y2] = at({ x: lane.to_x, y: lane.to_y });
  const length = round(Math.hypot(x2 - x1, y2 - y1));
  const angle = round((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI);
  return (
    <div className="ks-p3" data-testid="pass-lane" data-team={lane.team} style={{ left: x1, top: y1, transform: `rotateZ(${angle}deg) translateZ(1.5px)` }}>
      <div style={{ position: "absolute", left: 0, top: 0, opacity: 0.3 + 0.7 * lane.weight }}>
        <div style={{ position: "absolute", left: -5, top: -5, width: length + 10, height: 10, borderRadius: 5, backgroundColor: color, opacity: 0.55 }} />
        <div style={{ position: "absolute", left: 0, top: -1.5, width: Math.max(0, length - 6), height: 3, overflow: "hidden", borderRadius: 2 }}>
          <div className="ks-flow" style={{ position: "absolute", left: -21, top: 0, width: length + 21, height: 3, background: "repeating-linear-gradient(90deg, #FFFFFF 0 12px, transparent 12px 21px)" }} />
        </div>
        <svg aria-hidden viewBox="0 0 10 10" style={{ position: "absolute", left: length - 8, top: -6, width: 12, height: 12 }}>
          <path d="M0 0 L10 5 L0 10 z" fill="#FFFFFF" />
        </svg>
      </div>
    </div>
  );
}

function Column({ column, color }: { column: DangerColumn; color: string }) {
  const half = Math.min((column.width / 100) * LENGTH, (column.depth / 100) * WIDTH) * 0.15;
  const height = round(20 + 100 * column.intensity);
  const light = `color-mix(in srgb, ${color} 55%, white)`;
  const side: CSSProperties = {
    position: "absolute", inset: 0, transformOrigin: "50% 100%", transform: `scaleY(${round(height / COLUMN_TOP)})`, transition: `transform ${MOVE}`,
    background: `linear-gradient(to top, color-mix(in srgb, ${color} 75%, transparent), color-mix(in srgb, ${color} 4%, transparent))`,
    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${light} 45%, transparent)`,
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
        <Wall x={-half} y={-half} angle={0} width={half * 2} height={COLUMN_TOP}><div style={side} /></Wall>
        <Wall x={half} y={-half} angle={90} width={half * 2} height={COLUMN_TOP}><div style={side} /></Wall>
        <Wall x={half} y={half} angle={180} width={half * 2} height={COLUMN_TOP}><div style={side} /></Wall>
        <Wall x={-half} y={half} angle={270} width={half * 2} height={COLUMN_TOP}><div style={side} /></Wall>
        <div style={{
          position: "absolute", left: -half, top: -half, width: half * 2, height: half * 2, boxSizing: "border-box", transform: `translateZ(${height}px)`,
          border: `2px solid ${light}`, backgroundColor: `color-mix(in srgb, ${color} 30%, transparent)`, boxShadow: `0 0 14px ${color}`,
          transition: `transform ${MOVE}`,
        }} />
      </div>
    </div>
  );
}

interface FigureProps {
  color: string;
  number: ScenePlayer["number"];
  followed: boolean;
  onBall: boolean;
  estimated: boolean;
}

const Figure = memo(function Figure({ color, number, followed, onBall, estimated }: FigureProps) {
  const outline = followed ? GOLD : CHALK;
  return (
    <>
      <div className="ks-ground" style={{ left: -16, top: -16, width: 32, height: 32, borderRadius: "50%", background: "radial-gradient(closest-side, rgba(0, 0, 0, 0.55), transparent)" }} />
      {(followed || onBall) && (
        <div className={followed ? "ks-ground ks-ring" : "ks-ground"}
          style={{ left: -22, top: -22, width: 44, height: 44, boxSizing: "border-box", borderRadius: "50%", border: `3px solid ${outline}`, boxShadow: `0 0 10px ${outline}` }} />
      )}
      <div className="ks-face" style={{ left: -FIGURE.width / 2, bottom: 0, width: FIGURE.width, height: FIGURE.height }}>
        <div className="ks-figure" style={onBall ? { transform: "scale(calc(var(--ks-fig) * 1.12))" } : undefined}>
          <svg aria-hidden viewBox={`0 0 ${FIGURE.width} ${FIGURE.height}`} width="100%" height="100%" overflow="visible" style={{ opacity: estimated ? 0.82 : 1 }}>
            <rect x={10} y={40} width={5} height={10} rx={1.5} fill={color} />
            <rect x={19} y={40} width={5} height={10} rx={1.5} fill={color} />
            <rect x={9.5} y={48.5} width={6} height={4.5} rx={1.8} fill="#11151C" />
            <rect x={18.5} y={48.5} width={6} height={4.5} rx={1.8} fill="#11151C" />
            <rect x={8.5} y={33} width={17} height={9} rx={2.5} fill="#151B26" />
            <path d="M8 13 L13 10.5 L21 10.5 L26 13 L33 20.5 L28.5 25 L26 22.5 L26 36 L8 36 L8 22.5 L5.5 25 L1 20.5 Z" fill={color} stroke={outline}
              strokeWidth={followed || onBall ? 2 : 1.4} strokeLinejoin="round" strokeDasharray={estimated && !followed ? "2.6 1.8" : undefined} />
            <circle cx={17} cy={5.6} r={5} fill="#D7DCE3" stroke={outline} strokeWidth={1} />
            <text x={17} y={29.5} textAnchor="middle" fontSize={14} fontWeight={800} fill="#FFFFFF" stroke="rgba(0, 0, 0, 0.35)" strokeWidth={2}
              paintOrder="stroke" fontFamily="'Segoe UI', system-ui, sans-serif">
              {number}
            </text>
          </svg>
        </div>
      </div>
    </>
  );
});

const Player = memo(function Player({ player, color, followed, move }: { player: ScenePlayer; color: string; followed: boolean; move: string }) {
  const [x, y] = at(player);
  return (
    <div className="ks-p3 ks-mover" data-testid="pitch-player" data-player={player.id} data-estimated={player.estimated} data-followed={followed || undefined}
      style={{ transform: `translate3d(${round(x)}px, ${round(y)}px, 0)`, transition: move }}>
      <Figure color={color} number={player.number} followed={followed} onBall={player.on_ball} estimated={player.estimated} />
    </div>
  );
});

/** A point in the world, on screen: z is drawn height. */
interface Stop {
  x: number;
  y: number;
  z: number;
  offset: number;
}

/** Where a flight has got to at this instant, from the animation's own progress, without asking the page to work out its styles. */
function partWay(stops: Stop[], animation: Animation | undefined): Vec | null {
  const progress = animation?.effect?.getComputedTiming().progress;
  if (progress === null || progress === undefined || stops.length === 0) return null;
  const next = Math.max(1, stops.findIndex((stop) => stop.offset >= progress));
  const [a, b] = [stops[next - 1], stops[Math.min(next, stops.length - 1)]];
  const t = b.offset > a.offset ? (progress - a.offset) / (b.offset - a.offset) : 1;
  return [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t];
}

/** The ball's flight from where it is now, through the scene's trail, to where it lands: a smooth curve, timed by distance along the ground. */
export function flight(from: Vec, trail: Point3[], ball: Point3): Stop[] {
  const target: Vec = [...at(ball), Math.max(0, ball.z) * LIFT];
  let points: Vec[] = trail.length >= 2 ? trail.map((point) => [...at(point), Math.max(0, point.z) * LIFT] as Vec) : [];
  if (points.length < 2) points = [from, target];
  else {
    points[points.length - 1] = target;
    if (Math.hypot(points[0][0] - from[0], points[0][1] - from[1], points[0][2] - from[2]) > 1) points = [from, ...points];
  }
  const curve: Vec[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const [p0, p1, p2, p3] = [points[Math.max(0, i - 1)], points[i], points[i + 1], points[Math.min(points.length - 1, i + 2)]];
    const steps = points.length === 2 ? 1 : 8;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const along = (k: number) => 0.5 * (2 * p1[k] + (p2[k] - p0[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t ** 2 + (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * t ** 3);
      curve.push([along(0), along(1), Math.max(0, along(2))]);
    }
  }
  const run = [0];
  for (let i = 1; i < curve.length; i++) run.push(run[i - 1] + Math.hypot(curve[i][0] - curve[i - 1][0], curve[i][1] - curve[i - 1][1]));
  const total = run[run.length - 1];
  return curve.map(([x, y, z], i) => ({ x: round(x), y: round(y), z: round(z), offset: total > 0 ? run[i] / total : i / (curve.length - 1) }));
}

const Ball = memo(function Ball({ scene, ms, animate }: { scene: PitchScene; ms: number; animate: boolean }) {
  const ball = useRef<HTMLDivElement>(null);
  const shadow = useRef<HTMLDivElement>(null);
  const flights = useRef<Animation[]>([]);
  const path = useRef<Stop[]>([]);
  const rest = useRef<Vec | null>(null);
  const [x, y] = at(scene.ball);
  const z = round(Math.max(0, scene.ball.z) * LIFT);

  useLayoutEffect(() => {
    const [node, ground] = [ball.current, shadow.current];
    const flying = flights.current[0]?.playState === "running";
    const from = (flying ? partWay(path.current, flights.current[0]) : null) ?? rest.current;
    flights.current.forEach((animation) => animation.cancel());
    flights.current = [];
    path.current = [];
    rest.current = [round(x), round(y), z];
    if (!animate || !node || !ground || !from || typeof node.animate !== "function" || reducedMotion()) return;
    const stops = flight(from, scene.trail, scene.ball);
    path.current = stops;
    const timing: KeyframeAnimationOptions = { duration: ms, easing: FLIGHT_EASE };
    const lift = (height: number) => Math.min(1, height / (8 * LIFT));
    flights.current = [
      node.animate(stops.map((stop) => ({ offset: stop.offset, transform: `translate3d(${stop.x}px, ${stop.y}px, ${stop.z}px)` })), timing),
      ground.animate(stops.map((stop) => ({
        offset: stop.offset, transform: `translate3d(${stop.x}px, ${stop.y}px, 1px) scale(${round(1 - 0.5 * lift(stop.z))})`, opacity: round(1 - 0.55 * lift(stop.z)),
      })), timing),
    ];
  }, [scene.id]);

  return (
    <>
      <div ref={shadow} className="ks-p3" style={{ transform: `translate3d(${round(x)}px, ${round(y)}px, 1px)` }}>
        <div style={{ position: "absolute", left: -10, top: -10, width: 20, height: 20, borderRadius: "50%", background: "radial-gradient(closest-side, rgba(0, 0, 0, 0.6), transparent)" }} />
      </div>
      <div ref={ball} className="ks-p3" data-testid="pitch-ball" style={{ transform: `translate3d(${round(x)}px, ${round(y)}px, ${z}px)`, willChange: "transform" }}>
        <div className="ks-face" style={{ left: -8, bottom: 0, width: 16, height: 16 }}>
          <div className="ks-figure" style={{
            borderRadius: "50%", boxShadow: "0 0 10px rgba(255, 255, 255, 0.75)",
            background: "radial-gradient(circle at 56% 58%, #2A303A 0 14%, transparent 15%), radial-gradient(circle at 35% 30%, #FFFFFF 0 28%, #D5DAE1 68%, #8E98A6)",
          }} />
        </div>
      </div>
    </>
  );
});

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

/** How long a figure should take to reach its next spot, from how often scenes have been arriving. */
function useCadence(sceneId: string | undefined): number {
  // Worked out as the scene is drawn, so the figures set off at the new pace in the same frame as their new spots.
  const last = useRef<{ id: string | undefined; at: number; mean: number | null; ms: number }>({ id: undefined, at: 0, mean: null, ms: CADENCE.start });
  const state = last.current;
  if (sceneId && sceneId !== state.id) {
    const now = performance.now();
    const gap = now - state.at;
    const mean = state.id !== undefined && gap < CADENCE.pause ? (state.mean === null ? gap : state.mean * 0.6 + gap * 0.4) : state.mean;
    const ms = mean === null ? state.ms : Math.round(clamp(mean * CADENCE.lead, CADENCE.low, CADENCE.high) / 10) * 10;
    last.current = { id: sceneId, at: now, mean, ms };
  }
  return last.current.ms;
}

const UNMEASURED: Box = { width: 800, height: 450 };
const canFullScreen = () => typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.requestFullscreen === "function";

interface Pitch3DProps {
  scene: PitchScene | null;
  colors?: { home: string; away: string };
  /** The view to hold; without it the scene's own camera hint is followed. */
  camera?: Camera;
  /** Rings this player, such as the viewer's favourite. */
  followId?: string | null;
  /** Lets the viewer turn, tilt, zoom and move the camera, with the mouse, touch, the keyboard or the buttons shown, and fill the screen. */
  controls?: boolean;
  /** A view to hold without controls, such as one saved with a scene. */
  view?: Partial<View>;
  /** Zoomed in, the view drifts toward the ball instead of holding where it was moved to. */
  followBall?: boolean;
  /** Told of each change the viewer makes to the view. */
  onViewChange?(view: View): void;
  label: string;
  emptyText: string;
}

type Motion = "ease" | "quick" | "none";

/**
 * The pitch in three dimensions, drawn with CSS transforms from the Visualization Agent's scene:
 * the ball and its flight, the players, columns over the dangerous zones, and the current pass lanes.
 * Only the player on the ball is a known position; the fainter ones are estimated.
 */
export const Pitch3D = memo(function Pitch3D({
  scene, colors = DEFAULT_COLORS, camera, followId = null, controls = false, view, followBall = false, onViewChange, label, emptyText,
}: Pitch3DProps) {
  const preset = camera ?? "auto";
  const base = POSES[camera ?? scene?.camera ?? "broadcast"];
  const [user, setUser] = useState<{ preset: Camera | "auto"; view: View }>({ preset, view: LEVEL });
  if (user.preset !== preset) setUser({ preset, view: LEVEL });
  const own = controls ? (user.preset === preset ? user.view : LEVEL) : { ...LEVEL, ...view };

  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const box = useBox(root) ?? UNMEASURED;
  const { view: shown, pose, room } = settle(base, box, own);
  const level = shown.turn === 0 && shown.tilt === 0 && shown.zoom === 1 && shown.panX === 0 && shown.panY === 0;
  const fitted = shown.zoom === 1 && shown.panX === 0 && shown.panY === 0;

  const [settled, setSettled] = useState(false);
  const [motion, setMotion] = useState<Motion>("ease");
  const [gesture, setGesture] = useState<"orbit" | "pan" | "pinch" | null>(null);
  const [full, setFull] = useState(false);
  const ms = useCadence(scene?.id);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  const latest = useRef<{ base: Pose; box: Box; preset: Camera | "auto"; zoom: number }>({ base, box, preset, zoom: shown.zoom });
  latest.current = { base, box, preset, zoom: shown.zoom };
  const pending = useRef<Change>(NO_CHANGE);
  const frameId = useRef(0);
  const pointers = useRef(new Map<number, [number, number]>());
  const drag = useRef<"orbit" | "pan" | "pinch" | null>(null);
  const quiet = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (typeof requestAnimationFrame === "undefined") return;
    const handle = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(handle);
  }, []);
  useEffect(() => () => {
    if (frameId.current && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(frameId.current);
    clearTimeout(quiet.current);
  }, []);

  const tell = useRef(onViewChange);
  tell.current = onViewChange;
  useEffect(() => {
    if (controls) tell.current?.(shown);
  }, [controls, shown.turn, shown.tilt, shown.zoom, shown.panX, shown.panY]);

  useEffect(() => {
    if (!controls) return;
    const onChange = () => setFull(document.fullscreenElement === root.current && root.current !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [controls]);

  const apply = (change: Partial<Change>) =>
    setUser((current) => {
      const { base: now, box: size, preset: held } = latest.current;
      return { preset: held, view: applied(now, size, current.preset === held ? current.view : LEVEL, change) };
    });
  const act = (change: Partial<Change>, how: Motion = "ease") => {
    setMotion(how);
    apply(change);
  };
  const flush = () => {
    if (frameId.current && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(frameId.current);
    frameId.current = 0;
    const change = pending.current;
    pending.current = NO_CHANGE;
    if (change !== NO_CHANGE) apply(change);
  };
  const queue = (change: Partial<Change>) => {
    const current = pending.current;
    pending.current = {
      turn: current.turn + (change.turn ?? 0), tilt: current.tilt + (change.tilt ?? 0), dx: current.dx + (change.dx ?? 0), dy: current.dy + (change.dy ?? 0),
      zoom: current.zoom * (change.zoom ?? 1), anchor: change.anchor ?? current.anchor,
    };
    if (typeof requestAnimationFrame === "undefined") flush();
    else if (!frameId.current) frameId.current = requestAnimationFrame(flush);
  };
  const fromMiddle = (clientX: number, clientY: number): [number, number] => {
    const rect = stage.current?.getBoundingClientRect();
    return rect ? [clientX - rect.left - rect.width / 2, clientY - rect.top - rect.height / 2] : [0, 0];
  };

  const turnBy = (degrees: number) => act({ turn: degrees });
  const tiltBy = (degrees: number) => act({ tilt: degrees });
  const zoomBy = (factor: number) => act({ zoom: factor });
  const panBy = (dx: number, dy: number) => act({ dx, dy });
  const fit = () => {
    setMotion("ease");
    setUser((current) => ({ preset, view: { ...(current.preset === preset ? current.view : LEVEL), zoom: 1, panX: 0, panY: 0 } }));
  };
  const reset = () => {
    setMotion("ease");
    setUser({ preset, view: LEVEL });
  };

  const queueRef = useRef(queue);
  queueRef.current = queue;
  const middleRef = useRef(fromMiddle);
  middleRef.current = fromMiddle;
  useEffect(() => {
    const node = stage.current;
    if (!controls || !node) return;
    const onWheel = (event: WheelEvent) => {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const factor = Math.exp(-event.deltaY * unit * (event.ctrlKey ? 0.01 : 0.0015));
      const zoom = latest.current.zoom * pending.current.zoom;
      if (clamp(zoom * factor, ZOOM_RANGE[0], ZOOM_RANGE[1]) === zoom) return;
      event.preventDefault();
      setMotion("quick");
      clearTimeout(quiet.current);
      quiet.current = setTimeout(() => setMotion((current) => (current === "quick" ? "ease" : current)), 280);
      queueRef.current({ zoom: factor, anchor: middleRef.current(event.clientX, event.clientY) });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [controls]);

  const pinch = () => {
    const [a, b] = [...pointers.current.values()];
    return { span: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as [number, number] };
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!controls) return;
    const panning = event.button === 1 || event.button === 2 || (event.button === 0 && event.shiftKey);
    if (event.button !== 0 && !panning) return;
    if (event.button === 1) event.preventDefault();
    pointers.current.set(event.pointerId, [event.clientX, event.clientY]);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = pointers.current.size >= 2 ? "pinch" : panning ? "pan" : "orbit";
    setGesture(drag.current);
    setMotion("none");
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const from = pointers.current.get(event.pointerId);
    if (!from || !drag.current) return;
    if (drag.current === "pinch" && pointers.current.size >= 2) {
      const before = pinch();
      pointers.current.set(event.pointerId, [event.clientX, event.clientY]);
      const after = pinch();
      queue({
        zoom: before.span > 0 ? after.span / before.span : 1, anchor: fromMiddle(...after.mid),
        dx: after.mid[0] - before.mid[0], dy: after.mid[1] - before.mid[1],
      });
      return;
    }
    pointers.current.set(event.pointerId, [event.clientX, event.clientY]);
    const [dx, dy] = [event.clientX - from[0], event.clientY - from[1]];
    if (drag.current === "pan") queue({ dx, dy });
    else queue({ turn: -dx * 0.35, tilt: -dy * 0.25 });
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    flush();
    if (pointers.current.size > 0) {
      drag.current = null;
      return;
    }
    drag.current = null;
    setGesture(null);
    setMotion("ease");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return;
    const moving: Record<string, () => void> = {
      ArrowLeft: () => panBy(STEP.pan, 0), ArrowRight: () => panBy(-STEP.pan, 0), ArrowUp: () => panBy(0, STEP.pan), ArrowDown: () => panBy(0, -STEP.pan),
    };
    const keys: Record<string, () => void> = {
      ArrowLeft: () => turnBy(-STEP.turn), ArrowRight: () => turnBy(STEP.turn), ArrowUp: () => tiltBy(-STEP.tilt), ArrowDown: () => tiltBy(STEP.tilt),
      "+": () => zoomBy(STEP.zoom), "=": () => zoomBy(STEP.zoom), "-": () => zoomBy(1 / STEP.zoom), _: () => zoomBy(1 / STEP.zoom), "0": reset, Home: reset,
    };
    const run = (event.shiftKey && moving[event.key]) || keys[event.key];
    if (!run) return;
    event.preventDefault();
    run();
  };
  const toggleFull = () => {
    const node = root.current;
    if (!node) return;
    if (document.fullscreenElement === node) void Promise.resolve(document.exitFullscreen?.()).catch(() => {});
    else {
      void Promise.resolve(node.requestFullscreen()).catch(() => {});
      node.focus({ preventScroll: true });
    }
  };

  const ball: Vec | null = followBall && scene ? [(scene.ball.x / 100 - 0.5) * LENGTH, (scene.ball.y / 100 - 0.5) * WIDTH, 0] : null;
  const framing = frame(pose, room, shown, ball);
  const camMotion = !settled ? "0s" : !controls ? CAMERA_MOVE : motion === "none" ? "0s" : motion === "quick" ? CAMERA_QUICK : CAMERA_MOVE;
  const move = settled ? `transform ${ms}ms linear` : "none";
  const zoomPercent = Math.round(shown.zoom * 100);

  // Everything standing up turns to face the camera. Written to those few elements directly: a variable
  // inherited from the stage would restyle every element on the pitch at each step of a drag.
  const face = `rotateZ(${round(-pose.turn)}deg) rotateX(${round(-pose.tilt)}deg)|transform ${camMotion}`;
  useLayoutEffect(() => {
    const [transform, transition] = face.split("|");
    root.current?.querySelectorAll<HTMLElement>(".ks-face").forEach((node) => {
      if (node.dataset.face === face) return;
      node.style.transition = transition;
      node.style.transform = transform;
      node.dataset.face = face;
    });
  });

  const tool = (name: string, icon: ReactNode, run: () => void, disabled = false) => (
    <button type="button" className="ks-pitch3d-tool" aria-label={name} title={name} disabled={disabled} onClick={run}>{icon}</button>
  );

  return (
    <div ref={root} className="ks-pitch3d" data-testid="pitch3d" data-camera={camera ?? scene?.camera ?? "broadcast"} data-fullscreen={full || undefined}
      data-zooming={motion === "quick" || gesture === "pinch" || undefined}
      role={controls ? "group" : "img"} aria-label={label} aria-describedby={controls ? `${id}-hint` : undefined}
      aria-keyshortcuts={controls ? "ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown + - 0" : undefined}
      tabIndex={controls ? 0 : undefined} onKeyDown={controls ? onKeyDown : undefined}
      style={{ position: "relative", width: "100%", height: "100%", minHeight: 0, overflow: "hidden", userSelect: "none" }}>
      <style>{STYLES}</style>
      <div ref={stage} data-testid="pitch-view" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onContextMenu={controls ? (event) => event.preventDefault() : undefined}
        style={{
          position: "absolute", inset: 0, touchAction: controls ? "none" : undefined,
          cursor: controls ? (gesture === "pan" ? "move" : gesture ? "grabbing" : "grab") : undefined,
        }}>
        <div data-testid="pitch-camera" style={{
          position: "absolute", left: "50%", top: "50%", width: LENGTH, height: WIDTH, marginLeft: -LENGTH / 2, marginTop: -WIDTH / 2,
          perspective: DEPTH, perspectiveOrigin: "50% 50%", transform: `translate(${round(framing.x)}px, ${round(framing.y)}px) scale(${round(framing.scale * 1000) / 1000})`,
          transition: `transform ${camMotion}`,
        }}>
          <div data-testid="pitch-stage" style={{
            position: "absolute", inset: 0, transformStyle: "preserve-3d", transform: `rotateX(${round(pose.tilt)}deg) rotateZ(${round(pose.turn)}deg)`,
            transition: `transform ${camMotion}`, ["--ks-fig" as string]: room.figure,
          }}>
            <Scenery id={id} />
            {scene && <TrailShadow key={`${scene.id}-shadow`} trail={scene.trail} />}
            {scene?.lanes.map((lane, index) => <Lane key={`${index}-${lane.from_x}-${lane.to_x}`} lane={lane} color={colors[lane.team]} />)}
            {scene?.columns.map((column) => <Column key={`${column.team}-${column.x}-${column.y}`} column={column} color={colors[column.team]} />)}
            {scene && <Trail key={scene.id} trail={scene.trail} gradient={`${id}-trail`} />}
            {scene?.players.map((player) => <Player key={player.id} player={player} color={colors[player.team]} followed={player.id === followId} move={move} />)}
            {scene && <Ball scene={scene} ms={ms} animate={settled} />}
          </div>
        </div>
        <div aria-hidden style={{
          position: "absolute", inset: 0, pointerEvents: "none",
          background: "linear-gradient(to bottom, rgba(11, 18, 32, 0.4), rgba(11, 18, 32, 0) 40%), radial-gradient(ellipse 75% 85% at 50% 52%, rgba(5, 9, 18, 0) 60%, rgba(5, 9, 18, 0.5))",
        }} />
      </div>
      {controls && (
        <>
          <span id={`${id}-hint`} hidden>
            Drag to turn the view; shift-drag or right-drag to move it. Scroll or pinch to zoom toward the pointer. Arrow keys turn and tilt, shift with the arrow keys moves, plus and minus zoom, zero resets.
          </span>
          <div role="group" aria-label="Camera controls" className="ks-pitch3d-tools">
            {tool("Rotate left", <ArrowRotateCounterclockwiseRegular />, () => turnBy(-STEP.turn), shown.turn <= -TURN_LIMIT)}
            {tool("Rotate right", <ArrowRotateClockwiseRegular />, () => turnBy(STEP.turn), shown.turn >= TURN_LIMIT)}
            <hr />
            {tool("Tilt up", <ChevronUpRegular />, () => tiltBy(-STEP.tilt), pose.tilt <= TILT_RANGE[0])}
            {tool("Tilt down", <ChevronDownRegular />, () => tiltBy(STEP.tilt), pose.tilt >= TILT_RANGE[1])}
            <hr />
            {tool("Zoom out", <ZoomOutRegular />, () => zoomBy(1 / STEP.zoom), shown.zoom <= ZOOM_RANGE[0])}
            <input type="range" className="ks-pitch3d-zoom" aria-label="Zoom" min={ZOOM_RANGE[0] * 100} max={ZOOM_RANGE[1] * 100} step={5} value={zoomPercent}
              aria-valuetext={`${zoomPercent}%`} onChange={(event) => act({ zoom: Number(event.target.value) / 100 / shown.zoom }, "quick")} />
            {tool("Zoom in", <ZoomInRegular />, () => zoomBy(STEP.zoom), shown.zoom >= ZOOM_RANGE[1])}
            <output data-testid="zoom-readout" aria-live="polite">{zoomPercent}%</output>
            {tool("Fit", <ZoomFitRegular />, fit, fitted)}
            <hr />
            {tool("Reset view", <ArrowResetRegular />, reset, level)}
            {canFullScreen() && tool(full ? "Exit full screen" : "Full screen", full ? <FullScreenMinimizeRegular /> : <FullScreenMaximizeRegular />, toggleFull)}
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
});
