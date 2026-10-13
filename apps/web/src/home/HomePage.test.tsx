import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useMatch } from "../stream/store";
import {
  audience, broadcast, broadcasts, destination, endedBroadcast, FakeEventSource, FakeEventSourceCtor, output, poll, studio,
} from "../test/fixtures";
import { renderUi } from "../test/render";
import { HomePage } from "./HomePage";

const stream = (path: string) => FakeEventSource.instances.filter((source) => source.url === path && !source.closed).at(-1)!;

function serve() {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const reply = (statusCode: number, body: unknown) => new Response(JSON.stringify(body), { status: statusCode });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === "/api/matches/current") return reply(404, {});
    if (url === "/api/broadcasts" && method === "POST") {
      return reply(200, broadcasts({ revision: 5, broadcasts: [broadcast({ title: "Cup final" })], current_id: "b1" }));
    }
    if (url === "/api/broadcasts/b1/live") return reply(200, broadcasts({ revision: 5, broadcasts: [broadcast()], current_id: "b1" }));
    if (url === "/api/broadcasts/b1/end") return reply(200, broadcasts({ revision: 9, broadcasts: [endedBroadcast()] }));
    return reply(404, {});
  }));
  return calls;
}

function push(path: string, doc: unknown) {
  act(() => {
    const source = stream(path);
    source.open();
    source.emitRaw(JSON.stringify(doc));
  });
}

