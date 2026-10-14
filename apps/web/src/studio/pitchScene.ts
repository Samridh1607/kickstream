import type { Camera, View } from "../agents/Pitch3D";
import type { Scene, SceneElement, Studio } from "../contracts";
import { createScene, deleteScene, saveScene } from "./api";
import { WIDGET_BY_TYPE, widgetElement } from "./edit/ElementLibrary";

export const PITCH_TEMPLATE = "3D pitch";
const MAX_ELEMENTS = 40;
const PITCH = WIDGET_BY_TYPE.get("pitch3d")!;

/** A 3D pitch element's settings: the camera, and the view held on it. */
export function pitchProps(camera: Camera | "auto", view: View, followBall = false): Record<string, unknown> {
  const two = (value: number) => Math.round(value * 100) / 100;
  return { camera, zoom: two(view.zoom), turn: two(view.turn), tilt: two(view.tilt), pan_x: two(view.panX), pan_y: two(view.panY), follow_ball: followBall };
}

export const hasRoom = (scene: Scene) => scene.elements.length < MAX_ELEMENTS;

/** A 3D pitch added to the scene, in the middle, as the element library adds one. */
export function withPitch(scene: Scene, props: Record<string, unknown>): SceneElement[] {
  return [...scene.elements, widgetElement(PITCH, scene.elements, 0, props)];
}

export const addPitch = (scene: Scene, props: Record<string, unknown>) => saveScene({ id: scene.id, name: scene.name, elements: withPitch(scene, props) });

/** The template's elements with its pitch holding the given view. */
export function pitchLayout(scene: Scene, props: Record<string, unknown>): SceneElement[] {
  return scene.elements.map((element) => (element.type === "pitch3d" ? { ...element, props } : element));
}

/** Makes a new scene from the 3D pitch template holding the given view; if that cannot be saved, the half-made scene is taken away again. */
export async function createPitchScene(props: Record<string, unknown> = PITCH.props, name = PITCH_TEMPLATE): Promise<Studio> {
  const created = await createScene("builtin", PITCH_TEMPLATE, name);
  const scene = created.scenes[created.scenes.length - 1];
  try {
    return await saveScene({ id: scene.id, name: scene.name, elements: pitchLayout(scene, props) });
  } catch (caught) {
    await deleteScene(scene.id).catch(() => undefined);
    throw caught;
  }
}
