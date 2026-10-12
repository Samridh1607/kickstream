import { element } from "../test/fixtures";
import { clampRect, fitScale, lower, moveBy, nextLayer, raise, rectOf, resizeBy, sameRect, snap } from "./geometry";

const rect = { x: 100, y: 100, width: 400, height: 200 };

test("snap rounds to the 20 pixel grid", () => {
  expect([0, 9, 10, 29, 31, -9].map(snap)).toEqual([0, 0, 20, 20, 40, -0].map((v) => v + 0));
});

test("moving snaps to the grid and stays inside the canvas", () => {
  expect(moveBy(rect, 47, -33)).toEqual({ x: 140, y: 60, width: 400, height: 200 });
  expect(moveBy(rect, -5000, -5000)).toMatchObject({ x: 0, y: 0 });
  expect(moveBy(rect, 5000, 5000)).toMatchObject({ x: 1920 - 400, y: 1080 - 200 });
  expect(moveBy(rect, 4, 4)).toEqual(rect);
});

test("resizing snaps, keeps the corner, and respects the minimum and the canvas edge", () => {
  expect(resizeBy(rect, 47, 33)).toEqual({ x: 100, y: 100, width: 440, height: 240 });
  expect(resizeBy(rect, -5000, -5000)).toEqual({ x: 100, y: 100, width: 40, height: 40 });
  expect(resizeBy(rect, 5000, 5000)).toEqual({ x: 100, y: 100, width: 1820, height: 980 });
});

test("clampRect pulls a stray rectangle back onto the canvas", () => {
  expect(clampRect({ x: -50, y: 2000, width: 10, height: 5000 })).toEqual({ x: 0, y: 0, width: 40, height: 1080 });
});

test("rectOf and sameRect compare position and size only", () => {
  const item = element({ x: 1, y: 2, width: 3, height: 4 });
  expect(rectOf(item)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  expect(sameRect(rectOf(item), { x: 1, y: 2, width: 3, height: 4 })).toBe(true);
  expect(sameRect(rectOf(item), { x: 1, y: 2, width: 3, height: 5 })).toBe(false);
});

test("fitScale fits 16:9 inside any window", () => {
  expect(fitScale(1920, 1080)).toBe(1);
  expect(fitScale(960, 1080)).toBe(0.5);
  expect(fitScale(3840, 1080)).toBe(1);
  expect(fitScale(0, 0)).toBe(0);
});

test("raise and lower swap an element with its neighbour in the stack", () => {
  const stack = [element({ id: "a", layer: 1 }), element({ id: "b", layer: 2 }), element({ id: "c", layer: 5 })];
  const layers = (items: typeof stack) => Object.fromEntries(items.map((item) => [item.id, item.layer]));
  expect(layers(raise(stack, "a"))).toEqual({ a: 2, b: 1, c: 5 });
  expect(layers(lower(stack, "c"))).toEqual({ a: 1, b: 5, c: 2 });
  expect(raise(stack, "c")).toBe(stack);
  expect(lower(stack, "a")).toBe(stack);
  expect(raise(stack, "missing")).toBe(stack);
  expect(nextLayer(stack)).toBe(6);
  expect(nextLayer([])).toBe(1);
});
