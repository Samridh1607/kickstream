import type { Scene, Studio } from "../contracts";
import type { Mode } from "../i18n";

/** Whose commentary a scene shows: its own choice, or else the studio's. */
export function sceneMode(scene: Scene | undefined, studio: Studio): Mode {
  return scene?.mode ?? studio.settings.mode;
}

export function onAirScene(studio: Studio): Scene {
  return studio.scenes.find((scene) => scene.id === studio.active_scene_id) ?? studio.scenes[0];
}

/** The commentary the program carries: that of the scene on air. */
export function programMode(studio: Studio): Mode {
  return sceneMode(onAirScene(studio), studio);
}
