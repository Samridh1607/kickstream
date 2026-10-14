import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Scene, SceneElement, Studio } from "../contracts";
import { EMPTY } from "../stream/store";
import { pitchScene, scene, status, studio } from "../test/fixtures";
import { renderUi } from "../test/render";
import { PitchCard } from "./cards";

interface Call {
  url: string;
  method: string;
  body: { name?: string; elements?: SceneElement[]; source?: string; ref?: string } | undefined;
}

function serve({ refuse = false, scenes }: { refuse?: boolean; scenes?: Studio["scenes"] } = {}) {
  let current: Studio = studio(scenes ? { scenes } : {});
  const calls: Call[] = [];
  const reply = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url === "/api/studio" && method === "GET") return reply(200, current);
    if (url === "/api/studio/scenes" && method === "POST") {
      const elements = body.ref === "3D pitch"
        ? [
          { id: "e1", type: "pitch3d", x: 0, y: 0, width: 1920, height: 1080, layer: 1, visible: true, props: { camera: "auto" } },
          { id: "e2", type: "scoreboard", x: 410, y: 32, width: 1100, height: 120, layer: 2, visible: true, props: {} },
        ] as SceneElement[]
        : [];
      current = { ...current, scenes: [...current.scenes, scene({ id: "s3", name: body.name, template: body.ref, elements })] };
      return reply(200, current);
    }
    if (url.startsWith("/api/studio/scenes/") && method === "PUT") {
      if (refuse) return reply(422, { detail: [{ loc: ["body", "elements"], msg: "A scene holds at most 40 elements.", type: "value_error" }] });
      const id = url.split("/").pop();
      const scenes = current.scenes.map((item: Scene) => (item.id === id ? { ...item, name: body.name, elements: body.elements } : item));
      current = { ...current, scenes: scenes as Studio["scenes"] };
      return reply(200, current);
    }
    return reply(404, {});
  }));
  return calls;
}

const WAIT = { timeout: 10_000 };

function card() {
  renderUi(<PitchCard match={{ ...EMPTY, minute: 12, status: status({ minute: 12 }), pitch: pitchScene() }} language="en" followId={null} />);
  return within(screen.getByTestId("card-pitch"));
}

const open = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Add to scene" }));
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "Add to Break" })).toBeTruthy(), WAIT);
};

test("Add to scene puts the 3D pitch in the middle of a scene, with the camera and the view as the viewer has them", async () => {
  const calls = serve();
  const pitch = card();
  fireEvent.change(pitch.getByRole("combobox", { name: "Camera" }), { target: { value: "tactical" } });
  fireEvent.change(pitch.getByRole("slider", { name: "Zoom" }), { target: { value: "250" } });
  fireEvent.click(pitch.getByRole("button", { name: "Rotate right" }));

  await open();
  expect(screen.getByRole("menuitem", { name: "Add to Live match" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "New scene with 3D pitch" })).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "Add to Break" }));

  await waitFor(() => expect(pitch.getByText("Added to Break")).toBeTruthy(), WAIT);
  const saved = calls.find((call) => call.method === "PUT");
  expect(saved?.url).toBe("/api/studio/scenes/s2");
  expect(saved?.body?.name).toBe("Break");
  expect(saved?.body?.elements?.map((element) => element.type)).toEqual(["countdown", "pitch3d"]);
  const added = saved!.body!.elements![1];
  expect([added.width, added.height]).toEqual([900, 560]);
  expect(Math.abs(added.x + added.width / 2 - 960)).toBeLessThanOrEqual(10);
  expect(Math.abs(added.y + added.height / 2 - 540)).toBeLessThanOrEqual(10);
  expect(added.props).toEqual({ camera: "tactical", zoom: 2.5, turn: 15, tilt: 0, pan_x: 0, pan_y: 0, follow_ball: false });
  expect(pitch.getByRole("link", { name: "Open studio" }).getAttribute("href")).toBe("/studio");

  fireEvent.click(pitch.getByRole("button", { name: "Dismiss" }));
  expect(pitch.queryByText("Added to Break")).toBeNull();
});

test("New scene with 3D pitch makes a scene with the pitch filling the frame and the scoreboard over it", async () => {
  const calls = serve();
  const pitch = card();
  await open();
  fireEvent.click(screen.getByRole("menuitem", { name: "New scene with 3D pitch" }));

  await waitFor(() => expect(pitch.getByText("Added to 3D pitch")).toBeTruthy(), WAIT);
  expect(calls.filter((call) => call.method !== "GET").map((call) => [call.method, call.url])).toEqual([
    ["POST", "/api/studio/scenes"], ["PUT", "/api/studio/scenes/s3"],
  ]);
  expect(calls.find((call) => call.method === "POST")?.body).toEqual({ source: "builtin", ref: "3D pitch", name: "3D pitch" });
  const [stage, score] = calls.find((call) => call.method === "PUT")!.body!.elements!;
  expect(stage).toMatchObject({ type: "pitch3d", x: 0, y: 0, width: 1920, height: 1080, layer: 1, props: { camera: "auto", zoom: 1 } });
  expect(score).toMatchObject({ type: "scoreboard", layer: 2 });
});

test("a scene that is full cannot take the pitch, and a refusal is reported", async () => {
  const full = scene({ id: "s9", name: "Crowded", elements: Array.from({ length: 40 }, (_, index) => ({ ...scene().elements[0], id: `e${index}` })) });
  serve({ refuse: true, scenes: [...studio().scenes, full] });
  const pitch = card();
  await open();
  expect(screen.getByRole("menuitem", { name: "Add to Crowded" }).getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(screen.getByRole("menuitem", { name: "Add to Break" }));
  await waitFor(() => expect(pitch.getByText("A scene holds at most 40 elements.")).toBeTruthy(), WAIT);
  expect(pitch.queryByRole("link", { name: "Open studio" })).toBeNull();
});
