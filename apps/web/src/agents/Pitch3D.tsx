import type { CSSProperties } from "react";
import type { PitchScene } from "../contracts";
import { EASE } from "../motion/motion";

const TILT = 56; // degrees the pitch leans away from the viewer
const MOVE = `620ms ${EASE}`;
const DEFAULT_COLORS = { home: "#0F6CBD", away: "#C50F1F" };

export type Camera = PitchScene["camera"];

/** How the pitch is turned for each view. The attacking views swing round behind the side going forward. */
const VIEWS: Record<Camera, string> = {
  broadcast: `rotateX(${TILT}deg)`,
  tactical: "rotateX(24deg) scale(0.92)",
  attack_home: `rotateX(${TILT + 4}deg) rotateZ(-12deg) translateX(-3%)`,
  attack_away: `rotateX(${TILT + 4}deg) rotateZ(12deg) translateX(3%)`,
};

const HOP = "@keyframes ks-hop { 0%, 100% { transform: translateZ(0); } 50% { transform: translateZ(var(--peak)); } }";

/** Stands something up on the pitch so it faces the viewer, as a cut-out figure would. */
function standing(camera: Camera): CSSProperties {
  const lean = camera === "tactical" ? 24 : camera === "broadcast" ? TILT : TILT + 4;
  const turn = camera === "attack_home" ? 12 : camera === "attack_away" ? -12 : 0;
  return { transform: `rotateZ(${turn}deg) rotateX(${-lean}deg)`, transformOrigin: "50% 100%", transition: `transform 900ms ${EASE}` };
}

interface Pitch3DProps {
  scene: PitchScene | null;
  colors?: { home: string; away: string };
  /** The view to hold; without it the scene's own camera hint is followed. */
  camera?: Camera;
  /** Rings this player, such as the viewer's favourite. */
  followId?: string | null;
  label: string;
  emptyText: string;
}

/**
 * The pitch in three dimensions, drawn with CSS transforms from the Visualization Agent's scene:
 * the ball and its flight, the players, columns over the dangerous zones, and the current pass lanes.
 * Only the player on the ball is a known position; the fainter ones are estimated.
 */
