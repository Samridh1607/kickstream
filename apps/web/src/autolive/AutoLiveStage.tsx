import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { AutoLive, AutoLiveScene } from "../contracts";
import { EASE } from "../motion/motion";
import type { ProgramData } from "../studio/elements";
import { CANVAS } from "../studio/geometry";
import { SceneCanvas } from "../studio/SceneCanvas";

export type Transition = AutoLive["transition"];

/** How long one screen takes to give way to the next. */
export const TRANSITION_MS = 1100;
const HEADER = 96;
const STILL = typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);

const KEYFRAMES = `
@keyframes al-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes al-fade-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes al-slide-in { from { transform: translateX(100%); } to { transform: none; } }
@keyframes al-slide-out { from { transform: none; opacity: 1; } to { transform: translateX(-35%); opacity: 0; } }
@keyframes al-zoom-in { from { transform: scale(1.18); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes al-zoom-out { from { transform: none; opacity: 1; } to { transform: scale(0.86); opacity: 0; } }
@keyframes al-wipe-in { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
@keyframes al-push-in { from { transform: translateY(100%); } to { transform: none; } }
@keyframes al-push-out { from { transform: none; } to { transform: translateY(-100%); } }
@keyframes al-iris-in { from { clip-path: circle(0% at 50% 55%); } to { clip-path: circle(75% at 50% 55%); } }
@keyframes al-hold { from { opacity: 1; } to { opacity: 1; } }
@keyframes al-stinger { 0% { transform: translateX(-130%) skewX(-14deg); } 38%, 62% { transform: translateX(0) skewX(-14deg); } 100% { transform: translateX(130%) skewX(-14deg); } }
@keyframes al-stinger-text { 0%, 22% { opacity: 0; transform: translateY(12px); } 40%, 60% { opacity: 1; transform: none; } 78%, 100% { opacity: 0; } }
@keyframes al-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@keyframes al-caption { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }
@keyframes al-bars { 0%, 100% { transform: scaleY(0.3); } 50% { transform: scaleY(1); } }
`;

const ENTER: Record<Transition, string> = {
  fade: "al-fade-in", slide: "al-slide-in", zoom: "al-zoom-in", wipe: "al-wipe-in", push: "al-push-in", iris: "al-iris-in",
};
// Wipe and iris reveal the new screen over the old one, which simply holds still beneath.
const EXIT: Record<Transition, string> = {
  fade: "al-fade-out", slide: "al-slide-out", zoom: "al-zoom-out", wipe: "al-hold", push: "al-push-out", iris: "al-hold",
};

const KIND_LABEL: Record<AutoLiveScene["kind"], string> = {
  agent: "AI agent", match: "Match", analysis: "Analysis", fans: "Fans", show: "Kickstream Live",
};

interface Swap {
  current: string;
  leaving: string | null;
  transition: Transition;
  /** Changes with every switch, so a repeat of the same screen still animates. */
  turn: number;
}

/** The screen on air and, for the length of a transition, the one it replaces. */
export function useSceneSwap(sceneId: string, transition: Transition, ms = TRANSITION_MS): Swap {
  const [swap, setSwap] = useState<Swap>({ current: sceneId, leaving: null, transition, turn: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setSwap((before) => {
      if (before.current === sceneId) return before;
      return { current: sceneId, leaving: STILL ? null : before.current, transition, turn: before.turn + 1 };
    });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSwap((before) => (before.leaving ? { ...before, leaving: null } : before)), ms);
  }, [sceneId, transition, ms]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return swap;
}

const LAYER: CSSProperties = { position: "absolute", left: 0, top: 0, width: CANVAS.width, height: CANVAS.height, willChange: "transform, opacity" };

