import { scene, studio } from "../test/fixtures";
import { withFallbacks } from "./ProgramPage";

const REPLAY = { match_id: "m-1", moment_id: "m-1-k1", minute: 23, started_at: 1000, duration_s: 20 };

test("a replay on air gets a box when the scene has none", () => {
  const shown = withFallbacks(scene({ elements: [] }), studio({ replay: REPLAY }));
  expect(shown.elements.map((element) => element.type)).toEqual(["replay"]);
});

test("with nothing extra on air the scene is unchanged", () => {
  const plain = scene({ elements: [] });
  expect(withFallbacks(plain, studio())).toBe(plain);
});
