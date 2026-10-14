import { fireEvent, screen } from "@testing-library/react";
import type { ViewerProfile } from "../contracts";
import { status } from "../test/fixtures";
import { renderUi } from "../test/render";
import { Header } from "./Header";

const profile: ViewerProfile = { mode: "analyst", language: "en", club: null, player: null };

function setup(over: Partial<Parameters<typeof Header>[0]> = {}) {
  const handlers = { onLanguageChange: vi.fn(), onOpenPreferences: vi.fn(), onStart: vi.fn() };
  renderUi(<Header status={status({ minute: 37, score_home: 2, score_away: 1 })} connection="live" profile={profile} {...handlers} {...over} />);
  return handlers;
}

test("shows both teams, the score, the minute and the connection state", () => {
  setup();
  expect(screen.getByText("Northbridge FC")).toBeTruthy();
  expect(screen.getByText("Harbour City")).toBeTruthy();
  expect(screen.getByTestId("score").textContent).toBe("2 - 1");
  expect(screen.getByText("37'")).toBeTruthy();
  expect(screen.getByText("Live")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Restart match" })).toBeTruthy();
});

test("with no match it invites the viewer to start one", () => {
  const handlers = setup({ status: null, connection: "idle" });
  expect(screen.getByText("No match is running. Start one to begin.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Start match" }));
  expect(handlers.onStart).toHaveBeenCalledOnce();
});

test("there is no viewing mode choice", () => {
  setup();
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.queryByRole("tab", { name: "Fan" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "Analyst" })).toBeNull();
});

test("switching language reports the new value", () => {
  const handlers = setup();
  fireEvent.change(screen.getByLabelText("Language"), { target: { value: "hi" } });
  expect(handlers.onLanguageChange).toHaveBeenCalledWith("hi");
});

test("the preferences button opens preferences", () => {
  const handlers = setup();
  fireEvent.click(screen.getByRole("button", { name: "Preferences" }));
  expect(handlers.onOpenPreferences).toHaveBeenCalledOnce();
});

test("interface text follows the viewer's language", () => {
  setup({ profile: { ...profile, language: "es" } });
  expect(screen.getByRole("button", { name: "Reiniciar partido" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Preferencias" })).toBeTruthy();
  expect(screen.getByText("En directo")).toBeTruthy();
});
