import { fetchCurrentMatch, speedFromLocation, startMatch, streamUrl } from "./api";

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

test("streamUrl carries the profile and omits unset favorites", () => {
  expect(streamUrl("m-1", { mode: "fan", language: "en", club: null, player: null }))
    .toBe("/api/matches/m-1/stream?mode=fan&lang=en");
  expect(streamUrl("m 2", { mode: "analyst", language: "hi", club: "nbr", player: "nbr-9" }))
    .toBe("/api/matches/m%202/stream?mode=analyst&lang=hi&club=nbr&player=nbr-9");
});

test.each([
  ["", 30], ["?speed=600", 600], ["?speed=1", 1], ["?speed=0", 30], ["?speed=9999", 30],
  ["?speed=fast", 30], ["?speed=-3", 30], ["?other=1", 30],
])("speedFromLocation(%j) is %d", (search, expected) => {
  expect(speedFromLocation(search)).toBe(expected);
});

test("fetchCurrentMatch returns the id, or null when no match has started", async () => {
  vi.stubGlobal("fetch", respond(200, { match_id: "m-3" }));
  expect(await fetchCurrentMatch()).toBe("m-3");
  vi.stubGlobal("fetch", respond(404, { detail: "no match has been started" }));
  expect(await fetchCurrentMatch()).toBeNull();
});

test("startMatch posts the speed and returns the new id", async () => {
  const fetchMock = respond(201, { match_id: "m-4" });
  vi.stubGlobal("fetch", fetchMock);
  expect(await startMatch(600)).toBe("m-4");
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/matches");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body as string)).toEqual({ speed: 600 });
});

test("a failed request rejects with the status", async () => {
  vi.stubGlobal("fetch", respond(500, {}));
  await expect(startMatch(30)).rejects.toThrow("500");
});
