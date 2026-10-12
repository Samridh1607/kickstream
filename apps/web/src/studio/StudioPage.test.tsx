import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Studio } from "../contracts";
import { useMatch } from "../stream/store";
import {
  envelope, FakeEventSource, FakeEventSourceCtor, moment, narrative, status, studio,
} from "../test/fixtures";
import { renderUi } from "../test/render";
import { StudioPage } from "./StudioPage";

interface Call {
  url: string;
  method: string;
  body: any;
}

/** Answers the control page's requests. Every studio change succeeds with the next revision unless `refuse` is set. */
function serve(initial: Studio = studio()) {
  let doc = initial;
  const calls: Call[] = [];
  const server = { calls, refuse: null as null | { status: number; field: string; msg: string } };
  const reply = (statusCode: number, body: unknown) => new Response(JSON.stringify(body), { status: statusCode });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/matches/current") return reply(200, { match_id: "m-1" });
    if (!url.startsWith("/api/studio")) return reply(404, {});
    calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
    if (server.refuse) {
      const { status: statusCode, field, msg } = server.refuse;
      return reply(statusCode, { detail: [{ loc: ["body", field], msg, type: "studio" }] });
    }
    if (url === "/api/studio/images") return reply(201, { id: "abc.png" });
    doc = { ...doc, revision: doc.revision + 1 };
    return reply(200, doc);
  }));
  return server;
}

const stream = (path: string) => FakeEventSource.instances.filter((source) => source.url.startsWith(path) && !source.closed).at(-1)!;
const last = (server: ReturnType<typeof serve>) => server.calls[server.calls.length - 1];
const openTab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

beforeEach(() => {
  FakeEventSource.instances = [];
  useMatch.setState({ data: useMatch.getInitialState().data, connection: "idle", selectedId: null });
});

