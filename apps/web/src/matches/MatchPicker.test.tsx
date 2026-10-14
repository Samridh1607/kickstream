import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Competition, Fixture, MatchListing, SourceInfo, Sources } from "../contracts";
import { renderUi } from "../test/render";
import { MatchPicker } from "./MatchPicker";

interface Sent {
  url: string;
  method: string;
  body: any;
}

const source = (overrides: Partial<SourceInfo> & Pick<SourceInfo, "id">): SourceInfo => ({
  name: overrides.id, kind: "live", detail: "key_events", available: true, credit: null, setup: null, budget_used: null, budget_limit: null,
  ...overrides,
});

const SOURCES: Sources = {
  sources: [
    source({ id: "simulated", kind: "simulated", detail: "full" }),
    source({ id: "statsbomb", kind: "replay", detail: "full", credit: "Data: StatsBomb" }),
    source({ id: "api_football", credit: "Data: API-Football", budget_used: 12, budget_limit: 100 }),
    source({ id: "openligadb", credit: "Data: OpenLigaDB" }),
  ],
  running: null,
};

const WORLD_CUP: Competition = { competition_id: 43, season_id: 3, competition_name: "FIFA World Cup", season_name: "2018", country_name: "International" };
const FINAL: MatchListing = { ref: "43/3/8658", home: "France", away: "Croatia", date: "2018-07-15", kick_off: "17:00:00.000", stage: "Final" };

const fixture = (overrides: Partial<Fixture> = {}): Fixture => ({
  ref: "1", source: "api_football", competition: "Premier League", home: "Arsenal", away: "Chelsea",
  kickoff_at: new Date(2026, 9, 14, 20, 0).getTime() / 1000, state: "pre_match", minute: null, score_home: null, score_away: null,
  ...overrides,
});

const FIXTURES: Fixture[] = [
  fixture({ ref: "1", state: "live", minute: 34, score_home: 1, score_away: 0 }),
  fixture({ ref: "2", home: "Liverpool", away: "Everton" }),
  fixture({ ref: "3", competition: "LaLiga", home: "Sevilla", away: "Betis", state: "half_time", minute: 45, score_home: 0, score_away: 0 }),
  fixture({ ref: "4", competition: "LaLiga", home: "Getafe", away: "Girona", state: "postponed" }),
];

/** Answers each route with its body, or the source's 502 message from `failures`; a POST to /api/matches gets `refusal` when set. */
function serve(answers: Record<string, unknown> = {}, failures: Record<string, string> = {}) {
  const sent: Sent[] = [];
  const server = { sent, refusal: null as null | { status: number; msg: string } };
  const reply = (statusCode: number, body: unknown) => new Response(JSON.stringify(body), { status: statusCode });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    sent.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (url === "/api/matches" && method === "POST") {
      if (server.refusal) return reply(server.refusal.status, { detail: [{ loc: ["body", "source"], msg: server.refusal.msg, type: "source" }] });
      return reply(201, { match_id: "m-2" });
    }
    const path = url.split("?")[0];
    if (path in failures) return reply(502, { detail: [{ loc: ["source"], msg: failures[path], type: "source" }] });
    if (path in answers) return reply(200, answers[path]);
    if (url === "/api/sources") return reply(200, SOURCES);
    return reply(404, { detail: [{ loc: ["path"], msg: `Nothing at ${url}.`, type: "missing" }] });
  }));
  return server;
}

const starts = (server: ReturnType<typeof serve>) => server.sent.filter((call) => call.url === "/api/matches" && call.method === "POST");
const radio = (name: string) => screen.getByRole("radio", { name });

async function picked(name: string, answers: Record<string, unknown> = {}, extraSpeed?: number) {
  const server = serve(answers);
  const onStarted = vi.fn();
  renderUi(<MatchPicker onStarted={onStarted} extraSpeed={extraSpeed} />);
  fireEvent.click(await screen.findByRole("radio", { name }));
  return { server, onStarted };
}

