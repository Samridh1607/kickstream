import { FluentProvider } from "@fluentui/react-components";
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import type { Scene, SceneElement } from "../contracts";
import { EASE, leave, MotionStyles, rise, usePresence } from "../motion/motion";
import { darkTheme } from "../theme";
import { ElementView, type ProgramData } from "./elements";
import { CANVAS, GRID, moveBy, type Rect, rectOf, resizeBy, sameRect } from "./geometry";

interface SceneCanvasProps {
  scene: Scene;
  data: ProgramData;
  /** Screen pixels per canvas pixel. */
  scale: number;
  editable?: boolean;
  selectedId?: string | null;
  onSelect?(elementId: string | null): void;
  /** Called once when a move or resize ends, with the whole element list. */
  onChange?(elements: SceneElement[]): void;
}

interface Gesture {
  id: string;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  origin: Rect;
}

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-GRID, 0], ArrowRight: [GRID, 0], ArrowUp: [0, -GRID], ArrowDown: [0, GRID],
};
// An element moved or resized from the studio glides to its new place on the program.
const GLIDE = `left 450ms ${EASE}, top 450ms ${EASE}, width 450ms ${EASE}, height 450ms ${EASE}, opacity 300ms ease`;
const elementId = (element: SceneElement) => element.id;
const HANDLE: CSSProperties = { position: "absolute", inset: 0, cursor: "move", touchAction: "none", background: "transparent" };
const CORNER: CSSProperties = {
  position: "absolute", right: -14, bottom: -14, width: 40, height: 40, borderRadius: 8, cursor: "nwse-resize",
  touchAction: "none", backgroundColor: "#0F6CBD", border: "4px solid #FFFFFF",
};
const LABEL: CSSProperties = {
  position: "absolute", left: 0, top: 0, padding: "2px 12px", fontSize: 24, color: "#FFFFFF",
  backgroundColor: "rgba(15, 108, 189, 0.9)", borderBottomRightRadius: 8, pointerEvents: "none",
};

/** Draws a scene on the 16:9 canvas. The same component is the program and, with `editable`, the editor. */
export function SceneCanvas({ scene, data, scale, editable = false, selectedId = null, onSelect, onChange }: SceneCanvasProps) {
  const [draft, setDraft] = useState<{ id: string; rect: Rect } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const drawn = scene.elements.filter((element) => editable || element.visible).sort((a, b) => a.layer - b.layer);
  // An element taken off the scene stays for a moment, to fade out instead of vanishing.
  const shown = usePresence(drawn, elementId);

  const commit = (id: string, rect: Rect) =>
    onChange?.(scene.elements.map((element) => (element.id === id ? { ...element, ...rect } : element)));

  const rectAt = (current: Gesture, event: PointerEvent) => {
    const dx = (event.clientX - current.startX) / scale;
    const dy = (event.clientY - current.startY) / scale;
    return current.mode === "move" ? moveBy(current.origin, dx, dy) : resizeBy(current.origin, dx, dy);
  };

  const begin = (event: PointerEvent, element: SceneElement, mode: Gesture["mode"]) => {
    event.preventDefault();
    event.stopPropagation();
    // Keeps the gesture alive when the pointer leaves the handle. Not available in every test DOM.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    gesture.current = { id: element.id, mode, startX: event.clientX, startY: event.clientY, origin: rectOf(element) };
    onSelect?.(element.id);
  };

  const track = (event: PointerEvent) => {
    const current = gesture.current;
    if (current) setDraft({ id: current.id, rect: rectAt(current, event) });
  };

  const finish = (event: PointerEvent) => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    setDraft(null);
    const rect = rectAt(current, event);
    if (!sameRect(rect, current.origin)) commit(current.id, rect);
  };

  const nudge = (event: KeyboardEvent, element: SceneElement) => {
    const step = ARROWS[event.key];
    if (!step) return;
    event.preventDefault();
    const origin = rectOf(element);
    const rect = event.shiftKey ? resizeBy(origin, step[0], step[1]) : moveBy(origin, step[0], step[1]);
    if (!sameRect(rect, origin)) commit(element.id, rect);
  };

  return (
    // The broadcast is always dark, whatever theme the page around it uses.
    <FluentProvider theme={darkTheme} data-testid="scene-canvas"
      style={{ position: "relative", overflow: "hidden", width: CANVAS.width * scale, height: CANVAS.height * scale, backgroundColor: "#0B1220", flexShrink: 0 }}
      onPointerDown={editable ? () => onSelect?.(null) : undefined}>
      <MotionStyles />
      <div style={{ position: "relative", width: CANVAS.width, height: CANVAS.height, transform: `scale(${scale})`, transformOrigin: "0 0" }}>
        {shown.map(({ item: element, leaving }) => {
          const dragged = draft?.id === element.id;
          const rect = dragged ? draft.rect : rectOf(element);
          const selected = element.id === selectedId;
          return (
            <div key={element.id} data-testid={`element-${element.type}`} data-element-id={element.id} className="ks-motion"
              style={{
                position: "absolute", left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: element.layer,
                opacity: editable && !element.visible ? 0.35 : 1, transition: dragged ? "none" : GLIDE,
                animation: leaving ? leave : rise(), pointerEvents: leaving ? "none" : undefined,
              }}>
              <ElementView element={element} data={data} />
              {editable && !leaving && (
                <>
                  <span style={LABEL}>{element.type}</span>
                  <div role="button" tabIndex={0} aria-label={`${element.type} element`} aria-pressed={selected}
                    style={{ ...HANDLE, outline: selected ? "6px solid #0F6CBD" : "2px dashed rgba(255, 255, 255, 0.5)" }}
                    onPointerDown={(event) => begin(event, element, "move")} onPointerMove={track} onPointerUp={finish}
                    onKeyDown={(event) => nudge(event, element)} />
                  {selected && (
                    <div role="button" tabIndex={-1} aria-label={`Resize ${element.type} element`} style={CORNER}
                      onPointerDown={(event) => begin(event, element, "resize")} onPointerMove={track} onPointerUp={finish} />
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </FluentProvider>
  );
}
