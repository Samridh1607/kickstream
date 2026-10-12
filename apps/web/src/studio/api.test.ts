import { scene, studio } from "../test/fixtures";
import {
  activateScene, fetchReplay, imageUrl, saveScene, showBanner, startBreak, startCountdown, StudioRequestError, uploadImage,
} from "./api";

function serve(statusCode: number, body: unknown) {
  const mock = vi.fn(async () => new Response(JSON.stringify(body), { status: statusCode, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", mock);
  return () => {
    const [url, init] = mock.mock.calls[mock.mock.calls.length - 1] as unknown as [string, RequestInit | undefined];
    return { url, method: init?.method, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body };
  };
}

test("changes are sent to their route and resolve to the new document", async () => {
  const last = serve(200, studio({ revision: 9 }));
  expect((await activateScene("s2")).revision).toBe(9);
  expect(last()).toEqual({ url: "/api/studio/scenes/s2/activate", method: "POST", body: undefined });

  await saveScene(scene());
  expect(last()).toMatchObject({ url: "/api/studio/scenes/s1", method: "PUT", body: { name: "Live match" } });
  expect(last().body).not.toHaveProperty("id");

  await showBanner({ text: "Hello", kind: "info", source_id: "n1" });
  expect(last()).toEqual({ url: "/api/studio/banner", method: "POST", body: { text: "Hello", kind: "info", source_id: "n1" } });

  await startCountdown(1234.5);
  expect(last().body).toEqual({ kind: "start", starts_at: 1234.5, label: "" });
  await startBreak(5, "Back soon");
  expect(last().body).toEqual({ kind: "break", minutes: 5, label: "Back soon" });
});

test("a refusal carries the status, the field and the server's message", async () => {
  serve(422, { detail: [{ loc: ["body", "minutes"], msg: "A break lasts 1 to 60 minutes.", type: "studio" }] });
  const error = await startBreak(0).catch((caught) => caught);
  expect(error).toBeInstanceOf(StudioRequestError);
  expect([error.status, error.field, error.message]).toEqual([422, "minutes", "A break lasts 1 to 60 minutes."]);
});

test("a failure with no readable body still gives a usable message", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("Bad gateway", { status: 502 })));
  const error = await activateScene("s1").catch((caught) => caught);
  expect([error.status, error.field, error.message]).toEqual([502, null, "The request failed (502)."]);
});

test("images are uploaded as raw bytes and addressed by id", async () => {
  const last = serve(201, { id: "abc.png" });
  const file = new Blob([new Uint8Array([1, 2, 3])]);
  expect(await uploadImage(file)).toBe("abc.png");
  expect(last()).toMatchObject({ url: "/api/studio/images", method: "POST", body: file });
  expect(imageUrl("a b.png")).toBe("/api/studio/images/a%20b.png");
});

test("replay events are fetched for a match and moment", async () => {
  const last = serve(200, { moment: {}, events: [] });
  await fetchReplay("m 1", "m-1-k1");
  expect(last().url).toBe("/api/matches/m%201/moments/m-1-k1/replay");
});
