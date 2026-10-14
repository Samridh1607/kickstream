import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { pitchScene } from "../test/fixtures";
import { Pitch3D } from "./Pitch3D";

type Props = ComponentProps<typeof Pitch3D>;

function show(over: Partial<Props> = {}) {
  const props: Props = { scene: pitchScene(), label: "3D pitch", emptyText: "The 3D pitch appears once the match is under way.", ...over };
  const view = render(<Pitch3D {...props} />);
  return { ...view, again: (next: Partial<Props>) => view.rerender(<Pitch3D {...props} {...next} />) };
}

const stage = () => screen.getByTestId("pitch-stage").style.transform;
const camera = () => screen.getByTestId("pitch-camera").style.transform;
const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

test("draws the players, the ball, the lanes, the danger columns, both goals and the ball's flight", () => {
  show({ followId: "nbr-9" });
  expect(screen.getByTestId("pitch3d").getAttribute("data-camera")).toBe("attack_home");
  expect(screen.getAllByTestId("pitch-player").map((player) => [player.getAttribute("data-player"), player.getAttribute("data-estimated")])).toEqual([
    ["nbr-9", "false"], ["hbc-1", "true"],
  ]);
  expect(screen.getAllByTestId("pitch-player")[0].getAttribute("data-followed")).toBe("true");
  expect(screen.getAllByTestId("pitch-player")[0].textContent).toBe("9");
  expect(screen.getAllByTestId("pitch-ball")).toHaveLength(1);
  expect(screen.getAllByTestId("pass-lane")).toHaveLength(1);
  expect(screen.getAllByTestId("danger-column").map((column) => column.getAttribute("data-team"))).toEqual(["home"]);
  expect(screen.getAllByTestId("pitch-goal").map((goal) => goal.getAttribute("data-end"))).toEqual(["left", "right"]);
  expect(screen.getAllByTestId("corner-flag")).toHaveLength(4);
  expect(screen.getByTestId("ball-trail").getAttribute("data-points")).toBe("3");
  expect(screen.getByTestId("trail-arc").getAttribute("d")).toMatch(/^M0 \S+( C\S+ \S+ \S+ \S+ \S+ \S+){2}$/);
  expect(screen.getByTestId("trail-shadow")).toBeTruthy();
});

test("a ball played along the ground leaves no arc in the air", () => {
  show({ scene: pitchScene({ trail: [{ x: 50, y: 50, z: 0 }, { x: 70, y: 40, z: 0 }] }) });
  expect(screen.queryByTestId("ball-trail")).toBeNull();
  expect(screen.getByTestId("trail-shadow")).toBeTruthy();
});

test("holds the camera it is given over the scene's own", () => {
  show({ camera: "tactical" });
  expect(screen.getByTestId("pitch3d").getAttribute("data-camera")).toBe("tactical");
  expect(stage()).toBe("rotateX(14deg) rotateZ(0deg)");
});

test("shows no controls unless asked, and is then a picture", () => {
  show();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByRole("img", { name: "3D pitch" })).toBeTruthy();
  expect(screen.getByTestId("pitch3d").getAttribute("tabindex")).toBeNull();
});

test("with controls, the buttons turn, tilt and zoom the camera, and Reset puts it back", () => {
  show({ camera: "broadcast", controls: true });
  expect(screen.getByRole("group", { name: "3D pitch" })).toBeTruthy();
  const [startStage, startCamera] = [stage(), camera()];
  expect(startStage).toBe("rotateX(56deg) rotateZ(0deg)");
  expect((screen.getByRole("button", { name: "Reset view" }) as HTMLButtonElement).disabled).toBe(true);

  press("Rotate right");
  expect(stage()).toBe("rotateX(56deg) rotateZ(15deg)");
  press("Rotate left");
  press("Rotate left");
  expect(stage()).toBe("rotateX(56deg) rotateZ(-15deg)");
  press("Tilt up");
  expect(stage()).toBe("rotateX(48deg) rotateZ(-15deg)");
  press("Tilt down");
  press("Tilt down");
  expect(stage()).toBe("rotateX(64deg) rotateZ(-15deg)");

  const turned = camera();
  press("Zoom in");
  expect(camera()).not.toBe(turned);
  expect(scaleOf(camera())).toBeGreaterThan(scaleOf(turned));
  press("Zoom out");
  press("Zoom out");
  expect(scaleOf(camera())).toBeLessThan(scaleOf(turned));

  press("Reset view");
  expect(stage()).toBe(startStage);
  expect(camera()).toBe(startCamera);
  expect((screen.getByRole("button", { name: "Reset view" }) as HTMLButtonElement).disabled).toBe(true);
});

