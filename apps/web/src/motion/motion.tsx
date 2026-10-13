import { type Key, useEffect, useRef, useState } from "react";

/** How long an element takes to arrive, leave, or settle after a move. */
export const ENTER_MS = 420;
export const EXIT_MS = 280;
export const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
/** For CSS that follows a changing number: a bar's width, a point's position. */
export const SETTLE = `600ms ${EASE}`;

const KEYFRAMES = `
@keyframes ks-rise { from { opacity: 0; transform: translateY(24px) scale(0.98); } to { opacity: 1; transform: none; } }
@keyframes ks-leave { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(-16px) scale(0.98); } }
@keyframes ks-pop { 0% { opacity: 0; transform: scale(0.86); } 60% { opacity: 1; transform: scale(1.03); } 100% { opacity: 1; transform: none; } }
@keyframes ks-slide { from { opacity: 0; transform: translateX(32px); } to { opacity: 1; transform: none; } }
@keyframes ks-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.55; transform: scale(0.82); } }
@keyframes ks-flow { to { stroke-dashoffset: -24; } }
@keyframes ks-glow { 0%, 100% { box-shadow: 0 0 0 0 rgba(255, 255, 255, 0); } 50% { box-shadow: 0 0 0 8px rgba(255, 255, 255, 0.14); } }
@keyframes ks-orbit { from { transform: rotateZ(-4deg); } to { transform: rotateZ(4deg); } }
@keyframes kickstream-ticker { from { transform: translateX(0); } to { transform: translateX(-100%); } }
@media (prefers-reduced-motion: reduce) {
  .ks-motion, .ks-motion * { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important; }
}
`;

/** The keyframes every animated part uses. Render once inside anything that animates. */
export function MotionStyles() {
  return <style>{KEYFRAMES}</style>;
}

export const rise = (delayMs = 0) => `ks-rise ${ENTER_MS}ms ${EASE} ${delayMs}ms both`;
export const pop = (delayMs = 0) => `ks-pop ${ENTER_MS}ms ${EASE} ${delayMs}ms both`;
export const slide = (delayMs = 0) => `ks-slide ${ENTER_MS}ms ${EASE} ${delayMs}ms both`;
export const leave = `ks-leave ${EXIT_MS}ms ease-in both`;

// The component tests' DOM draws nothing, and they assert on what is shown: a number still
// counting up, or an element lingering to fade out, would only make them wait.
const STILL = typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** A number that eases to each new value instead of jumping to it. */
export function useTween(target: number, ms = 600): number {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (STILL || reducedMotion() || from.current === target) {
      from.current = target;
      setShown(target);
      return;
    }
    const start = from.current;
    const began = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / ms);
      const eased = 1 - (1 - t) ** 3;
      const value = start + (target - start) * eased;
      from.current = value;
      setShown(value);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return shown;
}

export interface Present<T> {
  item: T;
  /** True while the item is on its way out: it is no longer in the list, and is shown only to animate away. */
  leaving: boolean;
}

/**
 * The items to draw: those in the list, and for a moment those that have just left it, so a
 * removal can be animated. Items keep the order they had.
 */
export function usePresence<T>(items: readonly T[], keyOf: (item: T) => Key, exitMs = EXIT_MS): Present<T>[] {
  const [leaving, setLeaving] = useState<{ item: T; index: number }[]>([]);
  const previous = useRef<readonly T[]>(items);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  useEffect(() => {
    const now = new Set(items.map(keyOf));
    const gone = previous.current
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !now.has(keyOf(item)));
    previous.current = items;
    if (gone.length === 0 || STILL) return;
    setLeaving((current) => [...current.filter(({ item }) => !now.has(keyOf(item))), ...gone]);
    const keys = new Set(gone.map(({ item }) => keyOf(item)));
    // Not cancelled when the list changes again: each departure still ends after its own time.
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setLeaving((current) => current.filter(({ item }) => !keys.has(keyOf(item))));
    }, exitMs);
    timers.current.add(timer);
    // keyOf is expected to be stable in what it returns; only the list drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, exitMs]);

  const present = new Set(items.map(keyOf));
  const shown: Present<T>[] = items.map((item) => ({ item, leaving: false }));
  for (const { item, index } of leaving) {
    if (!present.has(keyOf(item))) shown.splice(Math.min(index, shown.length), 0, { item, leaving: true });
  }
  return shown;
}
