import { fireEvent, screen, waitFor } from "@testing-library/react";
import { overlay } from "../test/fixtures";
import { renderUi } from "../test/render";
import { OverlayTab } from "./OverlayTab";

const statCard = overlay({
  id: "m-1-o2", kind: "stat_card", sources: ["m-1-s5"],
  data: { stat_rows: [{ label: "Shots", home: 7, away: 2 }, { label: "Expected goals", home: 1.24, away: 0.3 }] },
});
const heat = overlay({
  id: "m-1-o3", kind: "pressure_map", language: null, sources: ["m-1-p5"],
  data: { cols: 6, rows: 4, home: Array(24).fill(1), away: Array(24).fill(0) },
});
const recapCard = overlay({
  id: "m-1-o4", kind: "recap_card", sources: ["m-1-r-half_time-fan-en"],
  data: { title: "Half-time: Northbridge FC 1-0 Harbour City", score: "1-0", bullets: ["a", "b", "c"] },
});

test("with no overlays it explains what will appear", () => {
  renderUi(<OverlayTab overlays={[]} language="en" />);
  expect(screen.getByText("Overlays appear here once the match starts.")).toBeTruthy();
});

test("draws the newest overlay from its JSON and shows that JSON beside it", () => {
  renderUi(<OverlayTab overlays={[overlay({ id: "m-1-o0" }), statCard, overlay()]} language="en" />);
  const graphic = screen.getByTestId("overlay-graphic");
  expect(graphic.textContent).toContain("GOAL");
  expect(graphic.textContent).toContain("GOAL! Luca Marrowby scores.");
  expect(graphic.textContent).toContain("Northbridge FC");
  expect(JSON.parse(screen.getByTestId("overlay-json").textContent ?? "")).toEqual(overlay());
});

test("each kind has a tab and its own graphic", () => {
  renderUi(<OverlayTab overlays={[overlay(), statCard, heat, recapCard]} language="en" />);
  fireEvent.click(screen.getByRole("tab", { name: "Stat card" }));
  expect(screen.getByTestId("overlay-graphic").textContent).toContain("Expected goals");
  expect(screen.getByTestId("overlay-graphic").textContent).toContain("1.24");
  fireEvent.click(screen.getByRole("tab", { name: "Pressure map" }));
  expect(screen.getAllByTestId("pressure-cell")).toHaveLength(24);
  fireEvent.click(screen.getByRole("tab", { name: "Recap card" }));
  expect(screen.getByTestId("overlay-graphic").textContent).toContain("Half-time: Northbridge FC 1-0 Harbour City");
});

test("only kinds that have an overlay get a tab", () => {
  renderUi(<OverlayTab overlays={[statCard]} language="en" />);
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Stat card"]);
  expect(screen.getByTestId("overlay-graphic").textContent).toContain("Shots");
});

test("copy puts the overlay JSON on the clipboard", async () => {
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  renderUi(<OverlayTab overlays={[overlay()]} language="en" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
  expect(JSON.parse(writeText.mock.calls[0][0])).toEqual(overlay());
});
