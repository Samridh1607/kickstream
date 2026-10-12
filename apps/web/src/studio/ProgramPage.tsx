import { useEffect, useMemo, useState } from "react";
import { AUDIENCE_STREAM } from "../audience/api";
import type { Audience, Scene, Studio, ViewerProfile } from "../contracts";
import { useMatch } from "../stream/store";
import { useLiveDocument } from "../stream/useLiveDocument";
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

// Side by side in height, so both can be on air at once without one covering the other.
const POLL_BOX = { x: 1240, y: 40, width: 640, height: 560 };
const QA_BOX = { x: 260, y: 620, width: 1400, height: 400 };

/** Whatever is on air must be visible: add a default box for each thing the scene has no element for. */
export function withFallbacks(scene: Scene, studio: Studio, audience: Audience | null | undefined): Scene {
  let shown = withReplayFallback(scene, studio);
  const missing = (type: "poll" | "qa") => !shown.elements.some((element) => element.type === type && element.visible);
  const add = (type: "poll" | "qa", box: typeof POLL_BOX) => {
    const fallback = { id: `__${type}`, type, ...box, layer: nextLayer(shown.elements), visible: true, props: {} };
    shown = { ...shown, elements: [...shown.elements, fallback] };
  };
  if (audience?.poll && audience.poll_on_air && missing("poll")) add("poll", POLL_BOX);
  if (audience?.qa && missing("qa")) add("qa", QA_BOX);
  return shown;
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
  const { doc: audience } = useLiveDocument<Audience>(AUDIENCE_STREAM, eventSource, retryMs);
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
        <SceneCanvas scene={withFallbacks(active, studio, audience)} scale={fitScale(size.width, size.height)}
          data={{ match, studio, now, language: studio.settings.language, audience }} />
      )}
    </div>
  );
}