async function opened(doc: Studio = studio()) {
  const server = serve(doc);
  renderUi(<StudioPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  act(() => {
    stream("/api/studio/stream").open();
    stream("/api/studio/stream").emitRaw(JSON.stringify(doc));
  });
  await waitFor(() => expect(stream("/api/matches/").url).toContain("/api/matches/m-1/stream"));
  act(() => {
    const match = stream("/api/matches/");
    match.open();
    match.emit(envelope(1, "match_status", status({ score_home: 1 })));
    match.emit(envelope(2, "key_moment", moment()));
    match.emit(envelope(3, "narrative", narrative()));
  });
  return server;
}

test("until the studio document arrives the page says it is connecting", () => {
  serve();
  renderUi(<StudioPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  expect(screen.getByText("Connecting to the studio…")).toBeTruthy();
});

test("it lists the scenes, marks the one on air, and links to the program", async () => {
  await opened();
  const scenes = within(screen.getByRole("region", { name: "Scenes" }));
  expect(scenes.getByRole("button", { name: "Edit Live match" })).toBeTruthy();
  expect(scenes.getByText("On air")).toBeTruthy();
  expect(scenes.getByRole("button", { name: "Go live with Break" })).toBeTruthy();
  expect(scenes.queryByRole("button", { name: "Go live with Live match" })).toBeNull();
  expect((scenes.getByRole("button", { name: "Delete Live match" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("link", { name: "Open program" }).getAttribute("href")).toBe("/program");
});

test("going live with a scene activates it", async () => {
  const server = await opened();
  fireEvent.click(screen.getByRole("button", { name: "Go live with Break" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/scenes/s2/activate", method: "POST" }));
});

test("scenes can be added from a template, duplicated, saved as a template and deleted", async () => {
  const server = await opened();
  fireEvent.change(screen.getByLabelText("New scene from"), { target: { value: "builtin:Full-time" } });
  fireEvent.click(screen.getByRole("button", { name: "Add scene" }));
  await waitFor(() => expect(last(server).body).toEqual({ source: "builtin", ref: "Full-time" }));
  fireEvent.click(screen.getByRole("button", { name: "Duplicate Break" }));
  await waitFor(() => expect(last(server).body).toEqual({ source: "scene", ref: "s2" }));
  fireEvent.click(screen.getByRole("button", { name: "Save Break as template" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/templates", body: { scene_id: "s2" } }));
  fireEvent.click(screen.getByRole("button", { name: "Delete Break" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/scenes/s2", method: "DELETE" }));
});

test("the editor opens on the scene on air, and another scene can be edited without going live", async () => {
  const server = await opened();
  const editor = within(screen.getByRole("region", { name: "Editor" }));
  expect(editor.getByRole("button", { name: "scoreboard element" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit Break" }));
  expect(editor.getByRole("button", { name: "countdown element" })).toBeTruthy();
  expect(editor.queryByRole("button", { name: "scoreboard element" })).toBeNull();
  expect(server.calls).toHaveLength(0);
  expect(within(screen.getByRole("region", { name: "Program preview" })).getByTestId("element-scoreboard")).toBeTruthy();
});

test("dragging an element saves that scene and only that scene", async () => {
  const server = await opened();
  const handle = within(screen.getByRole("region", { name: "Editor" })).getByRole("button", { name: "scoreboard element" });
  fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 190, clientY: 100, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientX: 190, clientY: 100, pointerId: 1 });
  await waitFor(() => expect(server.calls).toHaveLength(1));
  expect(last(server)).toMatchObject({ url: "/api/studio/scenes/s1", method: "PUT", body: { name: "Live match" } });
  const [scoreboard, banner] = last(server).body.elements;
  expect(scoreboard).toMatchObject({ id: "score", x: 240, y: 40 });
  expect(banner).toEqual(studio().scenes[0].elements[1]);
});

test("elements can be hidden, restacked, removed and added from the panel", async () => {
  const server = await opened();
  const panel = within(screen.getByRole("tabpanel"));
  fireEvent.click(panel.getByRole("checkbox", { name: "Show banner" }));
  await waitFor(() => expect(last(server).body.elements[1]).toMatchObject({ id: "banner", visible: false }));
  fireEvent.click(panel.getByRole("button", { name: "Bring scoreboard forward" }));
  await waitFor(() => expect(last(server).body.elements.map((item: any) => [item.id, item.layer])).toEqual([["score", 2], ["banner", 1]]));
  fireEvent.click(panel.getByRole("button", { name: "Remove banner" }));
  await waitFor(() => expect(last(server).body.elements.map((item: any) => item.id)).toEqual(["score"]));
  fireEvent.change(panel.getByLabelText("Element type"), { target: { value: "ticker" } });
  fireEvent.click(panel.getByRole("button", { name: "Add element" }));
  await waitFor(() => expect(last(server).body.elements).toHaveLength(3));
  const added = last(server).body.elements[2];
  expect(added).toMatchObject({ type: "ticker", visible: true, layer: 3 });
  expect(["score", "banner"]).not.toContain(added.id);
});

test("a selected text element can be edited", async () => {
  const doc = studio();
  doc.scenes[0].elements.push({ id: "title", type: "text", x: 0, y: 0, width: 400, height: 100, layer: 9, visible: true, props: { text: "Old", size: 48, align: "center" } });
  const server = await opened(doc);
  fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Select text" }));
  fireEvent.change(screen.getByLabelText("Text"), { target: { value: "Matchday live" } });
  fireEvent.blur(screen.getByLabelText("Text"));
  await waitFor(() => expect(last(server).body.elements[2].props).toMatchObject({ text: "Matchday live", size: 48 }));
});

test("a custom banner can be shown and cleared, and automatic banners switched off", async () => {
  const showing = studio({ banner: { id: "b", text: "On screen now", kind: "custom", duration_s: 8, ends_at: 2000, source_id: null } });
  const server = await opened(showing);
  openTab("Banner");
  expect(within(screen.getByRole("tabpanel")).getByText("On screen now")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Banner text"), { target: { value: "Welcome to matchday" } });
  fireEvent.click(screen.getByRole("button", { name: "Show banner" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/banner", method: "POST", body: { text: "Welcome to matchday", kind: "custom" } }));
  expect((screen.getByLabelText("Banner text") as HTMLInputElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Clear banner" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/banner", method: "DELETE" }));
  fireEvent.click(screen.getByRole("switch", { name: "Automatic banners for goals and red cards" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/settings", body: { auto_banner: false, mode: "fan" } }));
});

test("the ticker is saved with one message per line", async () => {
  const server = await opened();
  openTab("Ticker");
  fireEvent.change(screen.getByLabelText("Messages, one per line"), { target: { value: "Welcome\n\nSubscribe for more" } });
  fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "200" } });
  fireEvent.click(screen.getByRole("button", { name: "Save ticker" }));
  await waitFor(() => expect(last(server)).toMatchObject({
    url: "/api/studio/ticker", method: "PUT", body: { messages: ["Welcome", "Subscribe for more"], speed: 200, enabled: true },
  }));
});

test("key moments can be replayed and their narration sent to the banner", async () => {
  const server = await opened();
  openTab("Highlights");
  expect(screen.getByText(/^GOAL! Luca Marrowby scores/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Replay 23' Goal" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/replay", body: { match_id: "m-1", moment_id: "m-1-k1" } }));
  fireEvent.click(screen.getByRole("button", { name: "Show 23' Goal on banner" }));
  await waitFor(() => expect(last(server).body).toMatchObject({ kind: "info", source_id: "m-1-k1-fan-en" }));
  expect(last(server).body.text).toMatch(/^GOAL! Luca Marrowby scores/);
});

test("a running replay can be stopped", async () => {
  const replay = { match_id: "m-1", moment_id: "m-1-k1", minute: 23, started_at: 1000, duration_s: 8 };
  const server = await opened(studio({ replay }));
  openTab("Highlights");
  fireEvent.click(screen.getByRole("button", { name: "Stop replay" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/replay", method: "DELETE" }));
});

test("a start countdown is set on the server's clock, and a break by its length", async () => {
  vi.spyOn(Date, "now").mockReturnValue(50_000_000);
  const server = await opened(studio({ server_time: 1000 }));
  openTab("Countdown");
  fireEvent.change(screen.getByLabelText("Start in (minutes)"), { target: { value: "15" } });
  fireEvent.click(screen.getByRole("button", { name: "Start countdown" }));
  await waitFor(() => expect(last(server).body).toEqual({ kind: "start", starts_at: 1000 + 15 * 60, label: "" }));
  fireEvent.change(screen.getByLabelText("Break length (minutes)"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Take a break" }));
  await waitFor(() => expect(last(server).body).toEqual({ kind: "break", minutes: 5, label: "" }));
});

test("a running break shows the time left and can be ended", async () => {
  vi.spyOn(Date, "now").mockReturnValue(50_000_000);
  const server = await opened(studio({ server_time: 1000, countdown: { kind: "break", ends_at: 1125, label: "" } }));
  openTab("Countdown");
  expect(screen.getByText("Break: 2:05 left")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "End break" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/countdown", method: "DELETE" }));
});

test("program mode, language and the automatic switches are saved as they change", async () => {
  const server = await opened();
  openTab("Settings");
  fireEvent.change(screen.getByLabelText("Program language"), { target: { value: "hi" } });
  await waitFor(() => expect(last(server).body).toMatchObject({ language: "hi", mode: "fan" }));
  fireEvent.change(screen.getByLabelText("Program mode"), { target: { value: "analyst" } });
  await waitFor(() => expect(last(server).body).toMatchObject({ mode: "analyst" }));
  fireEvent.click(screen.getByRole("switch", { name: "Take a break automatically at half-time" }));
  await waitFor(() => expect(last(server).body).toMatchObject({ auto_half_time_break: true }));
});

test("a refused change shows the server's reason and leaves the scene as it was", async () => {
  const server = await opened();
  server.refuse = { status: 409, field: "scene", msg: "The scene on the program cannot be deleted. Switch scenes first." };
  fireEvent.click(screen.getByRole("button", { name: "Delete Break" }));
  expect(await screen.findByText("The scene on the program cannot be deleted. Switch scenes first.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit Break" })).toBeTruthy();

  const handle = within(screen.getByRole("region", { name: "Editor" })).getByRole("button", { name: "scoreboard element" });
  fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientX: 190, clientY: 100, pointerId: 1 });
  await waitFor(() => expect(server.calls).toHaveLength(2));
  await waitFor(() => expect(within(screen.getByRole("region", { name: "Editor" })).getByTestId("element-scoreboard").style.left).toBe("40px"));
});

test("a document pushed by another control page replaces what is shown", async () => {
  await opened();
  const renamed = studio({ revision: 7 });
  renamed.scenes[1] = { ...renamed.scenes[1], name: "Half-time show" };
  act(() => stream("/api/studio/stream").emitRaw(JSON.stringify(renamed)));
  expect(screen.getByRole("button", { name: "Edit Half-time show" })).toBeTruthy();
});