export function Pitch3D({ scene, colors = DEFAULT_COLORS, camera, followId = null, label, emptyText }: Pitch3DProps) {
  const view = camera ?? scene?.camera ?? "broadcast";
  const stand = standing(view);
  const peak = scene ? Math.max(0, ...scene.trail.map((point) => point.z)) : 0;
  return (
    <div role="img" aria-label={label} data-testid="pitch3d" data-camera={view}
      style={{ containerType: "inline-size", position: "relative", width: "100%", height: "100%", minHeight: 0, perspective: "140cqw", perspectiveOrigin: "50% 0%", overflow: "hidden", display: "grid", placeItems: "center" }}>
      <style>{HOP}</style>
      <div style={{ position: "relative", width: "74%", aspectRatio: "105 / 68", transformStyle: "preserve-3d", transform: VIEWS[view], transition: `transform 900ms ${EASE}` }}>
        <svg viewBox="0 0 105 68" aria-hidden style={{ position: "absolute", inset: 0, width: "100%", height: "100%", borderRadius: "1.2cqw", boxShadow: "0 3cqw 6cqw rgba(0, 0, 0, 0.5)" }}>
          <defs>
            <pattern id="ks-mow" width="17.5" height="68" patternUnits="userSpaceOnUse">
              <rect width="8.75" height="68" fill="#2B7A30" />
              <rect x="8.75" width="8.75" height="68" fill="#2F8535" />
            </pattern>
          </defs>
          <rect width="105" height="68" rx="1" fill="url(#ks-mow)" />
          <g fill="none" stroke="#FFFFFF" strokeWidth={0.35} opacity={0.8}>
            <rect x={1.5} y={1.5} width={102} height={65} />
            <line x1={52.5} y1={1.5} x2={52.5} y2={66.5} />
            <circle cx={52.5} cy={34} r={9.15} />
            <rect x={1.5} y={13.85} width={16.5} height={40.3} />
            <rect x={87} y={13.85} width={16.5} height={40.3} />
            <rect x={1.5} y={24.85} width={5.5} height={18.3} />
            <rect x={98} y={24.85} width={5.5} height={18.3} />
          </g>
          {scene?.lanes.map((lane, index) => (
            <line key={`${index}-${lane.from_x}-${lane.to_x}`} data-testid="pass-lane" x1={lane.from_x * 1.05} y1={lane.from_y * 0.68} x2={lane.to_x * 1.05} y2={lane.to_y * 0.68}
              stroke="#FFFFFF" strokeWidth={0.5} strokeLinecap="round" strokeDasharray="1.6 1.4" opacity={0.25 + 0.6 * lane.weight}
              style={{ animation: "ks-flow 1.2s linear infinite" }} />
          ))}
        </svg>

        {scene?.columns.map((column) => (
          <div key={`${column.team}-${column.x}-${column.y}`} data-testid="danger-column" data-team={column.team}
            style={{ position: "absolute", left: `${column.x}%`, top: `${column.y}%`, width: `${column.width}%`, height: `${column.depth}%`, transformStyle: "preserve-3d" }}>
            <div style={{ position: "absolute", inset: "6%", borderRadius: "0.6cqw", backgroundColor: colors[column.team], opacity: 0.18 + 0.3 * column.intensity, transition: `opacity ${MOVE}` }} />
            {/* The column itself: a pane standing on the far edge of its zone, as tall as the danger. */}
            <div style={{ position: "absolute", left: "12%", right: "12%", bottom: "50%", height: `${column.intensity * 9}cqw`, ...stand, borderRadius: "0.5cqw 0.5cqw 0 0", background: `linear-gradient(to top, ${colors[column.team]}cc, ${colors[column.team]}22)`, transition: `height ${MOVE}, transform 900ms ${EASE}` }} />
          </div>
        ))}

        {scene?.players.map((player) => {
          const followed = player.id === followId;
          return (
            <div key={player.id} data-testid="pitch-player" data-player={player.id} data-estimated={player.estimated}
              style={{ position: "absolute", left: `${player.x}%`, top: `${player.y}%`, width: 0, height: 0, transformStyle: "preserve-3d", transition: `left ${MOVE}, top ${MOVE}`, zIndex: player.on_ball ? 2 : 1 }}>
              <div style={{ position: "absolute", left: "-1.3cqw", top: "-0.5cqw", width: "2.6cqw", height: "1cqw", borderRadius: "50%", backgroundColor: "rgba(0, 0, 0, 0.35)" }} />
              <div style={{ position: "absolute", left: "-1.25cqw", bottom: 0, width: "2.5cqw", height: "3.4cqw", ...stand }}>
                <div style={{
                  position: "absolute", inset: 0, display: "grid", placeItems: "center", borderRadius: "1.2cqw 1.2cqw 0.5cqw 0.5cqw",
                  color: "#FFFFFF", fontSize: "1.25cqw", fontWeight: 700, backgroundColor: colors[player.team],
                  border: `0.2cqw ${player.estimated ? "dashed" : "solid"} #FFFFFF`, opacity: player.estimated ? 0.72 : 1,
                  boxShadow: followed ? "0 0 0 0.45cqw #FFB900" : player.on_ball ? "0 0 0 0.35cqw rgba(255, 255, 255, 0.85)" : "none",
                  transition: `opacity ${MOVE}, box-shadow ${MOVE}`,
                }}>
                  {player.number}
                </div>
              </div>
            </div>
          );
        })}

        {scene && (
          <div data-testid="pitch-ball" style={{ position: "absolute", left: `${scene.ball.x}%`, top: `${scene.ball.y}%`, width: 0, height: 0, transformStyle: "preserve-3d", transition: `left ${MOVE}, top ${MOVE}`, zIndex: 3 }}>
            <div style={{ position: "absolute", left: "-0.7cqw", top: "-0.35cqw", width: "1.4cqw", height: "0.7cqw", borderRadius: "50%", backgroundColor: "rgba(0, 0, 0, 0.45)" }} />
            {/* Keyed by the scene, so each new touch replays the hop: the ball rises as high as its flight. */}
            <div key={scene.id} style={{ position: "absolute", transformStyle: "preserve-3d", animation: `ks-hop 620ms ${EASE}`, ["--peak" as string]: `${Math.min(peak, 8) * 1.1}cqw` }}>
              <div style={{ position: "absolute", left: "-0.75cqw", bottom: 0, width: "1.5cqw", height: "1.5cqw", ...stand }}>
                <div style={{ width: "100%", height: "100%", borderRadius: "50%", background: "radial-gradient(circle at 35% 30%, #FFFFFF, #C9CED6)", boxShadow: "0 0 1.2cqw rgba(255, 255, 255, 0.7)" }} />
              </div>
            </div>
          </div>
        )}
      </div>
      {!scene && <span style={{ position: "absolute", opacity: 0.7, textAlign: "center", padding: "0 1em" }}>{emptyText}</span>}
    </div>
  );
}