function Header({ scene, data, now }: { scene: AutoLiveScene; data: ProgramData; now: number }) {
  const status = data.match.status;
  const clock = new Date(now * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div data-testid="autolive-header" style={{
      position: "absolute", left: 0, top: 0, width: CANVAS.width, height: HEADER, zIndex: 50, display: "flex", alignItems: "center", gap: 28,
      padding: "0 40px", boxSizing: "border-box", color: "#FFFFFF",
      background: "linear-gradient(90deg, rgba(8, 14, 28, 0.96) 0%, rgba(17, 33, 64, 0.94) 55%, rgba(8, 14, 28, 0.96) 100%)",
      borderBottom: "2px solid rgba(255, 255, 255, 0.08)",
    }}>
      <span style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 18px", borderRadius: 10, backgroundColor: "#C50F1F", fontSize: 26, fontWeight: 800, letterSpacing: 2 }}>
        <span style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: "#FFFFFF", animation: "al-pulse 1.6s ease-in-out infinite" }} />
        LIVE
      </span>
      <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: 3, opacity: 0.85 }}>KICKSTREAM</span>
      <span key={scene.id} style={{ display: "flex", alignItems: "baseline", gap: 18, minWidth: 0, animation: `al-caption 600ms ${EASE} both` }}>
        <span data-testid="autolive-title" style={{ fontSize: 40, fontWeight: 700, whiteSpace: "nowrap" }}>{scene.name}</span>
        <span style={{
          fontSize: 20, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", padding: "4px 12px", borderRadius: 999,
          color: scene.kind === "agent" ? "#0B1220" : "#FFFFFF", backgroundColor: scene.kind === "agent" ? "#7FDBFF" : "rgba(255, 255, 255, 0.14)",
        }}>{KIND_LABEL[scene.kind]}</span>
      </span>
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 24, fontSize: 30, fontWeight: 700, whiteSpace: "nowrap" }}>
        {status && (
          <span data-testid="autolive-score">
            {status.home.short_name} {status.score_home} – {status.score_away} {status.away.short_name}
            <span style={{ marginLeft: 16, opacity: 0.7 }}>{status.state === "live" ? `${Math.max(status.minute, data.match.minute)}'` : status.state.replace("_", " ")}</span>
          </span>
        )}
        <span style={{ opacity: 0.6, fontWeight: 600 }}>{clock}</span>
      </span>
    </div>
  );
}

function Progress({ doc, now }: { doc: AutoLive; now: number }) {
  if (doc.next_at == null || !doc.settings.enabled) return null;
  const span = Math.max(1, doc.next_at - doc.changed_at);
  const done = Math.min(1, Math.max(0, (now - doc.changed_at) / span));
  return (
    <div data-testid="autolive-progress" style={{ position: "absolute", left: 0, top: HEADER, width: CANVAS.width, height: 4, zIndex: 50, backgroundColor: "rgba(255, 255, 255, 0.08)" }}>
      <div style={{ width: `${done * 100}%`, height: "100%", background: "linear-gradient(90deg, #0F6CBD, #7FDBFF)", transition: "width 1s linear" }} />
    </div>
  );
}

function UpNext({ doc, now }: { doc: AutoLive; now: number }) {
  if (doc.next_at == null || !doc.settings.enabled || doc.next_at - now > 12 || doc.next_at - now < 0) return null;
  const order = doc.settings.scenes;
  const nextId = order[(order.indexOf(doc.scene_id) + 1) % order.length];
  const next = doc.scenes.find((scene) => scene.id === nextId);
  if (!next) return null;
  return (
    <div data-testid="autolive-up-next" style={{
      position: "absolute", right: 40, top: HEADER + 20, zIndex: 50, padding: "10px 22px", borderRadius: 12, fontSize: 26, fontWeight: 600,
      color: "#FFFFFF", backgroundColor: "rgba(15, 108, 189, 0.92)", animation: `al-caption 500ms ${EASE} both`,
    }}>
      Up next · {next.name}
    </div>
  );
}