test("the camera stops at its limits", () => {
  show({ camera: "broadcast", controls: true });
  for (let i = 0; i < 12; i++) press("Zoom in");
  expect((screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement).disabled).toBe(true);
  for (let i = 0; i < 6; i++) press("Tilt down");
  expect(stage()).toBe("rotateX(76deg) rotateZ(0deg)");
  expect((screen.getByRole("button", { name: "Tilt down" }) as HTMLButtonElement).disabled).toBe(true);
  for (let i = 0; i < 8; i++) press("Rotate right");
  expect(stage()).toBe("rotateX(76deg) rotateZ(75deg)");
});

test("the keyboard turns, tilts and zooms the focused pitch", () => {
  show({ camera: "broadcast", controls: true });
  const pitch = screen.getByTestId("pitch3d");
  expect(pitch.getAttribute("tabindex")).toBe("0");
  const start = camera();
  fireEvent.keyDown(pitch, { key: "ArrowRight" });
  fireEvent.keyDown(pitch, { key: "ArrowUp" });
  expect(stage()).toBe("rotateX(48deg) rotateZ(15deg)");
  fireEvent.keyDown(pitch, { key: "+" });
  expect(scaleOf(camera())).toBeGreaterThan(scaleOf(start));
  fireEvent.keyDown(pitch, { key: "0" });
  expect(stage()).toBe("rotateX(56deg) rotateZ(0deg)");
});

test("dragging turns and tilts the camera", () => {
  show({ camera: "broadcast", controls: true });
  const view = screen.getByTestId("pitch-view");
  fireEvent.pointerDown(view, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(view, { clientX: 60, clientY: 132, pointerId: 1 });
  fireEvent.pointerUp(view, { pointerId: 1 });
  expect(stage()).toBe("rotateX(48deg) rotateZ(14deg)");
  fireEvent.pointerMove(view, { clientX: 0, clientY: 0, pointerId: 1 });
  expect(stage()).toBe("rotateX(48deg) rotateZ(14deg)");
});

test("choosing another camera undoes the viewer's own turn", () => {
  const { again } = show({ camera: "broadcast", controls: true });
  press("Rotate right");
  press("Zoom in");
  expect(stage()).toBe("rotateX(56deg) rotateZ(15deg)");
  again({ camera: "attack_away" });
  expect(stage()).toBe("rotateX(60deg) rotateZ(28deg)");
  expect((screen.getByRole("button", { name: "Reset view" }) as HTMLButtonElement).disabled).toBe(true);
  again({ camera: "broadcast" });
  expect(stage()).toBe("rotateX(56deg) rotateZ(0deg)");
});

test("the zoom slider runs from half size to four times, shows how far in it is, and Fit goes back", () => {
  show({ camera: "broadcast", controls: true });
  const pitch = screen.getByTestId("pitch3d");
  const slider = screen.getByRole("slider", { name: "Zoom" }) as HTMLInputElement;
  const readout = () => screen.getByTestId("zoom-readout").textContent;
  const fit = () => screen.getByRole("button", { name: "Fit" }) as HTMLButtonElement;
  const start = camera();
  expect([slider.min, slider.max, slider.value]).toEqual(["50", "400", "100"]);
  expect(readout()).toBe("100%");
  expect(fit().disabled).toBe(true);

  fireEvent.change(slider, { target: { value: "300" } });
  expect(readout()).toBe("300%");
  expect(slider.getAttribute("aria-valuetext")).toBe("300%");
  expect(scaleOf(camera())).toBeCloseTo(scaleOf(start) * 3, 2);
  expect(fit().disabled).toBe(false);

  for (let i = 0; i < 10; i++) fireEvent.keyDown(pitch, { key: "+" });
  expect(readout()).toBe("400%");
  expect((screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement).disabled).toBe(true);
  for (let i = 0; i < 12; i++) fireEvent.keyDown(pitch, { key: "-" });
  expect(readout()).toBe("50%");
  expect((screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement).disabled).toBe(true);

  press("Rotate right");
  press("Fit");
  expect(readout()).toBe("100%");
  expect(stage()).toBe("rotateX(56deg) rotateZ(15deg)");
  expect(fit().disabled).toBe(true);
});

test("ctrl and the wheel, or a pinch on a trackpad, zoom in toward the pointer", async () => {
  show({ camera: "broadcast", controls: true });
  fireEvent.wheel(screen.getByTestId("pitch-view"), { deltaY: -40, ctrlKey: true, clientX: 30, clientY: 20 });
  await waitFor(() => expect(screen.getByTestId("zoom-readout").textContent).toBe("149%"));
});

test("zoomed in, shift-drag, a right-drag and shift with the arrows move the view, but never take the stadium off screen", () => {
  show({ camera: "broadcast", controls: true });
  const view = screen.getByTestId("pitch-view");
  const pitch = screen.getByTestId("pitch3d");
  const drag = (button: number, shiftKey: boolean, dx: number, dy: number) => {
    fireEvent.pointerDown(view, { button, shiftKey, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(view, { clientX: dx, clientY: dy, pointerId: 1 });
    fireEvent.pointerUp(view, { pointerId: 1 });
  };
  const start = camera();
  drag(0, true, 200, 120);
  fireEvent.keyDown(pitch, { key: "ArrowLeft", shiftKey: true });
  expect(camera()).toBe(start);
  expect(stage()).toBe("rotateX(56deg) rotateZ(0deg)");

  fireEvent.change(screen.getByRole("slider", { name: "Zoom" }), { target: { value: "300" } });
  const zoomed = camera();
  fireEvent.keyDown(pitch, { key: "ArrowLeft", shiftKey: true });
  expect(shiftOf(camera())[0]).toBeGreaterThan(shiftOf(zoomed)[0]);
  drag(0, true, 0, 60);
  expect(shiftOf(camera())[1]).toBeGreaterThan(shiftOf(zoomed)[1]);
  expect(stage()).toBe("rotateX(56deg) rotateZ(0deg)");

  drag(2, false, 9000, 9000);
  const edge = camera();
  drag(1, false, 9000, 9000);
  expect(camera()).toBe(edge);
  drag(2, false, -18000, -18000);
  shiftOf(camera()).forEach((value, axis) => expect(value).toBeCloseTo(2 * shiftOf(zoomed)[axis] - shiftOf(edge)[axis], 1));

  press("Fit");
  expect(camera()).toBe(start);
});

test("follows a drag at once, and eases into place when it is let go", async () => {
  show({ camera: "broadcast", controls: true });
  const motion = () => [screen.getByTestId("pitch-camera").style.transition, screen.getByTestId("pitch-stage").style.transition];
  await waitFor(() => expect(motion()[1]).toMatch(/^transform 800ms/));
  const view = screen.getByTestId("pitch-view");
  fireEvent.pointerDown(view, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  expect(motion()).toEqual(["transform 0s", "transform 0s"]);
  fireEvent.pointerMove(view, { clientX: 60, clientY: 100, pointerId: 1 });
  expect(motion()).toEqual(["transform 0s", "transform 0s"]);
  fireEvent.pointerUp(view, { pointerId: 1 });
  expect(stage()).toBe("rotateX(56deg) rotateZ(14deg)");
  expect(motion().every((transition) => transition.startsWith("transform 800ms"))).toBe(true);
  expect(screen.getAllByTestId("corner-flag")[0].querySelector<HTMLElement>(".ks-face")?.style.transform).toBe("rotateZ(-14deg) rotateX(-56deg)");
});

test("Full screen fills the screen with the pitch, and Exit full screen or Escape leaves it", () => {
  let shown: Element | null = null;
  const changed = () => document.dispatchEvent(new Event("fullscreenchange"));
  const request = vi.fn(function (this: HTMLElement) {
    shown = this;
    changed();
    return Promise.resolve();
  });
  const exit = vi.fn(() => {
    shown = null;
    changed();
    return Promise.resolve();
  });
  Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: request });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => shown });
  try {
    show({ camera: "broadcast", controls: true });
    const pitch = screen.getByTestId("pitch3d");
    press("Full screen");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.contexts[0]).toBe(pitch);
    expect(pitch.getAttribute("data-fullscreen")).toBe("true");
    press("Exit full screen");
    expect(exit).toHaveBeenCalledTimes(1);
    expect(pitch.getAttribute("data-fullscreen")).toBeNull();

    press("Full screen");
    act(() => {
      shown = null;
      changed();
    });
    expect(screen.getByRole("button", { name: "Full screen" })).toBeTruthy();
    expect(pitch.getAttribute("data-fullscreen")).toBeNull();
  } finally {
    delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
    delete (document as { exitFullscreen?: unknown }).exitFullscreen;
    delete (document as { fullscreenElement?: unknown }).fullscreenElement;
  }
});

