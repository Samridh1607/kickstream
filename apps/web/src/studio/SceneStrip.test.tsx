import { fireEvent, screen, within } from "@testing-library/react";
import type { Studio } from "../contracts";
import { EMPTY } from "../stream/store";
import { element, moment, scene, studio } from "../test/fixtures";
import { renderUi } from "../test/render";
import type { ProgramData } from "./elements";
import { SceneStrip } from "./SceneStrip";

function setup(doc: Studio = studio(), editingId: string | null = null) {
  const data: ProgramData = { match: EMPTY, studio: doc, now: 1000, language: "en" };
  const calls = {
    onActivate: vi.fn(), onEdit: vi.fn(), onRename: vi.fn(), onMode: vi.fn(), onCreate: vi.fn(),
    onDelete: vi.fn(), onSaveTemplate: vi.fn(), onDeleteTemplate: vi.fn(),
  };
  renderUi(<SceneStrip studio={doc} data={data} editingId={editingId} {...calls} />);
  return calls;
}

const strip = () => within(screen.getByRole("region", { name: "Scenes" }));
const openMenu = (name: string) => fireEvent.click(screen.getByRole("button", { name: `Scene menu for ${name}` }));
const item = (name: string) => screen.getByRole("menuitem", { name });

test("clicking a scene puts it on the program", () => {
  const calls = setup();
  fireEvent.click(strip().getByRole("button", { name: "Switch to Break" }));
  expect(calls.onActivate).toHaveBeenCalledWith("s2");
});

test("the scene on air is marked, cannot be switched to again and cannot be deleted", () => {
  const calls = setup();
  const live = strip().getByRole("button", { name: "Switch to Live match" });
  expect(live.getAttribute("aria-pressed")).toBe("true");
  expect(within(live).getByText("On air")).toBeTruthy();
  expect(within(strip().getByRole("button", { name: "Switch to Break" })).queryByText("On air")).toBeNull();
  fireEvent.click(live);
  expect(calls.onActivate).not.toHaveBeenCalled();

  openMenu("Live match");
  expect(item("Delete Live match").getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(item("Delete Live match"));
  expect(calls.onDelete).not.toHaveBeenCalled();
});

test("the only scene cannot be deleted", () => {
  setup(studio({ scenes: [scene()], active_scene_id: "other" }));
  openMenu("Live match");
  expect(item("Delete Live match").getAttribute("aria-disabled")).toBe("true");
});

test("the scene menu edits, duplicates, saves as a template and deletes", () => {
  const calls = setup();
  openMenu("Break");
  fireEvent.click(item("Edit Break"));
  expect(calls.onEdit).toHaveBeenCalledWith("s2");

  openMenu("Break");
  fireEvent.click(item("Duplicate Break"));
  expect(calls.onCreate).toHaveBeenCalledWith("scene", "s2");

  openMenu("Break");
  fireEvent.click(item("Save Break as template"));
  expect(calls.onSaveTemplate).toHaveBeenCalledWith("s2");

  openMenu("Break");
  fireEvent.click(item("Delete Break"));
  expect(calls.onDelete).toHaveBeenCalledWith("s2");
});

test("renaming saves the trimmed name and cancel closes without saving", () => {
  const calls = setup();
  openMenu("Break");
  fireEvent.click(item("Rename Break"));
  const input = screen.getByLabelText("Scene name") as HTMLInputElement;
  expect(input.value).toBe("Break");
  const save = screen.getByRole("button", { name: "Save" });
  expect(save.hasAttribute("disabled")).toBe(true);

  fireEvent.change(input, { target: { value: "   " } });
  expect(save.hasAttribute("disabled")).toBe(true);
  fireEvent.change(input, { target: { value: "  Half-time chat  " } });
  fireEvent.click(save);
  expect(calls.onRename).toHaveBeenCalledWith("s2", "Half-time chat");
  expect(screen.queryByLabelText("Scene name")).toBeNull();

  openMenu("Break");
  fireEvent.click(item("Rename Break"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByLabelText("Scene name")).toBeNull();
  expect(calls.onRename).toHaveBeenCalledTimes(1);
});

test("the commentary choice reflects the scene and sets its mode", () => {
  const calls = setup(studio({ scenes: [scene(), scene({ id: "s2", name: "Break", template: "Break", mode: "analyst" })] }));
  openMenu("Break");
  expect(screen.getByRole("menuitemradio", { name: "Analyst commentary" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Fan commentary" }));
  expect(calls.onMode).toHaveBeenCalledWith("s2", "fan");

  openMenu("Break");
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Studio default commentary" }));
  expect(calls.onMode).toHaveBeenLastCalledWith("s2", null);
});

test("a scene with no commentary of its own follows the studio default", () => {
  setup();
  openMenu("Live match");
  expect(screen.getByRole("menuitemradio", { name: "Studio default commentary" }).getAttribute("aria-checked")).toBe("true");
});

test("adding a scene from a built-in template", () => {
  const calls = setup();
  fireEvent.click(strip().getByRole("button", { name: "Add scene" }));
  expect(screen.getByText("Add a scene")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add scene from Interview" }));
  expect(calls.onCreate).toHaveBeenCalledWith("builtin", "Interview");
  expect(screen.queryByText("Add a scene")).toBeNull();
});

test("a saved template can be added and deleted", () => {
  const saved = scene({ id: "t1", name: "Derby desk", template: null });
  const calls = setup(studio({ templates: [saved] }));
  fireEvent.click(strip().getByRole("button", { name: "Add scene" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete template Derby desk" }));
  expect(calls.onDeleteTemplate).toHaveBeenCalledWith("t1");
  fireEvent.click(screen.getByRole("button", { name: "Add scene from Derby desk (saved)" }));
  expect(calls.onCreate).toHaveBeenCalledWith("template", "t1");
});

test("the first nine scenes are numbered", () => {
  const scenes = Array.from({ length: 10 }, (_, index) => scene({ id: `s${index + 1}`, name: `Scene ${index + 1}` }));
  setup(studio({ scenes: scenes as Studio["scenes"], active_scene_id: "s1" }));
  expect(strip().getAllByTestId("scene-number").map((badge) => badge.textContent)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
});

test("each scene shows a live thumbnail under its switch button", () => {
  setup(studio(), "s2");
  expect(strip().getAllByTestId("scene-canvas")).toHaveLength(2);
  const tile = strip().getByRole("button", { name: "Switch to Break" }).closest("li")!;
  expect(within(tile).getByTestId("element-countdown")).toBeTruthy();
});

test("a thumbnail whose widgets have buttons of their own puts no button inside the switch button", () => {
  const doc = studio({ scenes: [scene({ elements: [element({ type: "timeline", props: {} })] })], active_scene_id: "other" });
  const data: ProgramData = { match: { ...EMPTY, moments: [{ ...moment(), highlighted: false }] }, studio: doc, now: 1000, language: "en" };
  const onActivate = vi.fn();
  renderUi(<SceneStrip studio={doc} data={data} editingId={null} onActivate={onActivate} onEdit={vi.fn()} onRename={vi.fn()} onMode={vi.fn()}
    onCreate={vi.fn()} onDelete={vi.fn()} onSaveTemplate={vi.fn()} onDeleteTemplate={vi.fn()} />);
  const tile = strip().getByRole("button", { name: "Switch to Live match" });
  expect(tile.closest("li")!.querySelector("[data-testid='element-timeline'] button")).not.toBeNull();
  expect(tile.querySelector("button")).toBeNull();
  expect(tile.closest("button button")).toBeNull();
  fireEvent.click(tile);
  expect(onActivate).toHaveBeenCalledWith("s1");
});