function Stinger({ scene, turn }: { scene: AutoLiveScene; turn: number }) {
  if (STILL || turn === 0) return null;
  return (
    <div key={turn} aria-hidden style={{ position: "absolute", inset: 0, zIndex: 60, pointerEvents: "none", overflow: "hidden" }}>
      <div style={{
        position: "absolute", left: -200, top: 330, width: CANVAS.width + 400, height: 420, display: "grid", placeItems: "center",
        background: "linear-gradient(90deg, rgba(15, 108, 189, 0) 0%, rgba(15, 108, 189, 0.96) 18%, rgba(92, 46, 145, 0.96) 82%, rgba(92, 46, 145, 0) 100%)",
        animation: `al-stinger ${TRANSITION_MS}ms ${EASE} both`,
      }}>
        <span style={{ color: "#FFFFFF", fontSize: 76, fontWeight: 800, letterSpacing: 1, transform: "skewX(14deg)", animation: `al-stinger-text ${TRANSITION_MS}ms ease both` }}>
          {scene.name}
        </span>
      </div>
    </div>
  );
}

function Caption({ text, speaking }: { text: string | null; speaking: boolean }) {
  if (!text) return null;
  return (
    <div key={text} data-testid="autolive-caption" style={{
      position: "absolute", left: 200, right: 200, bottom: 104, zIndex: 55, display: "flex", alignItems: "center", gap: 22,
      padding: "18px 28px", borderRadius: 18, color: "#FFFFFF", fontSize: 34, lineHeight: 1.3, fontWeight: 500,
      backgroundColor: "rgba(8, 14, 28, 0.86)", border: "2px solid rgba(127, 219, 255, 0.35)", animation: `al-caption 500ms ${EASE} both`,
    }}>
      <span aria-hidden style={{ display: "flex", alignItems: "center", gap: 5, height: 40, flexShrink: 0 }}>
        {[0, 1, 2, 3].map((bar) => (
          <span key={bar} style={{
            width: 7, height: 40, borderRadius: 4, backgroundColor: "#7FDBFF", transformOrigin: "50% 50%",
            animation: speaking ? `al-bars 900ms ease-in-out ${bar * 120}ms infinite` : "none", transform: speaking ? undefined : "scaleY(0.3)",
          }} />
        ))}
      </span>
      <span style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{text}</span>
    </div>
  );
}

interface AutoLiveStageProps {
  doc: AutoLive;
  data: ProgramData;
  /** Server time, Unix seconds. */
  now: number;
  /** Screen pixels per canvas pixel. */
  scale: number;
  caption: string | null;
  speaking?: boolean;
}

/** Auto live's 1920 x 1080 picture: the screen on air with its transition, the header band and the captions. */
export function AutoLiveStage({ doc, data, now, scale, caption, speaking = false }: AutoLiveStageProps) {
  const swap = useSceneSwap(doc.scene_id, doc.transition);
  const byId = (id: string | null) => (id ? doc.scenes.find((scene) => scene.id === id) : undefined);
  const current = byId(swap.current) ?? doc.scenes[0];
  const leaving = byId(swap.leaving);
  if (!current) return null;
  return (
    <div data-testid="autolive-stage" data-scene={current.id} data-transition={swap.transition}
      style={{ position: "relative", overflow: "hidden", width: CANVAS.width * scale, height: CANVAS.height * scale, flexShrink: 0, backgroundColor: "#060B16" }}>
      <style>{KEYFRAMES}</style>
      <div style={{ position: "absolute", left: 0, top: 0, width: CANVAS.width, height: CANVAS.height, transform: `scale(${scale})`, transformOrigin: "0 0" }}>
        {leaving && (
          <div key={`out-${swap.turn}`} style={{ ...LAYER, zIndex: 1, animation: `${EXIT[swap.transition]} ${TRANSITION_MS}ms ${EASE} both` }}>
            <SceneCanvas scene={leaving} data={data} scale={1} />
          </div>
        )}
        <div key={`in-${swap.turn}`} data-testid="autolive-screen" style={{
          ...LAYER, zIndex: 2, animation: swap.turn === 0 ? "none" : `${ENTER[swap.transition]} ${TRANSITION_MS}ms ${EASE} both`,
        }}>
          <SceneCanvas scene={current} data={data} scale={1} />
        </div>
        <Header scene={current} data={data} now={now} />
        <Progress doc={doc} now={now} />
        <UpNext doc={doc} now={now} />
        <Caption text={caption} speaking={speaking} />
        <Stinger scene={current} turn={swap.turn} />
      </div>
    </div>
  );
}
