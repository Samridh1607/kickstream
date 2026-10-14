import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App";
import type { Sources, TeamSheet } from "./contracts";
import { useMatch } from "./stream/store";
import {
  AWAY, envelope, FakeEventSource, FakeEventSourceCtor, HOME, moment, narrative, recap, status,
} from "./test/fixtures";
import { renderUi } from "./test/render";

const SOURCES: Sources = {
  sources: [
    { id: "simulated", name: "Simulated match", kind: "simulated", detail: "full", available: true },
    { id: "statsbomb", name: "StatsBomb", kind: "replay", detail: "full", available: true, credit: "Data: StatsBomb" },
  ],
  running: null,
};

const FRANCE: TeamSheet = {
  id: "sb-771", name: "France", short_name: "FRA", color: "#1D4ED8",
  players: [{ id: "sb-3099", name: "Antoine Griezmann", number: 7, position: "FW" }],
};
const CROATIA: TeamSheet = {
  id: "sb-785", name: "Croatia", short_name: "CRO", color: "#DC2626",
  players: [{ id: "sb-5463", name: "Luka Modrić", number: 10, position: "MF" }],
};

/** Answers the dashboard's HTTP calls. `current` is a queue; its last entry repeats. */
function serve({ current, started = "m-9", failStart = false, currentFailures = 0 }: { current: (string | null)[]; started?: string; failStart?: boolean; currentFailures?: number }) {
  let failures = currentFailures;
  const queue = [...current];
  const calls: { url: string; method: string; body: unknown }[] = [];
  const reply = (statusCode: number, body: unknown) =>
    new Response(JSON.stringify(body), { status: statusCode, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === "/api/teams") return reply(200, { home: HOME, away: AWAY });
    if (url === "/api/sources") return reply(200, SOURCES);
    if (url === "/api/matches/current") {
      if (failures > 0) {
        failures -= 1;
        return reply(502, {});
      }
      const id = queue.length > 1 ? queue.shift() : queue[0];
      return id ? reply(200, { match_id: id }) : reply(404, { detail: "no match has been started" });
    }
    if (url === "/api/matches") return failStart ? reply(500, {}) : reply(201, { match_id: started });
    return reply(404, {});
  }));
  return calls;
}

const lastUrl = () => FakeEventSource.last?.url;

beforeEach(() => {
  FakeEventSource.instances = [];
  useMatch.setState({ data: useMatch.getInitialState().data, connection: "idle", selectedId: null });
});

async function joined(matchId = "m-1", query = "mode=analyst&lang=en") {
  renderUi(<App eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} initialView="match" />);
  await waitFor(() => expect(lastUrl()).toBe(`/api/matches/${matchId}/stream?${query}`), { timeout: 10_000 });
  const source = FakeEventSource.last;
  act(() => {
    source.open();
    source.emit(envelope(1, "match_status", status({ match_id: matchId, score_home: 1 })));
    source.emit(envelope(2, "key_moment", moment()));
    source.emit(envelope(3, "narrative", narrative()));
  });
  return source;
}

test("a viewer who opens the dashboard joins the running match", async () => {
  serve({ current: ["m-1"] });
  await joined();
  expect(screen.getByTestId("score").textContent).toBe("1 - 0");
  expect(screen.getByText(/^GOAL! Luca Marrowby scores/)).toBeTruthy();
  expect(screen.getByText("Live")).toBeTruthy();
  expect(screen.getByRole("button", { name: "23' Goal" })).toBeTruthy();
});

test("with no match running, starting one connects to it", async () => {
  const calls = serve({ current: [null], started: "m-5" });
  renderUi(<App eventSource={FakeEventSourceCtor} initialView="match" />);
  await screen.findByText("No match is running. Start one to begin.");
  expect(FakeEventSource.instances).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Start match" }));
  await waitFor(() => expect(lastUrl()).toBe("/api/matches/m-5/stream?mode=analyst&lang=en"));
  expect(calls.find((call) => call.method === "POST")).toEqual({ url: "/api/matches", method: "POST", body: { speed: 30 } });
});

/** Opens the match picker. Under jsdom, Fluent's focus trap marks an open dialog aria-hidden after 250 ms, so its contents are queried with `hidden`. */
async function picker(button: string, title: string) {
  fireEvent.click(await screen.findByRole("button", { name: button }));
  return within(await screen.findByRole("dialog", { name: title, hidden: true }));
}

