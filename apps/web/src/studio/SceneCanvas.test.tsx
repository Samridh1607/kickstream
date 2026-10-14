import { fireEvent, screen } from "@testing-library/react";
import { EMPTY } from "../stream/store";
import { element, scene, status, studio } from "../test/fixtures";
import { renderUi } from "../test/render";
import type { ProgramData } from "./elements";
import { SceneCanvas } from "./SceneCanvas";

const data: ProgramData = { match: EMPTY, studio: studio(), now: 1000, language: "en" };
const layout = scene({
  elements: [
    element({ id: "a", type: "text", x: 100, y: 100, width: 400, height: 200, layer: 2 }),
    element({ id: "b", type: "countdown", x: 800, y: 100, width: 400, height: 200, layer: 1, props: {} }),
    element({ id: "c", type: "banner", x: 100, y: 600, width: 400, height: 200, layer: 3, visible: false, props: {} }),
  ],
});

function edit(scale = 0.5) {
  const handlers = { onSelect: vi.fn(), onChange: vi.fn() };
  renderUi(<SceneCanvas scene={layout} data={data} scale={scale} editable selectedId="a" {...handlers} />);
  return handlers;
}

const drag = (handle: HTMLElement, dx: number, dy: number) => {
  fireEvent.pointerDown(handle, { clientX: 300, clientY: 300, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 300 + dx / 2, clientY: 300 + dy / 2, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 300 + dx, clientY: 300 + dy, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientX: 300 + dx, clientY: 300 + dy, pointerId: 1 });
};

test("the program draws visible elements at their place, stacked by layer", () => {
  renderUi(<SceneCanvas scene={layout} data={data} scale={0.5} />);
  const text = screen.getByTestId("element-text");
  expect([text.style.left, text.style.top, text.style.width, text.style.height]).toEqual(["100px", "100px", "400px", "200px"]);
  expect([text.style.zIndex, screen.getByTestId("element-countdown").style.zIndex]).toEqual(["2", "1"]);
  expect(screen.queryByTestId("element-banner")).toBeNull();
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  const canvas = screen.getByTestId("scene-canvas");
  expect([canvas.style.width, canvas.style.height]).toEqual(["960px", "540px"]);
});

test("the editor shows hidden elements too, with a handle on each", () => {
  edit();
  expect(screen.getByTestId("element-banner")).toBeTruthy();
  expect(screen.getByRole("button", { name: "text element" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "banner element" }).getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByRole("button", { name: "Resize text element" })).toBeTruthy();
});

test("dragging moves an element by the pointer distance in canvas pixels, snapped to the grid", () => {
  const handlers = edit(0.5);
  drag(screen.getByRole("button", { name: "text element" }), 53, -27);
  expect(handlers.onChange).toHaveBeenCalledOnce();
  const moved = handlers.onChange.mock.calls[0][0];
  expect(moved.find((item: { id: string }) => item.id === "a")).toMatchObject({ x: 200, y: 40, width: 400, height: 200 });
  expect(moved.filter((item: { id: string }) => item.id !== "a")).toEqual(layout.elements.filter((item) => item.id !== "a"));
});

test("the box follows the pointer while the drag is in progress", () => {
  edit(1);
  const handle = screen.getByRole("button", { name: "text element" });
  fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 100, clientY: 60, pointerId: 1 });
  expect(screen.getByTestId("element-text").style.left).toBe("200px");
  expect(screen.getByTestId("element-text").style.top).toBe("160px");
  fireEvent.pointerUp(handle, { clientX: 100, clientY: 60, pointerId: 1 });
});

test("dragging the corner handle resizes", () => {
  const handlers = edit(1);
  drag(screen.getByRole("button", { name: "Resize text element" }), 100, 60);
  expect(handlers.onChange.mock.calls[0][0].find((item: { id: string }) => item.id === "a")).toMatchObject({
    x: 100, y: 100, width: 500, height: 260,
  });
});

