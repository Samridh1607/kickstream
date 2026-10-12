import { screen } from "@testing-library/react";
import { matchEvent, pressure, status } from "../test/fixtures";
import { renderUi } from "../test/render";
import { heatCells, Pitch } from "./Pitch";

const grid = (values: Record<number, number>) => Array.from({ length: 24 }, (_, index) => values[index] ?? 0);

test("heatCells shows the net pressure of the stronger side per zone", () => {
  const cells = heatCells(pressure({ home: grid({ 5: 8, 7: 2 }), away: grid({ 0: 4, 7: 2 }) }));
  expect(cells.map((cell) => [cell.index, cell.side])).toEqual([[0, "away"], [5, "home"]]);
  const [away, home] = cells;
  expect(home.opacity).toBeGreaterThan(away.opacity);
  expect(home.opacity).toBeLessThanOrEqual(0.6);
  expect(home.x).toBeCloseTo((5 * 100) / 6);
  expect(home.y).toBe(0);
});

test("draws a marker for each recent team event, capped at twelve", () => {
  const events = Array.from({ length: 20 }, (_, index) => matchEvent({ id: `e${index}`, seq: index }));
  events.push(matchEvent({ id: "ht", type: "half_time", team: null }));
  renderUi(<Pitch events={events} pressure={null} status={status()} showPressure language="en" />);
  expect(screen.getAllByTestId("marker")).toHaveLength(12);
  expect(screen.getByRole("img", { name: "Pitch" })).toBeTruthy();
});

test("the pressure layer can be switched off", () => {
  const heat = pressure({ home: grid({ 5: 8 }) });
  const { rerender } = renderUi(<Pitch events={[]} pressure={heat} status={status()} showPressure language="en" />);
  expect(screen.getAllByTestId("heat")).toHaveLength(1);
  rerender(<Pitch events={[]} pressure={heat} status={status()} showPressure={false} language="en" />);
  expect(screen.queryAllByTestId("heat")).toHaveLength(0);
});
