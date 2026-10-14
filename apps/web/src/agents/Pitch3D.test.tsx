import { fireEvent, render, screen } from "@testing-library/react";
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

test("an empty scene shows the stadium and says when the pitch will appear", () => {
  show({ scene: null });
  expect(screen.getByText("The 3D pitch appears once the match is under way.")).toBeTruthy();
  expect(screen.getByTestId("pitch3d").getAttribute("data-camera")).toBe("broadcast");
  expect(screen.queryByTestId("pitch-player")).toBeNull();
  expect(screen.queryByTestId("pitch-ball")).toBeNull();
  expect(screen.getAllByTestId("pitch-goal")).toHaveLength(2);
});

function scaleOf(transform: string): number {
  const match = /scale\(([\d.]+)\)/.exec(transform);
  if (!match) throw new Error(`no scale in ${transform}`);
  return Number(match[1]);
}
