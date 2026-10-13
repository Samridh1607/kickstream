import { useEffect, useMemo, useState } from "react";
import type { Scene, Studio, ViewerProfile } from "../contracts";
import { type ProgramCallOptions, useProgramCall } from "../people/useProgramCall";
import { useMatch } from "../stream/store";
import { type CurrentMatchOptions, useCurrentMatch } from "../stream/useCurrentMatch";
import { startCapture, type StopCapture } from "./capture";
import type { CameraTile } from "./elements";
import { fitScale, nextLayer } from "./geometry";
import { programMode } from "./mode";
import { SceneCanvas } from "./SceneCanvas";
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

/** Whatever is on air must be visible: add a default box for each thing the scene has no element for. */
export function withFallbacks(scene: Scene, studio: Studio, cameras: readonly CameraTile[] = []): Scene {
  return withCamerasFallback(withReplayFallback(scene, studio), cameras);
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

  // Opened by the pipeline's hidden browser with a token, the page offers to record itself. It
  // waits for the studio document, so the stream never begins on an empty frame. The pipeline
  // calls the function; a page may only ask to be captured in answer to an action.
  const token = useMemo(() => new URLSearchParams(window.location.search).get("capture"), []);
  const ready = Boolean(studio);
  useEffect(() => {
    if (!token || !ready) return;
    const page = window as unknown as { __kickstreamStartCapture?: () => Promise<void> };
    // At most one capture at a time: a call while one starts or runs gets the same promise.
    let current: Promise<void> | null = null;
    let stopRunning: (() => void) | null = null;
    let gone = false;
    page.__kickstreamStartCapture = () => {
      if (current) return current;
      const attempt: Promise<void> = (async () => {
        const stop = await capture(token, { width: window.innerWidth, height: window.innerHeight });
        if (gone) {
          stop();
          return;
        }
        stopRunning = stop;
        // Once it has ended by itself, a later call may start a new one.
        void (stop as StopCapture).ended?.then(() => {
          if (current === attempt) {
            current = null;
            stopRunning = null;
          }
        });
      })();
      current = attempt;
      attempt.catch(() => {
        if (current === attempt) current = null;
      });
      return attempt;
    };
    return () => {
      gone = true;
      stopRunning?.();
      delete page.__kickstreamStartCapture;
    };
  }, [token, ready, capture]);

  const active = studio?.scenes.find((scene) => scene.id === studio.active_scene_id) ?? studio?.scenes[0];
  return (
    <div data-testid="program"
      style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", overflow: "hidden", backgroundColor: "#000000", cursor: "none" }}>
      {studio && active && (
        <SceneCanvas scene={withFallbacks(active, studio, guests.cameras)} scale={fitScale(size.width, size.height)}
          data={{ match, studio, now, language: studio.settings.language, cameras: guests.cameras, renderVideo: guests.renderVideo }} />
      )}
    </div>
  );
}
