import { StudioRequestError } from "../studio/api";
import {
  fetchCompetitions, fetchFixtures, fetchReplayMatches, fetchSources, localDay, SPEEDS, speedLabel, startMatchFrom, stopMatch,
} from "./api";

function serve(statusCode: number, body: unknown) {
  const mock = vi.fn(async () =>
    body === undefined
      ? new Response(null, { status: statusCode })
      : new Response(JSON.stringify(body), { status: statusCode, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", mock);
  return () => {
    const [url, init] = mock.mock.calls[mock.mock.calls.length - 1] as unknown as [string, RequestInit | undefined];
    return { url, method: init?.method, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body };
  };
}

test("sources, StatsBomb competitions and matches, and a day's fixtures are read from their routes", async () => {
  let last = serve(200, { sources: [], running: null });
  expect(await fetchSources()).toEqual({ sources: [], running: null });
  expect(last()).toEqual({ url: "/api/sources", method: "GET", body: undefined });

  last = serve(200, []);
  await fetchCompetitions();
  expect(last().url).toBe("/api/sources/statsbomb/competitions");
  await fetchReplayMatches(43, 3);
  expect(last().url).toBe("/api/sources/statsbomb/competitions/43/3/matches");
  await fetchFixtures("openligadb", "2026-10-14");
  expect(last()).toEqual({ url: "/api/sources/openligadb/fixtures?date=2026-10-14", method: "GET", body: undefined });
});

test("startMatchFrom posts the source, ref and speed and resolves to the new match", async () => {
  const last = serve(201, { match_id: "m-2" });
  expect(await startMatchFrom({ source: "statsbomb", ref: "43/3/8658", speed: 1 })).toBe("m-2");
  expect(last()).toEqual({ url: "/api/matches", method: "POST", body: { source: "statsbomb", ref: "43/3/8658", speed: 1 } });

  await startMatchFrom({ source: "simulated", speed: 30 });
  expect(last().body).toEqual({ source: "simulated", speed: 30 });
});

test("startMatchFrom posts the source, ref and speed and reports the server's refusal", async () => {
  const msg = "API-Football refused the request: Your account is suspended. Check KICKSTREAM_API_FOOTBALL_KEY in .env.";
  serve(502, { detail: [{ loc: ["body", "source"], msg, type: "source" }] });
  await expect(startMatchFrom({ source: "api_football", ref: "1", speed: 1 })).rejects.toThrow("Check KICKSTREAM_API_FOOTBALL_KEY");
  const error = await startMatchFrom({ source: "api_football", ref: "1", speed: 1 }).catch((caught) => caught);
  expect(error).toBeInstanceOf(StudioRequestError);
  expect([error.status, error.field]).toEqual([502, "source"]);
});

test("stopping accepts the empty 204 answer and reports a refusal", async () => {
  const last = serve(204, undefined);
  await expect(stopMatch()).resolves.toBeUndefined();
  expect(last()).toEqual({ url: "/api/matches/stop", method: "POST", body: undefined });

  serve(409, { detail: [{ loc: ["body"], msg: "No match is running.", type: "match" }] });
  await expect(stopMatch()).rejects.toThrow("No match is running.");
});

test("localDay is the browser's date", () => {
  expect(localDay(new Date(2026, 9, 14, 23, 30))).toBe("2026-10-14");
  expect(localDay(new Date(2027, 0, 5, 0, 5))).toBe("2027-01-05");
});

test("speeds run from real time to 30×", () => {
  expect(SPEEDS.map(speedLabel)).toEqual(["Real time", "2×", "5×", "10×", "30×"]);
  expect(speedLabel(600)).toBe("600×");
});