test("Choose match opens the picker and following the new match closes it", async () => {
  const calls = serve({ current: [null], started: "m-5" });
  renderUi(<App eventSource={FakeEventSourceCtor} initialView="match" />);
  await screen.findByText("No match is running. Start one to begin.");
  const dialog = await picker("Choose match", "Choose a match");
  expect(await dialog.findByRole("radio", { name: "StatsBomb replay", hidden: true })).toBeTruthy();
  const start = dialog.getByRole("button", { name: "Start match", hidden: true });
  await waitFor(() => expect(start.getAttribute("disabled")).toBeNull());
  fireEvent.click(start);
  await waitFor(() => expect(lastUrl()).toBe("/api/matches/m-5/stream?mode=analyst&lang=en"));
  await waitFor(() => expect(screen.queryByRole("dialog", { hidden: true })).toBeNull());
  expect(calls.find((call) => call.method === "POST")).toEqual({ url: "/api/matches", method: "POST", body: { source: "simulated", speed: 30 } });
});

test("the match picker speaks the page's language and can be closed without starting", async () => {
  localStorage.setItem("kickstream.profile", JSON.stringify({ mode: "analyst", language: "es", club: null, player: null }));
  const calls = serve({ current: [null] });
  renderUi(<App eventSource={FakeEventSourceCtor} initialView="match" />);
  const dialog = await picker("Elegir partido", "Elige un partido");
  expect(await dialog.findByRole("radio", { name: "Repetición de StatsBomb", hidden: true })).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Cerrar", hidden: true }));
  await waitFor(() => expect(screen.queryByRole("dialog", { hidden: true })).toBeNull());
  expect(calls.some((call) => call.method === "POST")).toBe(false);
});

test("favourites are offered from the playing match's teams", async () => {
  serve({ current: ["m-1"] });
  const source = await joined();
  act(() => source.emit(envelope(4, "match_status", status({ home: FRANCE, away: CROATIA, competition: "FIFA World Cup 2018", credit: "Data: StatsBomb" }))));
  expect(screen.getByText("Data: StatsBomb")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Preferences" }));
  const options = (label: string) => Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((option) => option.textContent);
  await screen.findByLabelText("Favorite club");
  expect(options("Favorite club")).toEqual(["None", "France", "Croatia"]);
  expect(options("Favorite player")).toEqual(["None", "Antoine Griezmann", "Luka Modrić"]);
});

test("the pitch panel says live data has no positions", async () => {
  serve({ current: ["m-1"] });
  const source = await joined();
  expect(screen.getByRole("switch", { name: "Pressure map" })).toBeTruthy();
  act(() => source.emit(envelope(4, "match_status", status({ score_home: 1, detail: "key_events", source: "openligadb" }))));
  expect(screen.getByText("Not available with live data")).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "Pressure map" })).toBeNull();
  expect(screen.queryByRole("img", { name: "Pitch" })).toBeNull();
});

test("a failed start tells the viewer", async () => {
  serve({ current: [null], failStart: true });
  renderUi(<App eventSource={FakeEventSourceCtor} initialView="match" />);
  fireEvent.click(await screen.findByRole("button", { name: "Start match" }));
  expect(await screen.findByText("The match could not be started. Try again.")).toBeTruthy();
});

test("a viewer who saved the fan variant still streams the analyst one", async () => {
  localStorage.setItem("kickstream.profile", JSON.stringify({ mode: "fan", language: "en", club: null, player: null }));
  serve({ current: ["m-1"] });
  await joined();
  expect(screen.queryByRole("tab", { name: "Fan" })).toBeNull();
});

test("saved preferences choose the interface language", async () => {
  localStorage.setItem("kickstream.profile", JSON.stringify({ mode: "analyst", language: "es", club: "nbr", player: null }));
  serve({ current: ["m-1"] });
  await joined("m-1", "mode=analyst&lang=es&club=nbr");
  expect(screen.getByRole("button", { name: "Reiniciar partido" })).toBeTruthy();
});

test("corrupt saved preferences fall back to the defaults", async () => {
  localStorage.setItem("kickstream.profile", "{not json");
  serve({ current: ["m-1"] });
  await joined();
});

