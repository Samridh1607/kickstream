// A local stand-in for StatsBomb Open Data, API-Football and OpenLigaDB, serving the pipeline's recorded
// fixtures, so the end-to-end run never reaches the internet. Started by playwright.config.ts.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8020;
const FIXTURES = fileURLToPath(new URL("../../../services/pipeline/tests/fixtures/", import.meta.url));
const STATSBOMB = resolve(FIXTURES, "statsbomb");
const KEY = "e2e-fake-key";
const DAILY_LIMIT = 100;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const fixture = (path) => JSON.parse(readFileSync(resolve(FIXTURES, path), "utf8"));

// A live fixture stays on its current step until the test moves it on with POST /__advance, so each
// score can be seen on the program before the next arrives.
const LIVE = {
  api_football: { 1035002: ["fixture-1.json", "fixture-2.json", "fixture-3.json", "fixture-4.json"] },
  // How long before each step OpenLigaDB's kick-off is, so the estimated minutes match the goals.
  openligadb: { 83194: [["match-live-1.json", 20], ["match-live-2.json", 72], ["match-83194.json", 120]] },
};

let steps = { api_football: 0, openligadb: 0 };
let mode = {};
let apiFootballRequests = 0;

function send(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readBody(request) {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : {};
}

function statsbomb(response, path) {
  const file = resolve(STATSBOMB, decodeURIComponent(path));
  if (!file.startsWith(STATSBOMB + sep)) return send(response, 404, { error: "not found" });
  try {
    return send(response, 200, readFileSync(file, "utf8"));
  } catch {
    return send(response, 404, { error: "not found" });
  }
}

/** The recorded day's fixtures, moved to `day` at the same time of day (UTC). */
function fixturesOn(day) {
  const body = fixture("api_football/fixtures-date.json");
  body.parameters.date = day;
  for (const row of body.response) {
    row.fixture.date = `${day}T${row.fixture.date.slice(11)}`;
    const shift = Date.parse(row.fixture.date) / 1000 - row.fixture.timestamp;
    row.fixture.timestamp += shift;
    for (const period of ["first", "second"]) {
      if (row.fixture.periods[period] !== null) row.fixture.periods[period] += shift;
    }
  }
  return body;
}

function apiFootball(request, response, url) {
  apiFootballRequests += 1;
  const headers = { "x-ratelimit-requests-remaining": String(Math.max(0, DAILY_LIMIT - apiFootballRequests)) };
  if (mode.api_football === "token-error" || request.headers["x-apisports-key"] !== KEY) {
    return send(response, 200, fixture("api_football/errors-token.json"), headers);
  }
  if (url.pathname !== "/api-football/fixtures") return send(response, 404, { error: "not found" }, headers);
  const day = url.searchParams.get("date");
  if (day) return send(response, 200, fixturesOn(day), headers);
  const files = LIVE.api_football[url.searchParams.get("id")];
  if (!files) return send(response, 200, { get: "fixtures", errors: [], results: 0, response: [] }, headers);
  return send(response, 200, fixture(`api_football/${files[Math.min(steps.api_football, files.length - 1)]}`), headers);
}

const kickoff = (match) => Date.parse(match.matchDateTimeUTC);
const utc = (at) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The recorded matchday, moved by whole days so its first match kicks off today (local time). */
function matchday() {
  const matches = fixture("openligadb/getmatchdata-bl1.json");
  const first = new Date(kickoff(matches[0]));
  const today = new Date();
  today.setHours(first.getHours(), first.getMinutes(), first.getSeconds(), 0);
  const shift = Math.round((today.getTime() - first.getTime()) / DAY) * DAY;
  for (const match of matches) match.matchDateTimeUTC = utc(kickoff(match) + shift);
  return matches;
}

function openLigaDb(response, url) {
  const [, , route, what] = url.pathname.split("/");
  if (route !== "getmatchdata" || !what) return send(response, 404, { error: "not found" });
  if (!/^\d+$/.test(what)) return send(response, 200, what === "bl1" ? matchday() : []);
  const sequence = LIVE.openligadb[what];
  if (!sequence) return send(response, 200, {});
  const [file, minutesAgo] = sequence[Math.min(steps.openligadb, sequence.length - 1)];
  const match = fixture(`openligadb/${file}`);
  match.matchDateTimeUTC = utc(Date.now() - minutesAgo * MINUTE);
  return send(response, 200, match);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
  try {
    if (request.method === "POST") {
      const body = await readBody(request);
      if (url.pathname === "/__reset") {
        steps = { api_football: 0, openligadb: 0 };
        mode = {};
      } else if (url.pathname === "/__mode") {
        mode = { ...mode, ...body };
      } else if (url.pathname === "/__advance") {
        steps = { ...steps, [body.source]: (steps[body.source] ?? 0) + 1 };
      } else {
        return send(response, 404, { error: "not found" });
      }
      return send(response, 200, { steps, mode });
    }
    if (url.pathname === "/health") return send(response, 200, { ok: true });
    if (url.pathname.startsWith("/statsbomb/")) return statsbomb(response, url.pathname.slice("/statsbomb/".length));
    if (url.pathname.startsWith("/api-football/")) return apiFootball(request, response, url);
    if (url.pathname.startsWith("/openligadb/")) return openLigaDb(response, url);
    return send(response, 404, { error: "not found" });
  } catch (error) {
    return send(response, 500, { error: String(error) });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`Fake match sources on http://127.0.0.1:${PORT}`));
