import { screen, within } from "@testing-library/react";
import { EMPTY } from "../stream/store";
import { studio } from "../test/fixtures";
import { renderUi } from "../test/render";
import type { ProgramData } from "./elements";
import { withFallbacks } from "./ProgramPage";
import { Stage } from "./Stage";

const doc = studio();
const data: ProgramData = { match: EMPTY, studio: doc, now: 1000, language: "en" };
const onAir = doc.scenes[0];

const stage = () => within(screen.getByRole("region", { name: "Stage" }));

test("the stage shows the scene on air and says it is the program", () => {
  renderUi(<Stage scene={onAir} data={data} live={false} />);
  expect(stage().getByTestId("element-scoreboard")).toBeTruthy();
  expect(stage().getByTestId("stage-tag").textContent).toBe("Program");
  expect(stage().queryByText(/LIVE/)).toBeNull();
});

test("while live the stage is outlined and tagged LIVE", () => {
  renderUi(<Stage scene={onAir} data={data} live />);
  expect(stage().getByTestId("stage-tag").textContent).toBe("Program · LIVE");
  expect(stage().getByTestId("element-scoreboard").closest("[data-live]")?.getAttribute("data-live")).toBe("true");
});

test("people on stage appear when the caller passes the scene with its fallbacks", () => {
  const cameras = [{ id: "i1", name: "Sam", acsId: null, present: true }];
  renderUi(<Stage scene={withFallbacks(onAir, doc, cameras)} data={{ ...data, cameras }} live={false} />);
  expect(stage().getByTestId("camera-tile").textContent).toContain("Sam");
});

test("nothing on the stage can be dragged", () => {
  renderUi(<Stage scene={onAir} data={data} live={false} />);
  expect(stage().queryByRole("button", { name: "scoreboard element" })).toBeNull();
});
