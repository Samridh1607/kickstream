import { element, scene, studio } from "../test/fixtures";
import { createPitchScene, pitchProps } from "./pitchScene";

test("the view is kept to two decimal places, with the camera and whether to follow the ball", () => {
  expect(pitchProps("broadcast", { zoom: 2.3456, turn: -12.346, tilt: 4, panX: 10.006, panY: -3.3333 }, true)).toEqual({
    camera: "broadcast", zoom: 2.35, turn: -12.35, tilt: 4, pan_x: 10.01, pan_y: -3.33, follow_ball: true,
  });
});

test("a 3D pitch scene starts from the pipeline's template and holds the asked view", async () => {
  const template = scene({ id: "s3", name: "3D pitch", template: "3D pitch", elements: [
    element({ id: "e1", type: "pitch3d", props: { camera: "auto" } }), element({ id: "e2", type: "scoreboard", props: {} }),
  ] });
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify(studio({ scenes: [...studio().scenes, template] })), { status: 200 });
  }));
  const view = pitchProps("tactical", { zoom: 3, turn: 10, tilt: 0, panX: 0, panY: 0 });
  await createPitchScene(view);
  expect(bodies[0]).toMatchObject({ source: "builtin", ref: "3D pitch" });
  const saved = bodies[1] as { elements: { type: string; props: Record<string, unknown> }[] };
  expect(saved.elements.map((item) => [item.type, item.props])).toEqual([["pitch3d", view], ["scoreboard", {}]]);
});

test("a 3D pitch scene that cannot be laid out is taken away again", async () => {
  const calls: string[] = [];
  const created = studio({ scenes: [...studio().scenes, scene({ id: "s3", name: "3D pitch", template: "3D pitch", elements: [] })] });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "POST") return new Response(JSON.stringify(created), { status: 200 });
    if (init?.method === "PUT") return new Response(JSON.stringify({ detail: [{ loc: ["body", "elements"], msg: "No room.", type: "value_error" }] }), { status: 422 });
    return new Response(JSON.stringify(studio()), { status: 200 });
  }));
  await expect(createPitchScene()).rejects.toThrow("No room.");
  expect(calls).toEqual(["POST /api/studio/scenes", "PUT /api/studio/scenes/s3", "DELETE /api/studio/scenes/s3"]);
});
