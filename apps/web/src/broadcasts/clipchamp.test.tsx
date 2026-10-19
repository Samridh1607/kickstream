import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { reel } from "../test/fixtures";
import { renderUi } from "../test/render";
import { CLIPCHAMP_URL, megabytes, openInClipchamp, reelFileName } from "./clipchamp";
import { ReelCard } from "./ReelCard";

const EDITED = { name: "Derby day - edit.mp4", size_bytes: 12_500_000, added_at: 3000 };

function stand_ins() {
  return { save: vi.fn(async () => {}), open: vi.fn() };
}

test("a reel's file name is one every computer and Clipchamp accept", () => {
  expect(reelFileName("GOAL! Northbridge FC score in the 23'")).toBe("GOAL! Northbridge FC score in the 23'.mp4");
  expect(reelFileName('Red card: "No way" / 60\'?')).toBe("Red card No way 60'.mp4");
  expect(reelFileName("  ...  ")).toBe("Kickstream reel.mp4");
  expect(megabytes(12_500_000)).toBe("12 MB");
  expect(megabytes(4_000_000)).toBe("3.8 MB");
});

test("taking a reel to Clipchamp opens Clipchamp first, while the click counts, then saves the MP4", async () => {
  const order: string[] = [];
  const deps = { open: vi.fn(() => void order.push("open")), save: vi.fn(async () => void order.push("save")) };
  await openInClipchamp("/api/broadcasts/b1/reels/r1.mp4", "Goal.mp4", deps);
  expect(order).toEqual(["open", "save"]);
  expect(deps.save).toHaveBeenCalledWith("/api/broadcasts/b1/reels/r1.mp4", "Goal.mp4");
  expect(deps.open).toHaveBeenCalledWith(CLIPCHAMP_URL);
  expect(CLIPCHAMP_URL).toBe("https://app.clipchamp.com/");
});

test("the dialog takes the reel to Clipchamp and brings the exported video back", async () => {
  const deps = stand_ins();
  const sent: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify({ revision: 2, server_time: 1, broadcasts: [], current_id: null, ai: true }), { status: 200 });
  }));
  renderUi(<ReelCard broadcastId="b1" reel={reel()} busy={false} onDelete={() => {}} clipchamp={deps} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit in Clipchamp" }));
  const dialog = within(await screen.findByRole("dialog"));

  fireEvent.click(dialog.getByRole("button", { name: "Save the reel and open Clipchamp" }));
  expect(deps.save).toHaveBeenCalledWith("/api/broadcasts/b1/reels/r1.mp4", "GOAL! Northbridge FC score in the 23'.mp4");
  expect(deps.open).toHaveBeenCalledWith("https://app.clipchamp.com/");
  expect((await dialog.findByRole("status")).textContent).toContain("Clipchamp is open");

  const video = new File([new Uint8Array([0, 0, 0, 32, 102, 116, 121, 112])], "Derby day – edit.mp4", { type: "video/mp4" });
  fireEvent.change(dialog.getByLabelText("Edited video from Clipchamp"), { target: { files: [video] } });
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0].url).toBe("/api/broadcasts/b1/reels/r1/edited");
  expect(sent[0].init.method).toBe("PUT");
  expect(sent[0].init.body).toBe(video);
  expect((sent[0].init.headers as Record<string, string>)["x-file-name"]).toBe("Derby%20day%20%E2%80%93%20edit.mp4");
});

test("a reel that cannot be saved says why", async () => {
  const deps = { open: vi.fn(), save: vi.fn(async () => { throw new Error("The reel could not be saved (404)."); }) };
  renderUi(<ReelCard broadcastId="b1" reel={reel()} busy={false} onDelete={() => {}} clipchamp={deps} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit in Clipchamp" }));
  const dialog = within(await screen.findByRole("dialog"));
  fireEvent.click(dialog.getByRole("button", { name: "Save the reel and open Clipchamp" }));
  expect(await dialog.findByText("The reel could not be saved (404).")).toBeTruthy();
});

test("a refused video says why, in the dialog", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ detail: [{ loc: ["body", "edited"], msg: "That is not an MP4 video.", type: "refusal" }] }), { status: 422 },
  )));
  renderUi(<ReelCard broadcastId="b1" reel={reel()} busy={false} onDelete={() => {}} clipchamp={stand_ins()} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit in Clipchamp" }));
  const dialog = within(await screen.findByRole("dialog"));
  fireEvent.change(dialog.getByLabelText("Edited video from Clipchamp"), { target: { files: [new File(["x"], "notes.mp4")] } });
  expect(await dialog.findByText("That is not an MP4 video.")).toBeTruthy();
});

test("an edited reel plays its edited version, can show the original, and can go back to it", async () => {
  const sent: { url: string; method?: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, method: init.method });
    return new Response(JSON.stringify({ revision: 3, server_time: 1, broadcasts: [], current_id: null, ai: true }), { status: 200 });
  }));
  renderUi(<ReelCard broadcastId="b1" reel={reel({ edited: EDITED })} busy={false} onDelete={() => {}} clipchamp={stand_ins()} />);
  expect(screen.getByText("Edited in Clipchamp")).toBeTruthy();
  const player = () => screen.getByLabelText(/^Play /) as HTMLVideoElement;
  expect(player().getAttribute("src")).toBe("/api/broadcasts/b1/reels/r1/edited.mp4?v=3000");
  expect(screen.getByRole("link", { name: "Download the edited MP4" }).getAttribute("download")).toBe("GOAL! Northbridge FC score in the 23' (edited).mp4");

  fireEvent.click(screen.getByRole("button", { name: "Original" }));
  expect(player().getAttribute("src")).toBe("/api/broadcasts/b1/reels/r1.mp4");
  expect(screen.getByRole("link", { name: "Download the MP4" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edited" }));
  expect(player().getAttribute("src")).toContain("/edited.mp4");

  fireEvent.click(screen.getByRole("button", { name: "Edit again in Clipchamp" }));
  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByText("Derby day - edit.mp4")).toBeTruthy();
  expect(dialog.getByRole("button", { name: "Replace the edited video" })).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Remove edited version" }));
  await waitFor(() => expect(sent).toEqual([{ url: "/api/broadcasts/b1/reels/r1/edited", method: "DELETE" }]));
});

test("a reel still being cut or that failed cannot go to Clipchamp", () => {
  renderUi(<ReelCard broadcastId="b1" reel={reel({ state: "rendering" })} busy={false} onDelete={() => {}} />);
  expect(screen.queryByRole("button", { name: /Clipchamp/ })).toBeNull();
});