function render() {
  renderUi(<HomePage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push("/api/studio/stream", studio());
}

beforeEach(() => {
  FakeEventSource.instances = [];
  useMatch.setState({ data: useMatch.getInitialState().data, connection: "idle", selectedId: null });
});

test("with no broadcast, Home asks for one and creates it from a title, a description and whether to record", async () => {
  const calls = serve();
  render();
  push("/api/studio/output/stream", output());
  push("/api/broadcasts/stream", broadcasts());
  const hero = within(screen.getByRole("region", { name: "Broadcast" }));
  expect(hero.getByRole("heading", { level: 1 }).textContent).toBe("Create a broadcast");
  expect(hero.queryByRole("button", { name: "Go live" })).toBeNull();
  // The studio works on a broadcast, so there is none to open yet.
  expect(hero.queryByRole("link", { name: "Open studio" })).toBeNull();
  expect(screen.getByText("No broadcasts yet")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBe("page");

  fireEvent.click(hero.getByRole("button", { name: "Create a broadcast" }));
  const dialog = within(await screen.findByRole("dialog"));
  const create = dialog.getByRole("button", { name: "Create broadcast" }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  fireEvent.change(dialog.getByRole("textbox", { name: /Title/ }), { target: { value: "Cup final" } });
  fireEvent.change(dialog.getByRole("textbox", { name: /Description/ }), { target: { value: "Live from the stadium" } });
  fireEvent.click(dialog.getByRole("switch", { name: "Record this broadcast" }));
  fireEvent.click(create);
  await waitFor(() => expect(calls).toContainEqual({
    url: "/api/broadcasts", method: "POST", body: { title: "Cup final", description: "Live from the stadium", record: false },
  }));
  expect(await screen.findByRole("heading", { level: 1, name: "Cup final" })).toBeTruthy();
});

test("the current broadcast goes live from Home, even with recording as its only destination", async () => {
  const calls = serve();
  render();
  push("/api/studio/output/stream", output());
  push("/api/broadcasts/stream", broadcasts({ broadcasts: [broadcast()], current_id: "b1" }));
  const hero = within(screen.getByRole("region", { name: "Broadcast" }));
  expect(hero.getByRole("heading", { level: 1 }).textContent).toBe("Derby day");
  expect(hero.getByText("Matchday 12")).toBeTruthy();
  expect(hero.getByText("Recording on")).toBeTruthy();
  expect(hero.getByRole("link", { name: "Details" }).getAttribute("href")).toBe("/broadcasts/b1");
  expect(hero.getByRole("link", { name: "Open studio" }).getAttribute("href")).toBe("/broadcasts/b1/studio");
  expect(screen.getByRole("link", { name: "Manage" }).getAttribute("href")).toBe("/broadcasts/b1/studio");
  fireEvent.click(hero.getByRole("button", { name: "Go live" }));
  await waitFor(() => expect(calls).toContainEqual({ url: "/api/broadcasts/b1/live", method: "POST", body: undefined }));
});

test("why the stream stopped is shown on Home", () => {
  serve();
  render();
  push("/api/studio/output/stream", output({ problem: "ffmpeg was not found." }));
  push("/api/broadcasts/stream", broadcasts({ broadcasts: [broadcast()], current_id: "b1" }));
  expect(screen.getByText("ffmpeg was not found.")).toBeTruthy();
});

test("a broadcast that does not record needs a destination to go live", () => {
  serve();
  render();
  push("/api/studio/output/stream", output());
  push("/api/broadcasts/stream", broadcasts({ broadcasts: [broadcast({ record: false, description: "" })], current_id: "b1" }));
  const hero = within(screen.getByRole("region", { name: "Broadcast" }));
  expect((hero.getByRole("button", { name: "Go live" }) as HTMLButtonElement).disabled).toBe(true);
  expect(hero.getByText(/Add a destination in the studio, or turn recording on/)).toBeTruthy();
});

test("live, Home shows the time on air and ends the broadcast", async () => {
  const calls = serve();
  render();
  const started = studio().server_time - 65;
  push("/api/studio/output/stream", output({ state: "live", started_at: started, server_time: studio().server_time, destinations: [destination({ status: "live" })] }));
  const live = broadcast({ state: "live", sessions: [{ started_at: started, ended_at: null, destinations: [], problem: null }] });
  push("/api/broadcasts/stream", broadcasts({ broadcasts: [live], current_id: "b1", server_time: studio().server_time }));
  const hero = within(screen.getByRole("region", { name: "Broadcast" }));
  expect(hero.getByText(/Live now · 1:0\d/)).toBeTruthy();
  expect(hero.getByText(/Streaming to 1 destination/)).toBeTruthy();
  const status = within(screen.getByRole("region", { name: "Stream status" }));
  expect(status.getByText("YouTube").nextElementSibling?.textContent).toBe("Live");
  fireEvent.click(hero.getByRole("button", { name: "End broadcast" }));
  await waitFor(() => expect(calls).toContainEqual({ url: "/api/broadcasts/b1/end", method: "POST", body: undefined }));
});

test("every broadcast is listed with what it kept, and leads to its page", () => {
  serve();
  render();
  push("/api/studio/output/stream", output());
  push("/api/broadcasts/stream", broadcasts({ broadcasts: [broadcast({ id: "b2", title: "Next week" }), endedBroadcast()] }));
  const list = within(screen.getByRole("region", { name: "Broadcasts" }));
  const ended = list.getByRole("link", { name: "Derby day, Ended" });
  expect(ended.getAttribute("href")).toBe("/broadcasts/b1");
  const facts = within(ended);
  expect(facts.getByText("2 min on air")).toBeTruthy();
  expect(facts.getByText("1 recording")).toBeTruthy();
  expect(facts.getByText("1 reel")).toBeTruthy();
  expect(facts.getByText("Northbridge FC 1–0 Harbour City")).toBeTruthy();
  expect(list.getByRole("link", { name: "Next week, Ready" })).toBeTruthy();
  // Scenes are the studio's business now.
  expect(screen.queryByRole("region", { name: "Scenes" })).toBeNull();
});

test("the audience box shares the fan page and sums the poll", () => {
  serve();
  render();
  push("/api/studio/audience/stream", audience({ poll: poll() }));
  const box = within(screen.getByRole("region", { name: "Audience" }));
  expect(box.getByText(`${window.location.origin}/join`)).toBeTruthy();
  expect(box.getByText("Who will win? · 4 votes")).toBeTruthy();
});

test("destinations are listed with their key hint", () => {
  serve();
  render();
  push("/api/studio/output/stream", output({ destinations: [destination(), destination({ id: "d2", name: "Twitch", platform: "twitch", enabled: false })] }));
  const destinations = within(screen.getByRole("region", { name: "Destinations" }));
  expect(destinations.getByText("YouTube · key ending wxyz")).toBeTruthy();
  expect(destinations.getByText("Twitch · key ending wxyz · switched off")).toBeTruthy();
});
