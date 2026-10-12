import { fireEvent, screen } from "@testing-library/react";
import { narrative } from "../test/fixtures";
import { renderUi } from "../test/render";
import { NarrativeFeed } from "./NarrativeFeed";

const feed = [
  { ...narrative({ id: "n2", moment_id: "k2", minute: 40, text: "So close!", source: "agent", agent: "commentator" }), highlighted: false },
  { ...narrative({ id: "n1", moment_id: "k1", minute: 23 }), highlighted: true },
];

test("with no narratives it explains what will appear", () => {
  renderUi(<NarrativeFeed narratives={[]} selectedId={null} language="en" onSelect={vi.fn()} />);
  expect(screen.getByText("Narratives appear here as key moments happen.")).toBeTruthy();
});

test("lists narratives in the order given with their minute", () => {
  renderUi(<NarrativeFeed narratives={feed} selectedId={null} language="en" onSelect={vi.fn()} />);
  const items = screen.getAllByRole("listitem");
  expect(items.map((item) => item.textContent)).toEqual([
    expect.stringContaining("So close!"), expect.stringContaining("GOAL!"),
  ]);
  expect(items[0].textContent).toContain("40'");
});

test("badges mark scripted and highlighted narratives only", () => {
  renderUi(<NarrativeFeed narratives={feed} selectedId={null} language="en" onSelect={vi.fn()} />);
  const [agentWritten, scripted] = screen.getAllByRole("listitem");
  expect(scripted.textContent).toContain("Scripted");
  expect(scripted.textContent).toContain("Highlighted for you");
  expect(agentWritten.textContent).not.toContain("Scripted");
  expect(agentWritten.textContent).not.toContain("Highlighted for you");
});

test("clicking a narrative selects its key moment", () => {
  const onSelect = vi.fn();
  renderUi(<NarrativeFeed narratives={feed} selectedId="k1" language="en" onSelect={onSelect} />);
  fireEvent.click(screen.getByRole("button", { name: /So close!/ }));
  expect(onSelect).toHaveBeenCalledWith("k2");
  expect(screen.getByRole("button", { name: /GOAL!/ }).getAttribute("aria-pressed")).toBe("true");
});
