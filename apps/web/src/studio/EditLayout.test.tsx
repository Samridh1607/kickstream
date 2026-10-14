import { act, fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import type { SceneElement, Studio } from "../contracts";
import { EMPTY } from "../stream/store";
import { status, studio } from "../test/fixtures";
import { renderUi } from "../test/render";
import { EditLayout } from "./EditLayout";

const text = (over: Partial<SceneElement> = {}): SceneElement => ({
  id: "title", type: "text", x: 0, y: 0, width: 400, height: 100, layer: 9, visible: true, props: { text: "Old", size: 48, align: "center" }, ...over,
});

/** Renders the layout for one scene of `doc`, keeping its edits and selection as the studio page does. */
function setup(doc: Studio = studio(), sceneId = "s1") {
  const calls = {
    onChange: vi.fn(), onActivate: vi.fn(), onMode: vi.fn(), onRename: vi.fn(), onClose: vi.fn(),
    onUpload: vi.fn(async () => "abc.png"),
  };
  function Harness() {
    const [scene, setScene] = useState(doc.scenes.find((candidate) => candidate.id === sceneId)!);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    return (
      <EditLayout scene={scene} studio={doc} data={{ match: EMPTY, studio: doc, now: 1000, language: "en" }} selectedId={selectedId}
        onSelect={setSelectedId} status={status()}
        onChange={(elements) => {
          calls.onChange(elements);
          setScene((current) => ({ ...current, elements }));
        }}
        onUpload={calls.onUpload} onActivate={calls.onActivate} onMode={calls.onMode} onRename={calls.onRename} onClose={calls.onClose} />
    );
  }
  renderUi(<Harness />);
  return calls;
}

const layout = () => within(screen.getByRole("region", { name: "Edit layout" }));
const lastElements = (calls: ReturnType<typeof setup>) => calls.onChange.mock.lastCall![0] as SceneElement[];

/** Drags an element's handle by a distance in canvas pixels, at the 0.45 scale used where the frame cannot be measured. */
function drag(name: string, dx: number, dy = 0) {
  const handle = layout().getByRole("button", { name });
  fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 100 + dx * 0.45, clientY: 100 + dy * 0.45, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientX: 100 + dx * 0.45, clientY: 100 + dy * 0.45, pointerId: 1 });
}

test("the header names the scene on air, and Done closes the layout", () => {
  const calls = setup();
  expect(layout().getByRole("heading", { name: "Editing: Live match" })).toBeTruthy();
  expect(layout().getByText("On the program")).toBeTruthy();
  expect(layout().queryByRole("button", { name: "Put Live match on the program" })).toBeNull();
  fireEvent.click(layout().getByRole("button", { name: "Close edit layout" }));
  expect(calls.onClose).toHaveBeenCalledTimes(1);
});

test("a scene edited off the program says so and can be put on it", () => {
  const calls = setup(studio(), "s2");
  expect(layout().getByText("Not on the program")).toBeTruthy();
  fireEvent.click(layout().getByRole("button", { name: "Put Break on the program" }));
  expect(calls.onActivate).toHaveBeenCalledWith("s2");
});

test("the scene's commentary can be changed or left to the studio default", () => {
  const calls = setup();
  const commentary = layout().getByLabelText("Commentary") as HTMLSelectElement;
  expect(commentary.options[0].textContent).toBe("Studio default (Fan)");
  fireEvent.change(commentary, { target: { value: "analyst" } });
  expect(calls.onMode).toHaveBeenLastCalledWith("s1", "analyst");
  fireEvent.change(commentary, { target: { value: "" } });
  expect(calls.onMode).toHaveBeenLastCalledWith("s1", null);
});

test("with nothing selected the scene can be renamed", () => {
  const calls = setup();
  expect(layout().getByText("Select an element to change it.")).toBeTruthy();
  const name = layout().getByLabelText("Scene name");
  fireEvent.change(name, { target: { value: "  Second half  " } });
  fireEvent.blur(name);
  expect(calls.onRename).toHaveBeenCalledWith("s1", "Second half");
  fireEvent.change(name, { target: { value: "" } });
  fireEvent.blur(name);
  expect(calls.onRename).toHaveBeenCalledTimes(1);
  expect((name as HTMLInputElement).value).toBe("Live match");
});

test("Enter saves the scene's name", () => {
  const calls = setup();
  const name = layout().getByLabelText("Scene name");
  act(() => name.focus());
  fireEvent.change(name, { target: { value: "Pre-match" } });
  fireEvent.keyDown(name, { key: "Enter" });
  expect(calls.onRename).toHaveBeenCalledWith("s1", "Pre-match");
  expect(calls.onRename).toHaveBeenCalledTimes(1);
});

