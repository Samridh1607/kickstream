import { screen } from "@testing-library/react";
import type { ViewerProfile } from "../contracts";
import { moment, narrative, overlay } from "../test/fixtures";
import { renderUi } from "../test/render";
import { PipelinePanel } from "./PipelinePanel";

const profile: ViewerProfile = { mode: "fan", language: "en", club: "nbr", player: null };

test("with nothing selected it asks the viewer to select a narrative", () => {
  renderUi(<PipelinePanel narrative={undefined} moment={undefined} overlay={undefined} profile={profile} />);
  expect(screen.getByText("Select a narrative to see which stage and agent produced it.")).toBeTruthy();
});

test("traces a narrative through all five stages", () => {
  renderUi(
    <PipelinePanel
      narrative={{ ...narrative({ source: "agent", agent: "commentator" }), highlighted: true }}
      moment={{ ...moment(), highlighted: true }}
      overlay={overlay()}
      profile={profile}
    />,
  );
  const steps = screen.getAllByTestId("pipeline-step").map((step) => step.textContent);
  expect(steps).toHaveLength(5);
  expect(steps[0]).toContain("Ingest");
  expect(steps[0]).toContain("m-1-e40");
  expect(steps[1]).toContain("Interpret");
  expect(steps[1]).toContain("Goal");
  expect(steps[1]).toContain("xg 0.42");
  expect(steps[2]).toContain("Explain");
  expect(steps[2]).toContain("commentator");
  expect(steps[2]).toContain("agent");
  expect(steps[3]).toContain("Render");
  expect(steps[3]).toContain("m-1-o1");
  expect(steps[4]).toContain("Personalize");
  expect(steps[4]).toContain("fan");
  expect(steps[4]).toContain("Highlighted for you");
  expect(screen.getAllByTestId("evidence").map((item) => item.textContent)).toEqual(["m-1-k1", "m-1-e40", "m-1-s23"]);
});

test("missing links are shown as a dash, not hidden", () => {
  renderUi(
    <PipelinePanel narrative={{ ...narrative(), highlighted: false }} moment={undefined} overlay={undefined}
      profile={{ ...profile, mode: "analyst" }} />,
  );
  const steps = screen.getAllByTestId("pipeline-step").map((step) => step.textContent);
  expect(steps[0]).toContain("–");
  expect(steps[3]).toContain("–");
  expect(steps[4]).not.toContain("Highlighted for you");
});
