import { element, scene, studio } from "../test/fixtures";
import { withCamerasFallback, withFallbacks } from "./ProgramPage";

const REPLAY = { match_id: "m-1", moment_id: "m-1-k1", minute: 23, started_at: 1000, duration_s: 20 };

test("a replay on air gets a box when the scene has none", () => {
  const shown = withFallbacks(scene({ elements: [] }), studio({ replay: REPLAY }));
  expect(shown.elements.map((element) => element.type)).toEqual(["replay"]);
});

test("with nothing extra on air the scene is unchanged", () => {
  const plain = scene({ elements: [] });
  expect(withFallbacks(plain, studio())).toBe(plain);
});

const sam = { id: "i1", name: "Sam", acsId: "8:acs:1", present: true };

test("people on stage get a picture-in-picture box when the scene shows no cameras", () => {
  const shown = withCamerasFallback(scene(), [sam]);
  expect(shown.elements.at(-1)).toMatchObject({ id: "__cameras", type: "cameras", x: 1440, y: 740, width: 440, height: 300, visible: true });
  expect(withCamerasFallback(scene(), [])).toEqual(scene());
  const own = scene({ elements: [element({ id: "c", type: "cameras", props: {} })] });
  expect(withCamerasFallback(own, [sam])).toBe(own);
  const hidden = scene({ elements: [element({ id: "c", type: "cameras", visible: false, props: {} })] });
  expect(withCamerasFallback(hidden, [sam]).elements).toHaveLength(2);
});
