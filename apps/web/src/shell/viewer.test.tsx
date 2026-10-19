import { screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { renderUi } from "../test/render";
import { AppNav } from "./AppNav";
import { canUseStudio } from "./viewer";

const answer = (body: unknown, status = 200) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

it("shows a viewer who is not signed in only auto live and the match", async () => {
  answer({ studio: false });
  renderUi(<AppNav current="match" />);
  await waitFor(() => expect(screen.queryByRole("link", { name: /Studio/ })).toBeNull());
  expect(screen.queryByRole("link", { name: /^Home/ })).toBeNull();
  expect(screen.getByRole("link", { name: /Auto live/ })).toBeTruthy();
  expect(screen.getByRole("link", { name: /Match data/ })).toBeTruthy();
});

it("shows the studio's users every page", async () => {
  answer({ studio: true });
  renderUi(<AppNav current="match" />);
  expect(await canUseStudio()).toBe(true);
  expect(screen.getByRole("link", { name: /Studio/ })).toBeTruthy();
});

it("never hides the studio when the server cannot say", async () => {
  answer({ detail: "Not Found" }, 404);
  expect(await canUseStudio()).toBe(true);
});
