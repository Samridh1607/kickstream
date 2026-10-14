import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Broadcasts } from "../contracts";
import { useMatch } from "../stream/store";
import { StudioPage } from "../studio/StudioPage";
import { broadcast, broadcasts, destination, endedBroadcast, FakeEventSource, FakeEventSourceCtor, output, studio } from "../test/fixtures";
import { renderUi } from "../test/render";

function serve(answer: Broadcasts) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url.startsWith("/api/broadcasts")) return new Response(JSON.stringify(answer), { status: 200 });
    return new Response("{}", { status: 404 });
  }));
  return calls;
}

function push(path: string, doc: unknown) {
  act(() => {
    const source = FakeEventSource.instances.filter((item) => item.url === path && !item.closed).at(-1)!;
    source.open();
    source.emitRaw(JSON.stringify(doc));
  });
}

function open(doc: Broadcasts, out = output()) {
  renderUi(<StudioPage broadcastId="b1" eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push("/api/studio/stream", studio());
  push("/api/studio/output/stream", out);
  push("/api/broadcasts/stream", doc);
}

const part = () => within(screen.getByRole("region", { name: "Studio broadcast" }));
const bar = () => within(screen.getByRole("region", { name: "Studio top bar" }));

beforeEach(() => {
  FakeEventSource.instances = [];
  useMatch.setState({ data: useMatch.getInitialState().data, connection: "idle", selectedId: null });
});

test("the studio sits under its broadcast: Home, the broadcast, then the studio", () => {
  serve(broadcasts());
  open(broadcasts({ broadcasts: [broadcast()], current_id: "b1" }));
  const trail = within(part().getByRole("navigation", { name: "Breadcrumb" }));
  expect(trail.getByRole("link", { name: "Home" }).getAttribute("href")).toBe("/");
  expect(trail.getByRole("link", { name: "Derby day" }).getAttribute("href")).toBe("/broadcasts/b1");
  expect(trail.getByText("Studio").getAttribute("aria-current")).toBe("page");
  expect(part().getByText("Ready")).toBeTruthy();
  expect(part().getByText("Recording on")).toBeTruthy();
  // Scenes are still worked on here.
  expect(screen.getByRole("region", { name: "Scenes" })).toBeTruthy();
});

test("opening a broadcast's studio makes it the current broadcast", async () => {
  const calls = serve(broadcasts({ revision: 4, broadcasts: [broadcast(), broadcast({ id: "b2", title: "Other" })], current_id: "b1" }));
  open(broadcasts({ broadcasts: [broadcast(), broadcast({ id: "b2", title: "Other" })], current_id: "b2" }));
  await waitFor(() => expect(calls).toContainEqual({ url: "/api/broadcasts/b1/select", method: "POST" }));
});

test("Go live in the studio goes live with its broadcast, which records with no destination switched on", async () => {
  const calls = serve(broadcasts({ broadcasts: [broadcast()], current_id: "b1" }));
  open(broadcasts({ broadcasts: [broadcast()], current_id: "b1" }), output({ destinations: [destination({ enabled: false })] }));
  const goLive = bar().getByRole("button", { name: "Go live" }) as HTMLButtonElement;
  expect(goLive.disabled).toBe(false);
  expect(goLive.getAttribute("aria-disabled")).toBeNull();
  fireEvent.click(goLive);
  await waitFor(() => expect(calls).toContainEqual({ url: "/api/broadcasts/b1/live", method: "POST" }));
  expect(calls.some((call) => call.url === "/api/studio/output/start")).toBe(false);
  expect(calls.some((call) => call.url.endsWith("/select"))).toBe(false);
});

test("while it is live, the broadcast can be ended from the studio", async () => {
  const live = broadcast({ state: "live", sessions: [{ started_at: 900, ended_at: null, destinations: [], problem: null }] });
  const calls = serve(broadcasts({ revision: 5, broadcasts: [endedBroadcast()] }));
  open(broadcasts({ broadcasts: [live], current_id: "b1" }), output({ state: "live", started_at: 900 }));
  expect(bar().getByText("LIVE")).toBeTruthy();
  fireEvent.click(bar().getByRole("button", { name: "End broadcast" }));
  await waitFor(() => expect(calls).toContainEqual({ url: "/api/broadcasts/b1/end", method: "POST" }));
  expect(await bar().findByText(/This broadcast has ended/)).toBeTruthy();
});

test("an ended broadcast, another one on air, or a deleted one is explained", () => {
  serve(broadcasts());
  open(broadcasts({ broadcasts: [endedBroadcast()] }));
  expect(bar().getByText(/This broadcast has ended, so it cannot go live again/)).toBeTruthy();
  expect(bar().getByRole("link", { name: "Create a new broadcast" }).getAttribute("href")).toBe("/");
  expect(bar().queryByRole("button", { name: "End broadcast" })).toBeNull();

  push("/api/broadcasts/stream", broadcasts({
    revision: 2,
    broadcasts: [broadcast(), broadcast({ id: "b2", title: "Cup final", state: "live" })], current_id: "b2",
  }));
  expect(bar().getByText(/“Cup final” is live/)).toBeTruthy();
  expect(bar().getByRole("link", { name: "Open its studio" }).getAttribute("href")).toBe("/broadcasts/b2/studio");

  push("/api/broadcasts/stream", broadcasts({ revision: 3 }));
  expect(screen.getByText(/This broadcast no longer exists/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Choose or create one on Home" }).getAttribute("href")).toBe("/");
});
