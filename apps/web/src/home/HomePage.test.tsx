import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useMatch } from "../stream/store";
import { audience, destination, FakeEventSource, FakeEventSourceCtor, output, poll, scene, studio } from "../test/fixtures";
import { renderUi } from "../test/render";
import { HomePage } from "./HomePage";

const stream = (path: string) => FakeEventSource.instances.filter((source) => source.url === path && !source.closed).at(-1)!;

function serve() {
  const calls: { url: string; method: string }[] = [];
  const reply = (statusCode: number, body: unknown) => new Response(JSON.stringify(body), { status: statusCode });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url === "/api/matches/current") return reply(404, {});
    if (url === "/api/studio/output/start") return reply(200, output({ revision: 5, state: "starting", destinations: [destination()] }));
    if (url === "/api/studio/scenes/s2/activate") return reply(200, studio({ revision: 5, active_scene_id: "s2" }));
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

beforeEach(() => {
  FakeEventSource.instances = [];
  useMatch.setState({ data: useMatch.getInitialState().data, connection: "idle", selectedId: null });
});

test("off air with no destinations, it explains what to do and cannot go live yet", () => {
  serve();
  renderUi(<HomePage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push("/api/studio/stream", studio());
  push("/api/studio/output/stream", output());
  const broadcast = within(screen.getByRole("region", { name: "Broadcast" }));
  expect(broadcast.getByRole("heading", { level: 1 }).textContent).toBe("Ready to go live");
  expect((broadcast.getByRole("button", { name: "Go live" }) as HTMLButtonElement).disabled).toBe(true);
  expect(broadcast.getByRole("link", { name: "Open studio" }).getAttribute("href")).toBe("/studio");
  expect(screen.getByText(/No destinations yet/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBe("page");
});

test("with a destination on, Go live starts the stream", async () => {
  const calls = serve();
  renderUi(<HomePage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push("/api/studio/stream", studio());
  push("/api/studio/output/stream", output({ destinations: [destination(), destination({ id: "d2", name: "Twitch", platform: "twitch", enabled: false })] }));
  const destinations = within(screen.getByRole("region", { name: "Destinations" }));
  expect(destinations.getByText("YouTube · key ending wxyz")).toBeTruthy();
  expect(destinations.getByText("Twitch · key ending wxyz · switched off")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Go live" }));
  await waitFor(() => expect(calls).toContainEqual({ url: "/api/studio/output/start", method: "POST" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Going live…" })).toBeTruthy();
});

test("live, it shows the time on air and every stream in the top bar", () => {
  serve();
  renderUi(<HomePage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push("/api/studio/stream", studio());
  push("/api/studio/output/stream", output({ state: "live", started_at: Date.now() / 1000 - 65, server_time: Date.now() / 1000, destinations: [destination({ status: "live" })] }));
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("You're live");
  expect(screen.getByRole("button", { name: "Stop stream" })).toBeTruthy();
  const status = within(screen.getByRole("region", { name: "Stream status" }));
  expect(status.getByText("YouTube").nextElementSibling?.textContent).toBe("Live");
});

test("scenes show their commentary, and another can be put on air from here", async () => {
  const calls = serve();
  renderUi(<HomePage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push("/api/studio/stream", studio({ scenes: [scene({ mode: "fan" }), scene({ id: "s2", name: "Analyst desk", template: "Analyst desk", mode: "analyst" })] }));
  const scenes = within(screen.getByRole("region", { name: "Scenes" }));
  expect(scenes.getByText("On air")).toBeTruthy();
  expect(scenes.getByText("Fan")).toBeTruthy();
  expect(scenes.getByText("Analyst")).toBeTruthy();
  fireEvent.click(scenes.getByRole("button", { name: "Switch to Analyst desk" }));
  await waitFor(() => expect(calls).toContainEqual({ url: "/api/studio/scenes/s2/activate", method: "POST" }));
});

test("the audience box shares the fan page and sums the poll", () => {
  serve();
  renderUi(<HomePage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push("/api/studio/stream", studio());
  push("/api/studio/audience/stream", audience({ poll: poll() }));
  const box = within(screen.getByRole("region", { name: "Audience" }));
  expect(box.getByText(`${window.location.origin}/join`)).toBeTruthy();
  expect(box.getByText("Who will win? · 4 votes")).toBeTruthy();
});