test("held still with a saved view and no controls, it shows that view", () => {
  const { again } = show({ camera: "broadcast" });
  const fitted = camera();
  again({ view: { zoom: 2, turn: 30, tilt: -10, panX: 40, panY: 0 } });
  expect(stage()).toBe("rotateX(46deg) rotateZ(30deg)");
  expect(scaleOf(camera())).toBeGreaterThan(scaleOf(fitted));
  expect(screen.queryByRole("button")).toBeNull();
});

test("an empty scene shows the stadium and says when the pitch will appear", () => {
  show({ scene: null });
  expect(screen.getByText("The 3D pitch appears once the match is under way.")).toBeTruthy();
  expect(screen.getByTestId("pitch3d").getAttribute("data-camera")).toBe("broadcast");
  expect(screen.queryByTestId("pitch-player")).toBeNull();
  expect(screen.queryByTestId("pitch-ball")).toBeNull();
  expect(screen.getAllByTestId("pitch-goal")).toHaveLength(2);
});

function shiftOf(transform: string): [number, number] {
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(transform);
  if (!match) throw new Error(`no translate in ${transform}`);
  return [Number(match[1]), Number(match[2])];
}

function scaleOf(transform: string): number {
  const match = /scale\(([\d.]+)\)/.exec(transform);
  if (!match) throw new Error(`no scale in ${transform}`);
  return Number(match[1]);
}
