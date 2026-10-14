import { makeStyles, mergeClasses, Text, tokens } from "@fluentui/react-components";
import { useCallback, useRef, useState } from "react";
import type { Scene } from "../contracts";
import type { ProgramData } from "./elements";
import { CANVAS } from "./geometry";
import { SceneCanvas } from "./SceneCanvas";

// The scale where the stage's box cannot be measured, and the smallest it is allowed to shrink to.
const DEFAULT_SCALE = 0.45;
const MIN_SCALE = 0.2;
// Room kept below and above the stage for the top bar, the backstage row and the scene strip.
const DEFAULT_RESERVE = 400;

const useStyles = makeStyles({
  stage: { position: "relative", display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, minWidth: 0 },
  // Measured for the scale, so it always takes the full width; the picture inside is centred in it.
  frame: { display: "flex", justifyContent: "center", minWidth: 0 },
  picture: {
    position: "relative", overflow: "hidden", borderRadius: tokens.borderRadiusLarge, backgroundColor: "#05080F",
    outline: `${tokens.strokeWidthThick} solid transparent`,
  },
  live: { outline: `${tokens.strokeWidthThicker} solid #D92D20` },
  tag: {
    position: "absolute", top: tokens.spacingVerticalS, left: tokens.spacingHorizontalS, zIndex: 1,
    display: "inline-flex", alignItems: "center", gap: tokens.spacingHorizontalXS, padding: `2px ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusCircular, color: "#FFFFFF", backgroundColor: "rgba(0, 0, 0, 0.6)", fontWeight: tokens.fontWeightSemibold,
  },
  liveTag: { backgroundColor: "#D92D20" },
});

/** The scale at which the 16:9 stage fills its box, without growing taller than the window has room for. */
export function useStageScale(reserve = DEFAULT_RESERVE): [(node: HTMLDivElement | null) => void, number] {
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const cleanup = useRef<(() => void) | null>(null);
  const frame = useCallback((node: HTMLDivElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!node) return;
    const measure = () => {
      const width = node.clientWidth;
      if (width === 0) return;
      const fit = Math.min(width / CANVAS.width, (window.innerHeight - reserve) / CANVAS.height);
      setScale(Math.min(Math.max(fit, MIN_SCALE), width / CANVAS.width));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("resize", measure);
    measure();
    cleanup.current = () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [reserve]);
  return [frame, scale];
}

interface StageProps {
  /** The scene on air, with its fallbacks already added (`withFallbacks`), exactly as the program draws it. */
  scene: Scene;
  data: ProgramData;
  /** Whether the stream is going out. */
  live: boolean;
  /** Vertical room, in pixels, kept free around the stage. */
  reserve?: number;
}

/** What goes out: the scene on air, large. */
export function Stage({ scene, data, live, reserve }: StageProps) {
  const styles = useStyles();
  const [frame, scale] = useStageScale(reserve);
  return (
    <section className={styles.stage} aria-label="Stage">
      <div ref={frame} className={styles.frame}>
        <div className={mergeClasses(styles.picture, live && styles.live)} data-live={live}>
          <span className={mergeClasses(styles.tag, live && styles.liveTag)} data-testid="stage-tag">
            <Text size={200} weight="semibold" style={{ color: "inherit" }}>{live ? "Program · LIVE" : "Program"}</Text>
          </span>
          <SceneCanvas scene={scene} data={data} scale={scale} />
        </div>
      </div>
    </section>
  );
}
