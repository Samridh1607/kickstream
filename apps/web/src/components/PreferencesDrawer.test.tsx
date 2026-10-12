import { fireEvent, screen } from "@testing-library/react";
import type { ViewerProfile } from "../contracts";
import { AWAY, HOME } from "../test/fixtures";
import { renderUi } from "../test/render";
import { PreferencesDrawer } from "./PreferencesDrawer";

const profile: ViewerProfile = { mode: "fan", language: "en", club: null, player: null };
const teams = { home: HOME, away: AWAY };

function setup(over: Partial<ViewerProfile> = {}, withTeams: typeof teams | null = teams) {
  const handlers = { onChange: vi.fn(), onClose: vi.fn() };
  renderUi(<PreferencesDrawer open profile={{ ...profile, ...over }} teams={withTeams} {...handlers} />);
  return handlers;
}

const options = (label: string) =>
  Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((option) => option.textContent);

test("offers both clubs and every listed player", () => {
  setup();
  expect(options("Favorite club")).toEqual(["None", "Northbridge FC", "Harbour City"]);
  expect(options("Favorite player")).toEqual(["None", "Tobin Ashgrove", "Luca Marrowby", "Osric Pendlebury", "Evander Quillfeather"]);
});

test("choosing a favorite reports the whole updated profile", () => {
  const handlers = setup();
  fireEvent.change(screen.getByLabelText("Favorite club"), { target: { value: "hbc" } });
  expect(handlers.onChange).toHaveBeenCalledWith({ ...profile, club: "hbc" });
  fireEvent.change(screen.getByLabelText("Favorite player"), { target: { value: "nbr-9" } });
  expect(handlers.onChange).toHaveBeenCalledWith({ ...profile, player: "nbr-9" });
  fireEvent.change(screen.getByLabelText("Language"), { target: { value: "hi" } });
  expect(handlers.onChange).toHaveBeenCalledWith({ ...profile, language: "hi" });
});

test("choosing None clears the favorite", () => {
  const handlers = setup({ club: "nbr" });
  fireEvent.change(screen.getByLabelText("Favorite club"), { target: { value: "" } });
  expect(handlers.onChange).toHaveBeenCalledWith({ ...profile, club: null });
});

test("a saved favorite that is not in this match shows as None", () => {
  setup({ club: "old-club", player: "old-club-10" });
  expect((screen.getByLabelText("Favorite club") as HTMLSelectElement).value).toBe("");
  expect((screen.getByLabelText("Favorite player") as HTMLSelectElement).value).toBe("");
});

test("it works before the team sheets have loaded", () => {
  setup({}, null);
  expect(options("Favorite club")).toEqual(["None"]);
});

test("the close button closes the drawer", () => {
  const handlers = setup();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(handlers.onClose).toHaveBeenCalledOnce();
});
