import { broadcasts } from "../test/fixtures";
import {
  broadcastPath, createBroadcast, deleteBroadcast, deleteReel, editBroadcast, endBroadcast, generateReels, goLiveWith,
  recordingUrl, reelUrl, selectBroadcast, studioPath,
} from "./api";

test("each action calls its address and returns the new document", async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    return new Response(JSON.stringify(broadcasts({ revision: 9 })), { status: 200 });
  }));
  expect((await createBroadcast({ title: "Derby", description: "", record: true })).revision).toBe(9);
  await editBroadcast("b 1", { title: "Cup", description: "x" });
  await selectBroadcast("b1");
  await goLiveWith("b1");
  await endBroadcast("b1");
  await generateReels("b1");
  await deleteReel("b1", "r1");
  await deleteBroadcast("b1");
  expect(calls).toEqual([
    { url: "/api/broadcasts", method: "POST", body: { title: "Derby", description: "", record: true } },
    { url: "/api/broadcasts/b%201", method: "PUT", body: { title: "Cup", description: "x" } },
    { url: "/api/broadcasts/b1/select", method: "POST", body: undefined },
    { url: "/api/broadcasts/b1/live", method: "POST", body: undefined },
    { url: "/api/broadcasts/b1/end", method: "POST", body: undefined },
    { url: "/api/broadcasts/b1/reels", method: "POST", body: undefined },
    { url: "/api/broadcasts/b1/reels/r1", method: "DELETE", body: undefined },
    { url: "/api/broadcasts/b1", method: "DELETE", body: undefined },
  ]);
});

test("a refusal comes back with its message", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ detail: [{ loc: ["body", "title"], msg: "A broadcast needs a title of 1 to 80 characters." }] }), { status: 422 },
  )));
  await expect(createBroadcast({ title: "", description: "", record: true })).rejects.toThrow("A broadcast needs a title");
});

test("pages and files have their own addresses", () => {
  expect(broadcastPath("b1")).toBe("/broadcasts/b1");
  expect(studioPath("b 1")).toBe("/broadcasts/b%201/studio");
  expect(recordingUrl("b1", "2026 rec.mp4")).toBe("/api/broadcasts/b1/recordings/2026%20rec.mp4");
  expect(reelUrl("b1", "r1")).toBe("/api/broadcasts/b1/reels/r1.mp4");
});
