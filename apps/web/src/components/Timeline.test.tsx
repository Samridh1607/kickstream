import { fireEvent, screen } from "@testing-library/react";
import { moment, recap } from "../test/fixtures";
import { renderUi } from "../test/render";
import { Timeline } from "./Timeline";

const moments = [
  { ...moment({ id: "k1", minute: 12, kind: "big_chance" }), highlighted: false },
  { ...moment({ id: "k2", minute: 23, kind: "goal" }), highlighted: true },
];

function setup(selectedId: string | null = null) {
  const handlers = { onSelect: vi.fn(), onOpenRecap: vi.fn() };
  renderUi(<Timeline moments={moments} recaps={[recap()]} selectedId={selectedId} language="en" {...handlers} />);
  return handlers;
}

test("each key moment is a labelled button placed by its minute", () => {
  setup();
  const goal = screen.getByRole("button", { name: "23' Goal" });
  expect(goal.style.left).toBe(`${(23 / 90) * 100}%`);
  expect(goal.getAttribute("data-highlighted")).toBe("true");
  expect(screen.getByRole("button", { name: "12' Big chance" })).toBeTruthy();
});

test("selecting a moment reports its id and marks it pressed", () => {
  const handlers = setup("k2");
  fireEvent.click(screen.getByRole("button", { name: "12' Big chance" }));
  expect(handlers.onSelect).toHaveBeenCalledWith("k1");
  expect(screen.getByRole("button", { name: "23' Goal" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "12' Big chance" }).getAttribute("aria-pressed")).toBe("false");
});

test("a recap marker reopens that recap", () => {
  const handlers = setup();
  fireEvent.click(screen.getByRole("button", { name: "Half-time recap" }));
  expect(handlers.onOpenRecap).toHaveBeenCalledWith(recap());
});