test("StatsBomb: choose a competition, then a match whose score is hidden, then start at the chosen speed", async () => {
  const { server, onStarted } = await picked("StatsBomb replay", {
    "/api/sources/statsbomb/competitions": [WORLD_CUP],
    "/api/sources/statsbomb/competitions/43/3/matches": [FINAL],
  });
  const competition = await screen.findByRole("option", { name: "FIFA World Cup · 2018" });
  fireEvent.change(screen.getByLabelText("Competition"), { target: { value: (competition as HTMLOptionElement).value } });
  const final = await screen.findByRole("button", { name: "France vs Croatia" });
  expect(within(final).getByText(/2018-07-15/)).toBeTruthy();
  expect(within(final).getByText(/Final/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start match" }).getAttribute("disabled")).not.toBeNull();

  fireEvent.click(final);
  expect(final.getAttribute("aria-pressed")).toBe("true");
  expect((screen.getByLabelText("Speed") as HTMLSelectElement).value).toBe("1");
  expect(within(screen.getByLabelText("Speed")).getByRole("option", { name: "Real time" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "Start match" }));

  await waitFor(() => expect(onStarted).toHaveBeenCalledWith("m-2"));
  expect(starts(server)).toEqual([{ url: "/api/matches", method: "POST", body: { source: "statsbomb", ref: "43/3/8658", speed: 10 } }]);
  expect(document.body.textContent).not.toMatch(/\b4\s*[-–]\s*2\b/);
});

test("the simulated match starts at 30× unless another speed is chosen, and the extra speed is offered", async () => {
  const { server, onStarted } = await picked("Simulated match", {}, 600);
  expect(within(screen.getByLabelText("Speed")).getAllByRole("option").map((option) => option.textContent))
    .toEqual(["Real time", "2×", "5×", "10×", "30×", "600×"]);
  expect((screen.getByLabelText("Speed") as HTMLSelectElement).value).toBe("30");
  fireEvent.click(screen.getByRole("button", { name: "Start match" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith("m-2"));
  expect(starts(server)[0].body).toEqual({ source: "simulated", speed: 30 });
});

test("each choice the streamer makes is reported once, and so is the match started, but not the default", async () => {
  const server = serve({
    "/api/sources/statsbomb/competitions": [WORLD_CUP],
    "/api/sources/statsbomb/competitions/43/3/matches": [FINAL],
  });
  const onChoose = vi.fn();
  const onStarted = vi.fn();
  renderUi(<MatchPicker onStarted={onStarted} onChoose={onChoose} />);
  fireEvent.click(await screen.findByRole("radio", { name: "StatsBomb replay" }));
  const competition = await screen.findByRole("option", { name: "FIFA World Cup · 2018" });
  fireEvent.change(screen.getByLabelText("Competition"), { target: { value: (competition as HTMLOptionElement).value } });
  expect(onChoose).not.toHaveBeenCalled();

  fireEvent.click(await screen.findByRole("button", { name: "France vs Croatia" }));
  const final = { source: "statsbomb", ref: "43/3/8658", speed: 1, title: "France vs Croatia" };
  await waitFor(() => expect(onChoose).toHaveBeenCalledWith(final));
  fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "10" } });
  await waitFor(() => expect(onChoose).toHaveBeenLastCalledWith({ ...final, speed: 10 }));
  expect(onChoose).toHaveBeenCalledTimes(2);

  fireEvent.click(screen.getByRole("button", { name: "Start match" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith("m-2"));
  expect(onChoose).toHaveBeenCalledTimes(3);
  expect(onChoose).toHaveBeenLastCalledWith({ ...final, speed: 10 });
  expect(starts(server)).toHaveLength(1);

  fireEvent.click(radio("Simulated match"));
  await waitFor(() => expect(onChoose).toHaveBeenLastCalledWith({ source: "simulated", ref: null, speed: 30, title: null }));
});

test("an unavailable source is disabled and says how to make it available", async () => {
  const setup = "Add KICKSTREAM_API_FOOTBALL_KEY to the .env file and restart the pipeline.";
  serve({
    "/api/sources": { ...SOURCES, sources: SOURCES.sources.map((item) => (item.id === "api_football" ? { ...item, available: false, setup, budget_limit: null } : item)) },
  });
  renderUi(<MatchPicker onStarted={vi.fn()} />);
  const football = await screen.findByRole("radio", { name: "API-Football live" });
  expect(football.getAttribute("disabled")).not.toBeNull();
  expect(screen.getByText(setup)).toBeTruthy();
  expect(football.getAttribute("aria-describedby")).toBe(screen.getByText(setup).id);
  expect(radio("OpenLigaDB live").getAttribute("disabled")).toBeNull();
});

test("API-Football says how much of the day's budget is used, and OpenLigaDB that its scores can lag", async () => {
  serve();
  renderUi(<MatchPicker onStarted={vi.fn()} />);
  expect(await screen.findByText("12 of 100 requests used today")).toBeTruthy();
  expect(screen.getByText("Entered by its community, so scores can arrive late.")).toBeTruthy();
});

test("live fixtures show their state and can be filtered by competition", async () => {
  const { server, onStarted } = await picked("API-Football live", { "/api/sources/api_football/fixtures": FIXTURES });
  const fixtures = within(await screen.findByRole("list", { name: "Today's fixtures" }));
  const arsenal = fixtures.getByRole("button", { name: "Arsenal vs Chelsea" });
  expect(within(arsenal).getByText("Live 34'")).toBeTruthy();
  expect(within(arsenal).getByText("1 - 0")).toBeTruthy();
  expect(within(fixtures.getByRole("button", { name: "Liverpool vs Everton" })).getByText("Not started 20:00")).toBeTruthy();
  expect(within(fixtures.getByRole("button", { name: "Sevilla vs Betis" })).getByText("Half-time")).toBeTruthy();
  const getafe = fixtures.getByRole("button", { name: "Getafe vs Girona" });
  expect(within(getafe).getByText("Postponed")).toBeTruthy();
  expect(getafe.getAttribute("disabled")).not.toBeNull();
  expect(server.sent.some((call) => /^\/api\/sources\/api_football\/fixtures\?date=\d{4}-\d{2}-\d{2}$/.test(call.url))).toBe(true);

  fireEvent.change(screen.getByLabelText("Competition"), { target: { value: "LaLiga" } });
  expect(fixtures.queryByRole("button", { name: "Arsenal vs Chelsea" })).toBeNull();
  expect(fixtures.getByRole("button", { name: "Sevilla vs Betis" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Competition"), { target: { value: "" } });
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["All competitions", "Premier League", "LaLiga"]);

  fireEvent.click(fixtures.getByRole("button", { name: "Arsenal vs Chelsea" }));
  fireEvent.click(screen.getByRole("button", { name: "Start match" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith("m-2"));
  expect(starts(server)[0].body).toEqual({ source: "api_football", ref: "1", speed: 1 });
});

test("Refresh reads today's fixtures again", async () => {
  const { server } = await picked("OpenLigaDB live", { "/api/sources/openligadb/fixtures": [fixture({ source: "openligadb" })] });
  await screen.findByRole("button", { name: "Arsenal vs Chelsea" });
  const reads = () => server.sent.filter((call) => call.url.startsWith("/api/sources/openligadb/fixtures")).length;
  expect(reads()).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(reads()).toBe(2));
});

test("a refusal is shown with the server's message and the choice is kept", async () => {
  const msg = "API-Football refused the request: Your account is suspended. Check KICKSTREAM_API_FOOTBALL_KEY in .env.";
  const { server, onStarted } = await picked("API-Football live", { "/api/sources/api_football/fixtures": FIXTURES });
  server.refusal = { status: 502, msg };
  fireEvent.click(await screen.findByRole("button", { name: "Arsenal vs Chelsea" }));
  fireEvent.click(screen.getByRole("button", { name: "Start match" }));
  expect(await screen.findByText(msg)).toBeTruthy();
  expect(onStarted).not.toHaveBeenCalled();
  expect(radio("API-Football live")).toHaveProperty("checked", true);
  expect(screen.getByRole("button", { name: "Arsenal vs Chelsea" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "Start match" }).getAttribute("disabled")).toBeNull();
});

test("a failed list says what went wrong", async () => {
  const msg = "StatsBomb could not be reached. Check the internet connection.";
  serve({}, { "/api/sources/statsbomb/competitions": msg });
  renderUi(<MatchPicker onStarted={vi.fn()} />);
  fireEvent.click(await screen.findByRole("radio", { name: "StatsBomb replay" }));
  expect(await screen.findByText(msg)).toBeTruthy();
  expect(radio("StatsBomb replay")).toHaveProperty("checked", true);
});

test("the picker speaks the page's language", async () => {
  serve({ "/api/sources/openligadb/fixtures": [fixture({ source: "openligadb", state: "finished", score_home: 2, score_away: 3 })] });
  renderUi(<MatchPicker onStarted={vi.fn()} language="es" />);
  expect(await screen.findByRole("radiogroup", { name: "Fuente" })).toBeTruthy();
  fireEvent.click(radio("OpenLigaDB en directo"));
  const arsenal = await screen.findByRole("button", { name: "Arsenal vs Chelsea" });
  expect(within(arsenal).getByText("Final")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Iniciar partido" })).toBeTruthy();
});

test("sources given by the caller are used instead of being read", async () => {
  const server = serve();
  renderUi(<MatchPicker onStarted={vi.fn()} sources={SOURCES} />);
  expect(radio("Simulated match")).toBeTruthy();
  await Promise.resolve();
  expect(server.sent.filter((call) => call.url === "/api/sources")).toHaveLength(0);
});