test("a drag cannot push an element off the canvas", () => {
  const handlers = edit(1);
  drag(screen.getByRole("button", { name: "text element" }), -9000, 9000);
  expect(handlers.onChange.mock.calls[0][0].find((item: { id: string }) => item.id === "a")).toMatchObject({ x: 0, y: 880 });
});

test("a click that does not move the element selects it without saving", () => {
  const handlers = edit(1);
  drag(screen.getByRole("button", { name: "countdown element" }), 3, 3);
  expect(handlers.onSelect).toHaveBeenCalledWith("b");
  expect(handlers.onChange).not.toHaveBeenCalled();
});

test("arrow keys move by one grid step and Shift with arrows resizes", () => {
  const handlers = edit(1);
  const handle = screen.getByRole("button", { name: "text element" });
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(handlers.onChange.mock.calls[0][0].find((item: { id: string }) => item.id === "a")).toMatchObject({ x: 120, y: 100 });
  fireEvent.keyDown(handle, { key: "ArrowUp", shiftKey: true });
  expect(handlers.onChange.mock.calls[1][0].find((item: { id: string }) => item.id === "a")).toMatchObject({ width: 400, height: 180 });
  fireEvent.keyDown(handle, { key: "Enter" });
  expect(handlers.onChange).toHaveBeenCalledTimes(2);
});

const playing = (over: Parameters<typeof status>[0]): ProgramData => ({ ...data, match: { ...EMPTY, status: status(over) } });

test("the credit is drawn in the corner, above every element, while a sourced match plays", () => {
  renderUi(<SceneCanvas scene={layout} data={playing({ source: "api_football", credit: "Data: API-Football" })} scale={0.5} />);
  const credit = screen.getByTestId("program-credit");
  expect(credit.textContent).toBe("Data: API-Football");
  expect([credit.style.right, credit.style.bottom, credit.style.fontSize]).toEqual(["24px", "16px", "22px"]);
  const layers = ["element-text", "element-countdown"].map((id) => Number(screen.getByTestId(id).style.zIndex));
  expect(Number(credit.style.zIndex)).toBeGreaterThan(Math.max(...layers));
  expect(screen.queryByRole("img")).toBeNull();
});

test("a StatsBomb match is credited with StatsBomb's logo", () => {
  renderUi(<SceneCanvas scene={layout} data={playing({ source: "statsbomb", credit: "Data: StatsBomb" })} scale={0.5} />);
  expect(screen.getByTestId("program-credit").textContent).toBe("Data: StatsBomb");
  expect(screen.getByRole("img", { name: "StatsBomb" }).getAttribute("src")).toBe("/statsbomb-logo.png");
});

test("no credit for the simulated match or before any match", () => {
  const { unmount } = renderUi(<SceneCanvas scene={layout} data={playing({ source: "simulated", credit: null })} scale={0.5} />);
  expect(screen.queryByTestId("program-credit")).toBeNull();
  unmount();
  renderUi(<SceneCanvas scene={layout} data={data} scale={0.5} />);
  expect(screen.queryByTestId("program-credit")).toBeNull();
});

test("in the editor the credit shows but cannot be selected or moved", () => {
  const handlers = { onSelect: vi.fn(), onChange: vi.fn() };
  renderUi(<SceneCanvas scene={layout} data={playing({ source: "statsbomb", credit: "Data: StatsBomb" })} scale={1} editable {...handlers} />);
  const credit = screen.getByTestId("program-credit");
  expect([credit.style.pointerEvents, credit.style.userSelect]).toEqual(["none", "none"]);
  expect(screen.queryByRole("button", { name: /credit/i })).toBeNull();
});

test("clicking the empty canvas clears the selection", () => {
  const handlers = edit(1);
  fireEvent.pointerDown(screen.getByTestId("scene-canvas"), { clientX: 5, clientY: 5, pointerId: 1 });
  expect(handlers.onSelect).toHaveBeenCalledWith(null);
});
