import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { useMatch } from "./stream/store";
import {
  AWAY, envelope, FakeEventSource, FakeEventSourceCtor, HOME, moment, narrative, recap, status,
} from "./test/fixtures";
import { renderUi } from "./test/render";

/** Answers the dashboard's HTTP calls. `current` is a queue; its last entry repeats. */
function serve({ current, started = "m-9", failStart = false }: { current: (string | null)[]; started?: string; failStart?: boolean }) {
  const queue = [...current];
  const calls: { url: string; method: string; body: unknown }[] = [];
  const reply = (statusCode: number, body: unknown) =>
    new Response(JSON.stringify(body), { status: statusCode, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === "/api/teams") return reply(200, { home: HOME, away: AWAY });
    if (url === "/api/matches/current") {
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

async function joined(matchId = "m-1", query = "mode=fan&lang=en") {
  renderUi(<App eventSource={FakeEventSourceCtor} />);
  await waitFor(() => expect(lastUrl()).toBe(`/api/matches/${matchId}/stream?${query}`));
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
  renderUi(<App eventSource={FakeEventSourceCtor} />);
  await screen.findByText("No match is running. Start one to begin.");
  expect(FakeEventSource.instances).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Start match" }));
  await waitFor(() => expect(lastUrl()).toBe("/api/matches/m-5/stream?mode=fan&lang=en"));
  expect(calls.find((call) => call.method === "POST")).toEqual({ url: "/api/matches", method: "POST", body: { speed: 30 } });
});

test("a failed start tells the viewer", async () => {
  serve({ current: [null], failStart: true });
  renderUi(<App eventSource={FakeEventSourceCtor} />);
  fireEvent.click(await screen.findByRole("button", { name: "Start match" }));
  expect(await screen.findByText("The match could not be started. Try again.")).toBeTruthy();
});

test("switching mode reconnects for the new variant and clears the old feed", async () => {
  serve({ current: ["m-1"] });
  const first = await joined();
  fireEvent.click(screen.getByRole("tab", { name: "Analyst" }));
  await waitFor(() => expect(lastUrl()).toBe("/api/matches/m-1/stream?mode=analyst&lang=en"));
  expect(first.closed).toBe(true);
  expect(screen.queryByText(/^GOAL! Luca Marrowby scores/)).toBeNull();
  expect(JSON.parse(localStorage.getItem("kickstream.profile") ?? "{}").mode).toBe("analyst");
});

test("saved preferences choose the variant and the interface language", async () => {
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
  await waitFor(() => expect(lastUrl()).toBe("/api/matches/m-2/stream?mode=fan&lang=en"));
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
  fireEvent.click(screen.getByRole("tab", { name: "Overlay" }));
  expect(screen.getByText("Overlays appear here once the match starts.")).toBeTruthy();
  const lowerThird = {
    id: "m-1-o1", match_id: "m-1", minute: 23, kind: "lower_third", language: "en", duration_ms: 6000,
    sources: ["m-1-k1-fan-en", "m-1-k1"], data: { headline: "GOAL", subline: "What a strike.", team: "Northbridge FC", minute: 23 },
  };
  act(() => source.emit(envelope(4, "overlay", lowerThird)));
  expect(screen.getByTestId("overlay-graphic").textContent).toContain("What a strike.");
});
