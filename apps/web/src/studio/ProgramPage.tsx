import { useEffect, useMemo, useState } from "react";
import type { Scene, Studio, ViewerProfile } from "../contracts";
import { useMatch } from "../stream/store";
import { type CurrentMatchOptions, useCurrentMatch } from "../stream/useCurrentMatch";
import { fitScale, nextLayer } from "./geometry";
import { SceneCanvas } from "./SceneCanvas";
import { useNow, useStudio } from "./useStudio";

const REPLAY_BOX = { x: 360, y: 180, width: 1200, height: 720 };

/** A replay must never be invisible: add a centred replay box to a scene that has none showing. */
export function withReplayFallback(scene: Scene, studio: Studio): Scene {
  if (!studio.replay || scene.elements.some((element) => element.type === "replay" && element.visible)) return scene;
  const fallback = { id: "__replay", type: "replay" as const, ...REPLAY_BOX, layer: nextLayer(scene.elements), visible: true, props: {} };
  return { ...scene, elements: [...scene.elements, fallback] };
}

function useWindowSize() {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/** The clean output: the active scene, scaled to the window, with no controls. */
export function ProgramPage({ eventSource, retryMs, pollMs }: CurrentMatchOptions) {
  const { studio, offset } = useStudio(eventSource, retryMs);
  const mode = studio?.settings.mode;
  const language = studio?.settings.language;
  const profile = useMemo<ViewerProfile | null>(
    () => (mode && language ? { mode, language, club: null, player: null } : null),
    [mode, language],
  );
  useCurrentMatch(profile, { eventSource, retryMs, pollMs });
  const match = useMatch((state) => state.data);
  const now = useNow() + offset;
  const size = useWindowSize();

  const active = studio?.scenes.find((scene) => scene.id === studio.active_scene_id) ?? studio?.scenes[0];
  return (
    <div data-testid="program"
      style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", overflow: "hidden", backgroundColor: "#000000", cursor: "none" }}>
      {studio && active && (
        <SceneCanvas scene={withReplayFallback(active, studio)} scale={fitScale(size.width, size.height)}
          data={{ match, studio, now, language: studio.settings.language }} />
      )}
    </div>
  );
}
