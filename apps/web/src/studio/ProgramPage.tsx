import { useEffect, useMemo, useState } from "react";
import type { FanZone, Scene, Studio, ViewerProfile } from "../contracts";
import { FANS_STREAM } from "../fans/api";
import { type ProgramCallOptions, useProgramCall } from "../people/useProgramCall";
import { useMatch } from "../stream/store";
import { useLiveDocument } from "../stream/useLiveDocument";
import { type CurrentMatchOptions, useCurrentMatch } from "../stream/useCurrentMatch";
import { startCapture } from "./capture";
import type { CameraTile } from "./elements";
import { fitScale, nextLayer } from "./geometry";
import { programMode } from "./mode";
import { SceneCanvas } from "./SceneCanvas";
import { useCaptureOffer } from "./useCaptureOffer";
import { useNow, useStudio } from "./useStudio";

const REPLAY_BOX = { x: 360, y: 180, width: 1200, height: 720 };

/** A replay must never be invisible: add a centred replay box to a scene that has none showing. */
export function withReplayFallback(scene: Scene, studio: Studio): Scene {
  if (!studio.replay || scene.elements.some((element) => element.type === "replay" && element.visible)) return scene;
  const fallback = { id: "__replay", type: "replay" as const, ...REPLAY_BOX, layer: nextLayer(scene.elements), visible: true, props: {} };
  return { ...scene, elements: [...scene.elements, fallback] };
}

const CAMERAS_BOX = { x: 1440, y: 740, width: 440, height: 300 };

/** People on stage must be seen: add a picture-in-picture box to a scene that shows no cameras. */
export function withCamerasFallback(scene: Scene, cameras: readonly CameraTile[]): Scene {
  if (cameras.length === 0 || scene.elements.some((element) => element.type === "cameras" && element.visible)) return scene;
  const fallback = { id: "__cameras", type: "cameras" as const, ...CAMERAS_BOX, layer: nextLayer(scene.elements), visible: true, props: { names: true } };
  return { ...scene, elements: [...scene.elements, fallback] };
}

const SPOTLIGHT_BOX = { x: 460, y: 780, width: 1000, height: 220 };
const POLL_BOX = { x: 1240, y: 300, width: 640, height: 440 };

/** A spotlight or a poll put on air from the fan zone must be seen: give each a box in a scene with none for it. */
export function withFanFallbacks(scene: Scene, fans: FanZone | null | undefined): Scene {
  if (!fans) return scene;
  const has = (type: "spotlight" | "poll") => scene.elements.some((element) => element.type === type && element.visible);
  const added = [];
  if (fans.poll && fans.poll_on_air && !has("poll")) added.push({ id: "__poll", type: "poll" as const, ...POLL_BOX });
  if (fans.spotlight && !has("spotlight")) added.push({ id: "__spotlight", type: "spotlight" as const, ...SPOTLIGHT_BOX });
  if (added.length === 0) return scene;
  const top = nextLayer(scene.elements);
  return { ...scene, elements: [...scene.elements, ...added.map((box, index) => ({ ...box, layer: top + index, visible: true, props: {} }))] };
}

/** Whatever is on air must be visible: add a default box for each thing the scene has no element for. */
export function withFallbacks(scene: Scene, studio: Studio, cameras: readonly CameraTile[] = [], fans: FanZone | null = null): Scene {
  return withFanFallbacks(withCamerasFallback(withReplayFallback(scene, studio), cameras), fans);
}

export function useWindowSize() {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/** `/studio?output` shows the clean picture. The pipeline's hidden browser opens it with a `capture` token. */
export function isOutputView(search: string): boolean {
  const query = new URLSearchParams(search);
  return query.has("output") || query.has("capture");
}

/** The clean output: the active scene, scaled to the window, with no controls. */
export function ProgramPage({
  eventSource, retryMs, pollMs, capture = startCapture, newCall, seat, connectAudio, rejoinMs,
}: CurrentMatchOptions & ProgramCallOptions & { capture?: typeof startCapture }) {
  const { studio, offset } = useStudio(eventSource, retryMs);
  const mode = studio ? programMode(studio) : undefined;
  const language = studio?.settings.language;
  const profile = useMemo<ViewerProfile | null>(
    () => (mode && language ? { mode, language, club: null, player: null } : null),
    [mode, language],
  );
  useCurrentMatch(profile, { eventSource, retryMs, pollMs });
  const match = useMatch((state) => state.data);
  const now = useNow() + offset;
  const size = useWindowSize();
  const guests = useProgramCall({ eventSource, retryMs, newCall, seat, connectAudio, rejoinMs });
  const { doc: fans } = useLiveDocument<FanZone>(FANS_STREAM, eventSource, retryMs);
  useCaptureOffer(Boolean(studio), capture);

  const active = studio?.scenes.find((scene) => scene.id === studio.active_scene_id) ?? studio?.scenes[0];
  return (
    <div data-testid="program"
      style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", overflow: "hidden", backgroundColor: "#000000", cursor: "none" }}>
      {studio && active && (
        <SceneCanvas scene={withFallbacks(active, studio, guests.cameras, fans)} scale={fitScale(size.width, size.height)}
          data={{ match, studio, now, language: studio.settings.language, fans, cameras: guests.cameras, renderVideo: guests.renderVideo }} />
      )}
    </div>
  );
}
