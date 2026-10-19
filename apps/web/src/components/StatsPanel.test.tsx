import { screen, within } from "@testing-library/react";
import { stats, status } from "../test/fixtures";
import { renderUi } from "../test/render";
import { StatsPanel } from "./StatsPanel";

test("compares home and away for each stat", () => {
  const snapshot = stats(
    { shots: 7, possession: 61.5, xg: 1.24, pass_distance: 18.4, pass_difficulty: 2.5 },
    { shots: 2, possession: 38.5, xg: 0.3, pass_distance: 12, pass_difficulty: 1.5 },
    0.4,
  );
  renderUi(<StatsPanel stats={snapshot} status={status()} language="en" />);
  const shots = screen.getByTestId("stat-shots");
  expect(within(shots).getByText("Shots")).toBeTruthy();
  expect(within(shots).getByText("7")).toBeTruthy();
  expect(within(shots).getByText("2")).toBeTruthy();
  expect(within(screen.getByTestId("stat-possession")).getByText("61.5")).toBeTruthy();
  const distance = screen.getByTestId("stat-pass-distance");
  expect(within(distance).getByText("Pass distance m")).toBeTruthy();
  expect(within(distance).getByText("18.4")).toBeTruthy();
  expect(within(distance).getByText("12")).toBeTruthy();
  expect(within(screen.getByTestId("stat-pass-difficulty")).getByText("2.5")).toBeTruthy();
  expect(screen.getByRole("meter", { name: "Momentum" }).getAttribute("aria-valuenow")).toBe("0.4");
});

test("before the first snapshot it shows placeholders", () => {
  renderUi(<StatsPanel stats={null} status={null} language="es" />);
  expect(screen.getByText("Estadísticas")).toBeTruthy();
  expect(within(screen.getByTestId("stat-shots")).getAllByText("–")).toHaveLength(2);
});
