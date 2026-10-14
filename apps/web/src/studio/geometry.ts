import type { SceneElement } from "../contracts";

export const CANVAS = { width: 1920, height: 1080 };
export const GRID = 20;
export const MIN_SIZE = 40;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export const snap = (value: number): number => Math.round(value / GRID) * GRID + 0;

export const rectOf = (element: SceneElement): Rect => ({
  x: element.x, y: element.y, width: element.width, height: element.height,
});

export const sameRect = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Sizes first, then position, so an oversized rectangle ends up filling the canvas. */
export function clampRect(rect: Rect): Rect {
  const width = clamp(rect.width, MIN_SIZE, CANVAS.width);
  const height = clamp(rect.height, MIN_SIZE, CANVAS.height);
  return { x: clamp(rect.x, 0, CANVAS.width - width), y: clamp(rect.y, 0, CANVAS.height - height), width, height };
}

const SNAP_THRESHOLD = 8;

/** The smallest shift that puts one of `edges` on one of `guides`, or 0 when none is within reach. */
function nearestShift(edges: number[], guides: number[], threshold: number): number {
  let best: number | null = null;
  for (const edge of edges) {
    for (const guide of guides) {
      const shift = guide - edge;
      if (Math.abs(shift) <= threshold && (best === null || Math.abs(shift) < Math.abs(best))) best = shift;
    }
  }
  return best ?? 0;
}

/** Pulls a rectangle onto nearby canvas edges, centre lines or other elements' edges. Its size is unchanged. */
export function snapToGuides(rect: Rect, others: Rect[], threshold = SNAP_THRESHOLD): Rect {
  const xGuides = [0, CANVAS.width / 2, CANVAS.width];
  const yGuides = [0, CANVAS.height / 2, CANVAS.height];
  for (const other of others) {
    xGuides.push(other.x, other.x + other.width / 2, other.x + other.width);
    yGuides.push(other.y, other.y + other.height / 2, other.y + other.height);
  }
  const dx = nearestShift([rect.x, rect.x + rect.width / 2, rect.x + rect.width], xGuides, threshold);
  const dy = nearestShift([rect.y, rect.y + rect.height / 2, rect.y + rect.height], yGuides, threshold);
  return clampRect({ ...rect, x: Math.round(rect.x + dx), y: Math.round(rect.y + dy) });
}

export function moveBy(rect: Rect, dx: number, dy: number): Rect {
  return clampRect({ ...rect, x: rect.x + snap(dx), y: rect.y + snap(dy) });
}

/** Resizes from the bottom-right corner; the top-left corner stays where it is. */
export function resizeBy(rect: Rect, dw: number, dh: number): Rect {
  return {
    ...rect,
    width: clamp(rect.width + snap(dw), MIN_SIZE, CANVAS.width - rect.x),
    height: clamp(rect.height + snap(dh), MIN_SIZE, CANVAS.height - rect.y),
  };
}

export function fitScale(width: number, height: number): number {
  return Math.max(0, Math.min(width / CANVAS.width, height / CANVAS.height));
}

function swapWithNeighbour(elements: SceneElement[], id: string, direction: 1 | -1): SceneElement[] {
  const ordered = [...elements].sort((a, b) => a.layer - b.layer);
  const index = ordered.findIndex((element) => element.id === id);
  const neighbour = ordered[index + direction];
  if (index === -1 || neighbour === undefined) return elements;
  const mine = ordered[index].layer;
  return elements.map((element) =>
    element.id === id ? { ...element, layer: neighbour.layer } : element.id === neighbour.id ? { ...element, layer: mine } : element,
  );
}

export const raise = (elements: SceneElement[], id: string) => swapWithNeighbour(elements, id, 1);
export const lower = (elements: SceneElement[], id: string) => swapWithNeighbour(elements, id, -1);
export const nextLayer = (elements: SceneElement[]) => Math.max(0, ...elements.map((element) => element.layer)) + 1;