test("when the match is replaced, the viewer is moved to the new one", async () => {
  serve({ current: ["m-1", "m-2"] });
  const first = await joined();
  act(() => first.emit(envelope(4, "match_status", status({ state: "abandoned" }))));
  await waitFor(() => expect(lastUrl()).toBe("/api/matches/m-2/stream?mode=analyst&lang=en"));
  expect(first.closed).toBe(true);
  expect(screen.queryByText(/^GOAL! Luca Marrowby scores/)).toBeNull();
});

test("when the server no longer knows the match, the viewer is offered a new one", async () => {
  serve({ current: ["m-1", null] });
  const first = await joined();
  act(() => first.fail(2));
  await screen.findByRole("button", { name: "Start match" });
  expect(screen.getByText("No match is running. Start one to begin.")).toBeTruthy();
});

test("a recap opens by itself and can be reopened from the timeline", async () => {
  serve({ current: ["m-1"] });
  const source = await joined();
  act(() => source.emit(envelope(4, "recap", recap())));
  expect((await screen.findByRole("dialog")).textContent).toContain("Half-time: Northbridge FC 1-0 Harbour City");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Half-time recap" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
});

test("selecting a narrative shows how it was made", async () => {
  serve({ current: ["m-1"] });
  await joined();
  fireEvent.click(screen.getByRole("button", { name: /^23'.*GOAL!/ }));
  const steps = screen.getAllByTestId("pipeline-step").map((step) => step.textContent);
  expect(steps[1]).toContain("Goal");
  expect(steps[2]).toContain("scripted");
});

test("the overlay tab shows broadcast JSON for the match", async () => {
  serve({ current: ["m-1"] });
  const source = await joined();
  fireEvent.click(screen.getByRole("button", { name: "Overlay" }));
  expect(screen.getByText("Overlays appear here once the match starts.")).toBeTruthy();
  const lowerThird = {
    id: "m-1-o1", match_id: "m-1", minute: 23, kind: "lower_third", language: "en", duration_ms: 6000,
    sources: ["m-1-k1-fan-en", "m-1-k1"], data: { headline: "GOAL", subline: "What a strike.", team: "Northbridge FC", minute: 23 },
  };
  act(() => source.emit(envelope(4, "overlay", lowerThird)));
  expect(screen.getByTestId("overlay-graphic").textContent).toContain("What a strike.");
});

test("the match clock advances between goals", async () => {
  serve({ current: ["m-1"] });
  const source = await joined();
  act(() => source.emit({ ...envelope(4, "stats", { home: {}, away: {}, momentum: 0 }), minute: 37 }));
  expect(screen.getByText("37'")).toBeTruthy();
});

test("if the server is not up yet, the dashboard keeps trying until it is", async () => {
  serve({ current: ["m-1"], currentFailures: 2 });
  renderUi(<App eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} initialView="match" />);
  await screen.findByText("Reconnecting");
  await waitFor(() => expect(lastUrl()).toBe("/api/matches/m-1/stream?mode=analyst&lang=en"));
});

test("a stream the server refused is reopened once the same match is reachable again", async () => {
  serve({ current: ["m-1"], currentFailures: 0 });
  const first = await joined();
  act(() => first.fail(2));
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
  expect(lastUrl()).toBe("/api/matches/m-1/stream?mode=analyst&lang=en");
  expect(first.closed).toBe(true);
});

test("a viewer left on a finished match is moved when the next one starts", async () => {
  serve({ current: ["m-1", "m-1", "m-2"] });
  const first = await joined();
  act(() => first.emit(envelope(4, "match_status", status({ state: "finished", minute: 90 }))));
  await waitFor(() => expect(lastUrl()).toBe("/api/matches/m-2/stream?mode=analyst&lang=en"));
  expect(first.closed).toBe(true);
});

test("a viewer left on a stopped match is moved when the next one starts", async () => {
  serve({ current: ["m-1", "m-1", "m-1", "m-2"] });
  const first = await joined();
  act(() => first.emit(envelope(4, "match_status", status({ state: "abandoned" }))));
  await waitFor(() => expect(lastUrl()).toBe("/api/matches/m-2/stream?mode=analyst&lang=en"));
  expect(first.closed).toBe(true);
});
