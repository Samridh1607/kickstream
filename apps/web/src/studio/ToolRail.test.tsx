import { fireEvent, screen, within } from "@testing-library/react";
import { renderUi } from "../test/render";
import { TOOLS, ToolRail } from "./ToolRail";

const tool = (name: string) => within(screen.getByRole("navigation", { name: "Tools" })).getByRole("button", { name });

test("the rail offers Match first", () => {
  renderUi(<ToolRail tools={TOOLS} open={null} onOpen={() => {}} />);
  const names = within(screen.getByRole("navigation", { name: "Tools" })).getAllByRole("button").map((button) => button.getAttribute("aria-label"));
  expect(names).toEqual(["Match", "Banners", "Comments", "Guests", "Replays", "Timer", "Stream", "Settings"]);
});

test("choosing a closed tool opens it", () => {
  const onOpen = vi.fn();
  renderUi(<ToolRail tools={TOOLS} open={null} onOpen={onOpen} />);
  fireEvent.click(tool("Banners"));
  expect(onOpen).toHaveBeenCalledWith("Banners");
});

test("the open tool's panel shows its content, and choosing the tool again or Close tool closes it", () => {
  const onOpen = vi.fn();
  renderUi(<ToolRail tools={TOOLS} open="Banners" onOpen={onOpen}><p>Banner controls</p></ToolRail>);
  const panel = within(screen.getByRole("region", { name: "Banners tool" }));
  expect(panel.getByRole("heading", { name: "Banners" })).toBeTruthy();
  expect(panel.getByText("Banner controls")).toBeTruthy();
  fireEvent.click(tool("Banners"));
  expect(onOpen).toHaveBeenLastCalledWith(null);
  onOpen.mockClear();
  fireEvent.click(panel.getByRole("button", { name: "Close tool" }));
  expect(onOpen).toHaveBeenCalledWith(null);
});

test("with no tool open only the rail shows", () => {
  renderUi(<ToolRail tools={TOOLS} open={null} onOpen={() => {}}><p>Banner controls</p></ToolRail>);
  expect(screen.queryByRole("region", { name: / tool$/ })).toBeNull();
  expect(screen.queryByText("Banner controls")).toBeNull();
});

test("a tool left out of the list has no button", () => {
  renderUi(<ToolRail tools={TOOLS.filter((name) => name !== "Guests")} open={null} onOpen={() => {}} />);
  expect(within(screen.getByRole("navigation", { name: "Tools" })).queryByRole("button", { name: "Guests" })).toBeNull();
  expect(tool("Comments")).toBeTruthy();
});

test("only the open tool is pressed", () => {
  renderUi(<ToolRail tools={TOOLS} open="Timer" onOpen={() => {}} />);
  expect(tool("Timer").getAttribute("aria-pressed")).toBe("true");
  expect(tool("Banners").getAttribute("aria-pressed")).toBe("false");
});

test("a tool's badge shows its count", () => {
  renderUi(<ToolRail tools={TOOLS} open={null} onOpen={() => {}} badges={{ Comments: 3 }} />);
  expect(within(tool("Comments")).getByText("3")).toBeTruthy();
  expect(within(tool("Banners")).queryByText(/\d/)).toBeNull();
});