test("a widget is added with one click, at its own size, and its settings appear", () => {
  const calls = setup();
  const gallery = within(layout().getByRole("group", { name: "Widgets" }));
  expect(gallery.getAllByRole("button")).toHaveLength(11);
  fireEvent.click(gallery.getByRole("button", { name: "Add 3D pitch" }));
  const added = lastElements(calls)[2];
  expect(lastElements(calls)).toHaveLength(3);
  expect(added).toMatchObject({ type: "pitch3d", width: 900, height: 560, layer: 3, visible: true, props: { camera: "auto" } });
  expect(added.x + added.width).toBeLessThanOrEqual(1920);
  expect(added.y + added.height).toBeLessThanOrEqual(1080);
  expect(layout().getByLabelText("Camera")).toBeTruthy();
  expect(layout().getByRole("button", { name: "pitch3d element" })).toBeTruthy();

  fireEvent.click(gallery.getByRole("button", { name: "Add Graph" }));
  expect(lastElements(calls).at(-1)).toMatchObject({ type: "graph", props: { metric: "momentum" } });
});

test("elements can be hidden, restacked, removed and added from the layers", () => {
  const calls = setup();
  fireEvent.click(layout().getByRole("checkbox", { name: "Show banner" }));
  expect(lastElements(calls)[1]).toMatchObject({ id: "banner", visible: false });
  fireEvent.click(layout().getByRole("button", { name: "Bring scoreboard forward" }));
  expect(lastElements(calls).map((item) => [item.id, item.layer])).toEqual([["score", 2], ["banner", 1]]);
  fireEvent.click(layout().getByRole("button", { name: "Send scoreboard back" }));
  expect(lastElements(calls).map((item) => [item.id, item.layer])).toEqual([["score", 1], ["banner", 2]]);
  fireEvent.click(layout().getByRole("button", { name: "Remove banner" }));
  expect(lastElements(calls).map((item) => item.id)).toEqual(["score"]);
  fireEvent.change(layout().getByLabelText("Element type"), { target: { value: "ticker" } });
  fireEvent.click(layout().getByRole("button", { name: "Add element" }));
  const added = lastElements(calls)[1];
  expect(lastElements(calls)).toHaveLength(2);
  expect(added).toMatchObject({ type: "ticker", visible: true, layer: 2 });
  expect(added.id).not.toBe("score");
});

test("a selected text element's text is saved when the field loses focus", () => {
  const doc = studio();
  doc.scenes[0].elements.push(text());
  const calls = setup(doc);
  fireEvent.click(layout().getByRole("button", { name: "Select text" }));
  fireEvent.change(layout().getByLabelText("Text"), { target: { value: "Matchday live" } });
  expect(calls.onChange).not.toHaveBeenCalled();
  fireEvent.blur(layout().getByLabelText("Text"));
  expect(lastElements(calls)[2].props).toMatchObject({ text: "Matchday live", size: 48 });
});

test("a selected widget's settings change what it shows", () => {
  const doc = studio();
  doc.scenes[0].elements.push(
    { id: "g", type: "graph", x: 0, y: 0, width: 760, height: 300, layer: 8, visible: true, props: { metric: "momentum" } },
    { id: "p", type: "player", x: 0, y: 400, width: 520, height: 440, layer: 9, visible: true, props: { player_id: null } },
  );
  const calls = setup(doc);
  fireEvent.click(layout().getByRole("button", { name: "Select graph" }));
  fireEvent.change(layout().getByLabelText("Over time"), { target: { value: "win_probability" } });
  expect(lastElements(calls).find((item) => item.id === "g")!.props).toEqual({ metric: "win_probability" });
  fireEvent.click(layout().getByRole("button", { name: "Select player" }));
  fireEvent.change(layout().getByLabelText("Player"), { target: { value: "hbc-9" } });
  expect(lastElements(calls).find((item) => item.id === "p")!.props).toEqual({ player_id: "hbc-9" });
});

test("an element dragged to within a few pixels of the canvas edge snaps onto it", () => {
  const doc = studio();
  doc.scenes[0].elements.push(text({ x: 25, y: 300 }));
  const calls = setup(doc);
  drag("text element", -20);
  expect(lastElements(calls).find((item) => item.id === "title")).toMatchObject({ x: 0, y: 300, width: 400, height: 100 });
});

test("an element dragged near another element's edge lines up with it, and nothing else moves", () => {
  const doc = studio();
  doc.scenes[0].elements.push(text({ x: 1165, y: 300 }));
  const calls = setup(doc);
  drag("text element", -20);
  const [score, banner, title] = lastElements(calls);
  // The scoreboard's right edge is at 1140.
  expect(title).toMatchObject({ x: 1140, y: 300 });
  expect([score, banner]).toEqual(doc.scenes[0].elements.slice(0, 2));
});

test("a resize is kept as made, even when its new edge is near a guide", () => {
  const doc = studio();
  doc.scenes[0].elements.push(text({ x: 105, y: 300 }));
  const calls = setup(doc);
  drag("text element", 0);
  drag("Resize text element", 460);
  expect(lastElements(calls).find((item) => item.id === "title")).toMatchObject({ x: 105, y: 300, width: 860, height: 100 });
});
