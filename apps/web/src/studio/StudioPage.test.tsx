import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Broadcasts, People, Studio } from "../contracts";
import { useMatch } from "../stream/store";
import {
  broadcast, broadcasts, callSeat, destination, envelope, fanComment, FakeEventSource, FakeEventSourceCtor, fanZone, invitation, moment, narrative,
  output, peopleDoc, scene, status, studio,
} from "../test/fixtures";
import { FakeRoomCall } from "../test/FakeRoomCall";
import { renderUi } from "../test/render";
import { StudioPage } from "./StudioPage";

const room = vi.hoisted(() => ({ call: null as unknown }));
vi.mock("../calls/open", () => ({ openRoomCall: () => room.call }));

interface Call {
  url: string;
  method: string;
  body: any;
}

/**
 * Answers the control page's requests. Every studio change succeeds with the next revision unless `refuse` is set;
 * broadcast and people requests are kept apart in `others`.
 */
function serve(initial: Studio = studio(), answers: { broadcasts?: Broadcasts; people?: People } = {}) {
  let doc = initial;
  const calls: Call[] = [];
  const others: Call[] = [];
  const server = {
    calls, others, people: answers.people ?? peopleDoc(), refuse: null as null | { status: number; field: string; msg: string },
  };
  const reply = (statusCode: number, body: unknown) => new Response(JSON.stringify(body), { status: statusCode });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    if (url === "/api/matches/current") return reply(200, { match_id: "m-1" });
    if (url === "/api/sources") return reply(200, { sources: [{ id: "simulated", name: "Simulated", kind: "simulated", detail: "full", available: true }], running: null });
    if (url === "/api/matches" && method === "POST") {
      others.push({ url, method, body });
      return reply(201, { match_id: "m-2" });
    }
    if (url.endsWith("/host/seat")) return reply(200, callSeat({ acs_id: "8:fake:host" }));
    if (url.startsWith("/api/broadcasts/")) {
      others.push({ url, method, body });
      return reply(200, url.includes("/people/") ? server.people : (answers.broadcasts ?? broadcasts()));
    }
    if (!url.startsWith("/api/studio")) return reply(404, {});
    calls.push({ url, method, body });
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
const push = (path: string, doc: unknown) => act(() => {
  stream(path).open();
  stream(path).emitRaw(JSON.stringify(doc));
});
const last = (server: ReturnType<typeof serve>) => server.calls[server.calls.length - 1];
const region = (name: string) => within(screen.getByRole("region", { name }));
const editLayout = () => region("Edit layout");
const openEditLayout = () => fireEvent.click(region("Studio top bar").getByRole("button", { name: "Edit layout" }));
const closeEditLayout = () => fireEvent.click(editLayout().getByRole("button", { name: "Close edit layout" }));
const openTool = (name: string) => fireEvent.click(within(screen.getByRole("navigation", { name: "Tools" })).getByRole("button", { name }));
/** Opens a scene's menu in the strip and picks one of its items. */
function sceneMenu(sceneName: string, item: string) {
  fireEvent.click(screen.getByRole("button", { name: `Scene menu for ${sceneName}` }));
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
}

beforeEach(() => {
  FakeEventSource.instances = [];
  room.call = null;
  useMatch.setState({ data: useMatch.getInitialState().data, connection: "idle", selectedId: null });
});

async function opened(doc: Studio = studio()) {
  const server = serve(doc);
  renderUi(<StudioPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push("/api/studio/stream", doc);
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

/** A broadcast's studio, with its broadcast and its people. */
function openedBroadcast({ people = peopleDoc(), out = output(), item = broadcast() } = {}) {
  const doc = broadcasts({ broadcasts: [item], current_id: item.id });
  const server = serve(studio(), { broadcasts: doc, people });
  renderUi(<StudioPage broadcastId="b1" eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push("/api/studio/stream", studio());
  push("/api/studio/output/stream", out);
  push("/api/broadcasts/stream", doc);
  push("/api/broadcasts/b1/people/stream", people);
  return server;
}

test("until the studio document arrives the page says it is connecting", () => {
  serve();
  renderUi(<StudioPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  expect(screen.getByText("Connecting to the studio…")).toBeTruthy();
});

test("it lists the scenes, marks the one on air, and shows the program here rather than linking away", async () => {
  await opened();
  const scenes = region("Scenes");
  const onAir = scenes.getByRole("button", { name: "Switch to Live match" });
  expect(onAir.getAttribute("aria-pressed")).toBe("true");
  expect(within(onAir).getByText("On air")).toBeTruthy();
  expect(scenes.getByRole("button", { name: "Switch to Break" }).getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Scene menu for Live match" }));
  expect(screen.getByRole("menuitem", { name: "Delete Live match" }).getAttribute("aria-disabled")).toBe("true");
  expect(region("Stage").getByTestId("element-scoreboard")).toBeTruthy();
  expect(screen.queryAllByRole("link").map((link) => link.getAttribute("href"))).not.toContain("/program");
});

test("switching to a scene activates it", async () => {
  const server = await opened();
  fireEvent.click(screen.getByRole("button", { name: "Switch to Break" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/scenes/s2/activate", method: "POST" }));
});

test("each scene shows whose commentary it carries, and the edited scene's can be changed", async () => {
  const server = await opened(studio({ scenes: [scene({ mode: "analyst" }), scene({ id: "s2", name: "Break", template: "Break" })] }));
  const scenes = region("Scenes");
  expect(scenes.getByText("Analyst")).toBeTruthy();
  expect(scenes.getByText("Fan (default)")).toBeTruthy();
  await waitFor(() => expect(stream("/api/matches/").url).toContain("mode=analyst"));
  openEditLayout();
  fireEvent.change(editLayout().getByLabelText("Commentary"), { target: { value: "fan" } });
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/scenes/s1/mode", method: "PUT", body: { mode: "fan" } }));
  fireEvent.change(editLayout().getByLabelText("Commentary"), { target: { value: "" } });
  await waitFor(() => expect(last(server).body).toEqual({ mode: null }));
});

test("scenes can be added from a template, duplicated, saved as a template and deleted", async () => {
  const server = await opened();
  fireEvent.click(screen.getByRole("button", { name: "Add scene" }));
  fireEvent.click(screen.getByRole("button", { name: "Add scene from Full-time" }));
  await waitFor(() => expect(last(server).body).toEqual({ source: "builtin", ref: "Full-time" }));
  sceneMenu("Break", "Duplicate Break");
  await waitFor(() => expect(last(server).body).toEqual({ source: "scene", ref: "s2" }));
  sceneMenu("Break", "Save Break as template");
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/templates", body: { scene_id: "s2" } }));
  sceneMenu("Break", "Delete Break");
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/scenes/s2", method: "DELETE" }));
});

test("an Interview scene can be made from the built-in templates", async () => {
  const server = await opened();
  fireEvent.click(screen.getByRole("button", { name: "Add scene" }));
  fireEvent.click(screen.getByRole("button", { name: "Add scene from Interview" }));
  await waitFor(() => expect(last(server).body).toEqual({ source: "builtin", ref: "Interview" }));
});

test("a scene can be renamed from the strip, keeping its elements", async () => {
  const server = await opened();
  sceneMenu("Break", "Rename Break");
  fireEvent.change(screen.getByLabelText("Scene name"), { target: { value: "Half-time" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(last(server)).toMatchObject({
    url: "/api/studio/scenes/s2", method: "PUT", body: { name: "Half-time", elements: studio().scenes[1].elements },
  }));
});

test("edit layout opens on the scene on air, and another scene can be edited without going live", async () => {
  const server = await opened();
  openEditLayout();
  expect(editLayout().getByRole("button", { name: "scoreboard element" })).toBeTruthy();
  sceneMenu("Break", "Edit Break");
  expect(editLayout().getByRole("button", { name: "countdown element" })).toBeTruthy();
  expect(editLayout().queryByRole("button", { name: "scoreboard element" })).toBeNull();
  expect(server.calls).toHaveLength(0);
  closeEditLayout();
  expect(region("Stage").getByTestId("element-scoreboard")).toBeTruthy();
});

test("opening edit layout puts it in place of the stage and keeps the scene strip", async () => {
  await opened();
  expect(screen.queryByRole("region", { name: "Edit layout" })).toBeNull();
  openEditLayout();
  expect(screen.getByRole("region", { name: "Edit layout" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Stage" })).toBeNull();
  expect(screen.getByRole("region", { name: "Scenes" })).toBeTruthy();
  expect(region("Studio top bar").getByRole("button", { name: "Edit layout" }).getAttribute("aria-pressed")).toBe("true");
  openEditLayout();
  expect(screen.queryByRole("region", { name: "Edit layout" })).toBeNull();
  expect(screen.getByRole("region", { name: "Stage" })).toBeTruthy();
});

test("a scene being edited off the program says so and can be put on it", async () => {
  const server = await opened();
  expect(within(screen.getByRole("navigation", { name: "Tools" })).queryByRole("button", { name: "Guests" })).toBeNull();
  openEditLayout();
  expect(editLayout().getByText("On the program")).toBeTruthy();
  sceneMenu("Break", "Edit Break");
  expect(editLayout().getByText("Not on the program")).toBeTruthy();
  fireEvent.click(editLayout().getByRole("button", { name: "Put Break on the program" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/scenes/s2/activate", method: "POST" }));
});

test("dragging an element saves that scene and only that scene", async () => {
  const server = await opened();
  openEditLayout();
  const handle = editLayout().getByRole("button", { name: "scoreboard element" });
  fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 190, clientY: 100, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientX: 190, clientY: 100, pointerId: 1 });
  await waitFor(() => expect(server.calls).toHaveLength(1));
  expect(last(server)).toMatchObject({ url: "/api/studio/scenes/s1", method: "PUT", body: { name: "Live match" } });
  const [scoreboard, banner] = last(server).body.elements;
  expect(scoreboard).toMatchObject({ id: "score", x: 240, y: 40 });
  expect(banner).toEqual(studio().scenes[0].elements[1]);
});

test("elements can be hidden, restacked, removed and added from the layers", async () => {
  const server = await opened();
  openEditLayout();
  const layout = editLayout();
  fireEvent.click(layout.getByRole("checkbox", { name: "Show banner" }));
  await waitFor(() => expect(last(server).body.elements[1]).toMatchObject({ id: "banner", visible: false }));
  fireEvent.click(layout.getByRole("button", { name: "Bring scoreboard forward" }));
  await waitFor(() => expect(last(server).body.elements.map((item: any) => [item.id, item.layer])).toEqual([["score", 2], ["banner", 1]]));
  fireEvent.click(layout.getByRole("button", { name: "Remove banner" }));
  await waitFor(() => expect(last(server).body.elements.map((item: any) => item.id)).toEqual(["score"]));
  fireEvent.change(layout.getByLabelText("Element type"), { target: { value: "ticker" } });
  fireEvent.click(layout.getByRole("button", { name: "Add element" }));
  await waitFor(() => expect(last(server).body.elements).toHaveLength(3));
  const added = last(server).body.elements[2];
  expect(added).toMatchObject({ type: "ticker", visible: true, layer: 3 });
  expect(["score", "banner"]).not.toContain(added.id);
});

test("a selected text element can be edited", async () => {
  const doc = studio();
  doc.scenes[0].elements.push({ id: "title", type: "text", x: 0, y: 0, width: 400, height: 100, layer: 9, visible: true, props: { text: "Old", size: 48, align: "center" } });
  const server = await opened(doc);
  openEditLayout();
  fireEvent.click(editLayout().getByRole("button", { name: "Select text" }));
  fireEvent.change(editLayout().getByLabelText("Text"), { target: { value: "Matchday live" } });
  fireEvent.blur(editLayout().getByLabelText("Text"));
  await waitFor(() => expect(last(server).body.elements[2].props).toMatchObject({ text: "Matchday live", size: 48 }));
});

test("a custom banner can be shown and cleared, and automatic banners switched off", async () => {
  const showing = studio({ banner: { id: "b", text: "On screen now", kind: "custom", duration_s: 8, ends_at: 2000, source_id: null } });
  const server = await opened(showing);
  openTool("Banners");
  const tool = region("Banners tool");
  expect(tool.getByText("On screen now")).toBeTruthy();
  fireEvent.change(tool.getByLabelText("Banner text"), { target: { value: "Welcome to matchday" } });
  fireEvent.click(tool.getByRole("button", { name: "Show banner" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/banner", method: "POST", body: { text: "Welcome to matchday", kind: "custom" } }));
  await waitFor(() => expect((tool.getByLabelText("Banner text") as HTMLInputElement).value).toBe(""));
  fireEvent.click(tool.getByRole("button", { name: "Clear banner" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/banner", method: "DELETE" }));
  fireEvent.click(tool.getByRole("switch", { name: "Automatic banners for goals and red cards" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/settings", body: { auto_banner: false, mode: "fan" } }));
});

test("the ticker is saved with one message per line", async () => {
  const server = await opened();
  openTool("Banners");
  fireEvent.change(screen.getByLabelText("Messages, one per line"), { target: { value: "Welcome\n\nSubscribe for more" } });
  fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "200" } });
  fireEvent.click(screen.getByRole("button", { name: "Save ticker" }));
  await waitFor(() => expect(last(server)).toMatchObject({
    url: "/api/studio/ticker", method: "PUT", body: { messages: ["Welcome", "Subscribe for more"], speed: 200, enabled: true },
  }));
});

test("key moments can be replayed and their narration sent to the banner", async () => {
  const server = await opened();
  openTool("Replays");
  const tool = region("Replays tool");
  expect(tool.getByText(/^GOAL! Luca Marrowby scores/)).toBeTruthy();
  fireEvent.click(tool.getByRole("button", { name: "Replay 23' Goal" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/replay", body: { match_id: "m-1", moment_id: "m-1-k1" } }));
  fireEvent.click(tool.getByRole("button", { name: "Show 23' Goal on banner" }));
  await waitFor(() => expect(last(server).body).toMatchObject({ kind: "info", source_id: "m-1-k1-fan-en" }));
  expect(last(server).body.text).toMatch(/^GOAL! Luca Marrowby scores/);
});

test("a running replay can be stopped", async () => {
  const replay = { match_id: "m-1", moment_id: "m-1-k1", minute: 23, started_at: 1000, duration_s: 8 };
  const server = await opened(studio({ replay }));
  openTool("Replays");
  fireEvent.click(screen.getByRole("button", { name: "Stop replay" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/replay", method: "DELETE" }));
});

test("a start countdown is set on the server's clock, and a break by its length", async () => {
  vi.spyOn(Date, "now").mockReturnValue(50_000_000);
  const server = await opened(studio({ server_time: 1000 }));
  openTool("Timer");
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
  openTool("Timer");
  expect(region("Timer tool").getByText("Break: 2:05 left")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "End break" }));
  await waitFor(() => expect(last(server)).toMatchObject({ url: "/api/studio/countdown", method: "DELETE" }));
});

test("default commentary, language and the automatic switches are saved as they change", async () => {
  const server = await opened();
  openTool("Settings");
  fireEvent.change(screen.getByLabelText("Program language"), { target: { value: "hi" } });
  await waitFor(() => expect(last(server).body).toMatchObject({ language: "hi", mode: "fan" }));
  fireEvent.change(screen.getByLabelText("Default commentary"), { target: { value: "analyst" } });
  await waitFor(() => expect(last(server).body).toMatchObject({ mode: "analyst" }));
  fireEvent.click(screen.getByRole("switch", { name: "Take a break automatically at half-time" }));
  await waitFor(() => expect(last(server).body).toMatchObject({ auto_half_time_break: true }));
});

test("a refused change shows the server's reason and leaves the scene as it was", async () => {
  const server = await opened();
  server.refuse = { status: 409, field: "scene", msg: "The scene on the program cannot be deleted. Switch scenes first." };
  sceneMenu("Break", "Delete Break");
  expect(await region("Studio errors").findByText("The scene on the program cannot be deleted. Switch scenes first.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Switch to Break" })).toBeTruthy();

  openEditLayout();
  const handle = editLayout().getByRole("button", { name: "scoreboard element" });
  fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientX: 190, clientY: 100, pointerId: 1 });
  await waitFor(() => expect(server.calls).toHaveLength(2));
  await waitFor(() => expect(editLayout().getByTestId("element-scoreboard").style.left).toBe("40px"));
});

test("a refusal shows as a toast that can be dismissed", async () => {
  const server = await opened();
  expect(region("Studio errors").queryByRole("button", { name: "Dismiss" })).toBeNull();
  server.refuse = { status: 409, field: "scene", msg: "That scene is busy." };
  fireEvent.click(screen.getByRole("button", { name: "Switch to Break" }));
  const errors = region("Studio errors");
  expect(await errors.findByText("That scene is busy.")).toBeTruthy();
  fireEvent.click(errors.getByRole("button", { name: "Dismiss" }));
  expect(errors.queryByText("That scene is busy.")).toBeNull();
});

test("a match started from the Match tool clears an earlier refusal", async () => {
  const server = await opened();
  server.refuse = { status: 409, field: "scene", msg: "That scene is busy." };
  fireEvent.click(screen.getByRole("button", { name: "Switch to Break" }));
  expect(await region("Studio errors").findByText("That scene is busy.")).toBeTruthy();
  openTool("Match");
  const tool = region("Match tool");
  fireEvent.click(await tool.findByRole("radio", { name: "Simulated match" }));
  fireEvent.click(tool.getByRole("button", { name: "Start match" }));
  await waitFor(() => expect(server.others.at(-1)).toEqual({ url: "/api/matches", method: "POST", body: { source: "simulated", speed: 30 } }));
  await waitFor(() => expect(region("Studio errors").queryByText("That scene is busy.")).toBeNull());
});

test("a document pushed by another control page replaces what is shown", async () => {
  await opened();
  const renamed = studio({ revision: 7 });
  renamed.scenes[1] = { ...renamed.scenes[1], name: "Half-time show" };
  act(() => stream("/api/studio/stream").emitRaw(JSON.stringify(renamed)));
  expect(screen.getByRole("button", { name: "Switch to Half-time show" })).toBeTruthy();
});

test("edit layout stays on the scene being edited when the scene on air changes", async () => {
  await opened();
  openEditLayout();
  expect(editLayout().getByRole("button", { name: "scoreboard element" })).toBeTruthy();
  // A countdown ends, a break ends, or another control page goes live with a different scene.
  act(() => stream("/api/studio/stream").emitRaw(JSON.stringify(studio({ revision: 7, active_scene_id: "s2" }))));
  expect(region("Studio top bar").getByText("On air: Break")).toBeTruthy();
  expect(editLayout().getByRole("button", { name: "scoreboard element" })).toBeTruthy();
  expect(editLayout().queryByRole("button", { name: "countdown element" })).toBeNull();
  expect(screen.getByText("Editing: Live match")).toBeTruthy();
});

test("a selection does not carry over to an element with the same id in another scene", async () => {
  const doc = studio();
  doc.scenes[1] = { ...doc.scenes[1], elements: [{ ...doc.scenes[1].elements[0], id: "score" }] };
  const server = await opened(doc);
  openEditLayout();
  const handle = editLayout().getByRole("button", { name: "scoreboard element" });
  fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientX: 100, clientY: 100, pointerId: 1 });
  expect(handle.getAttribute("aria-pressed")).toBe("true");

  sceneMenu("Break", "Edit Break");
  const other = editLayout().getByRole("button", { name: "countdown element" });
  expect(other.getAttribute("aria-pressed")).toBe("false");
  expect(editLayout().queryByRole("button", { name: "Resize countdown element" })).toBeNull();
  expect(server.calls).toHaveLength(0);
});

test("if the scene being edited is deleted elsewhere, edit layout moves to the scene on air with nothing selected", async () => {
  await opened();
  sceneMenu("Break", "Edit Break");
  fireEvent.click(editLayout().getByRole("button", { name: "Select countdown" }));
  const onlyLive = studio({ revision: 7 });
  onlyLive.scenes = [onlyLive.scenes[0]];
  act(() => stream("/api/studio/stream").emitRaw(JSON.stringify(onlyLive)));
  expect(screen.getByText("Editing: Live match")).toBeTruthy();
  expect(editLayout().getByRole("button", { name: "scoreboard element" }).getAttribute("aria-pressed")).toBe("false");
});

test("a second edit made before the first is answered is not lost when the first answer arrives", async () => {
  await opened();
  openEditLayout();
  // From here every studio request waits until the test releases it.
  const waiting: (() => void)[] = [];
  const doc = studio({ revision: 2 });
  vi.stubGlobal("fetch", vi.fn((url: string) =>
    new Promise<Response>((resolve) => {
      const answer = () => resolve(new Response(JSON.stringify(url === "/api/matches/current" ? { match_id: "m-1" } : doc), { status: 200 }));
      if (url.startsWith("/api/studio")) waiting.push(answer);
      else answer();
    })));
  const layout = editLayout();
  const shown = (name: string) => (layout.getByRole("checkbox", { name }) as HTMLInputElement).checked;

  fireEvent.click(layout.getByRole("checkbox", { name: "Show banner" }));
  fireEvent.click(layout.getByRole("checkbox", { name: "Show scoreboard" }));
  expect([shown("Show banner"), shown("Show scoreboard")]).toEqual([false, false]);
  await waitFor(() => expect(waiting).toHaveLength(2));

  await act(async () => waiting[0]());
  expect([shown("Show banner"), shown("Show scoreboard")]).toEqual([false, false]);
  await act(async () => waiting[1]());
  await waitFor(() => expect([shown("Show banner"), shown("Show scoreboard")]).toEqual([true, true]));
});

test("the Stream tool follows the output document", async () => {
  await opened();
  openTool("Stream");
  const tool = region("Stream tool");
  expect(tool.getByText("Connecting to the output…")).toBeTruthy();
  push("/api/studio/output/stream", output({ destinations: [destination()] }));
  expect(tool.getByRole("switch", { name: "Send to YouTube" })).toBeTruthy();
  expect(tool.getByRole("region", { name: "Stream" })).toBeTruthy();
});

test("while live, the top bar shows each stream being sent and how it is doing", async () => {
  await opened();
  push("/api/studio/output/stream", output({ destinations: [destination()] }));
  const bar = region("Studio top bar");
  expect(bar.queryByRole("group", { name: "Destinations" })).toBeNull();

  act(() => stream("/api/studio/output/stream").emitRaw(JSON.stringify(output({
    revision: 2, state: "live", started_at: 1000,
    destinations: [
      destination({ status: "live" }),
      destination({ id: "d2", name: "Twitch", platform: "twitch", status: "retrying", reason: "connection refused" }),
      destination({ id: "d3", name: "Facebook", platform: "facebook", enabled: false }),
    ],
  }))));
  const lights = within(bar.getByRole("group", { name: "Destinations" }));
  expect(lights.getByText("YouTube").nextElementSibling?.textContent).toBe("Live");
  expect(lights.getByText("Twitch").nextElementSibling?.textContent).toBe("Retrying");
  expect(lights.getByText("Twitch").parentElement?.title).toBe("connection refused");
  expect(lights.queryByText("Facebook")).toBeNull();
  expect(bar.getByText("LIVE")).toBeTruthy();
});

test("a broadcast's studio has backstage and a Guests tool, and who is on stage reaches the stage", () => {
  openedBroadcast({ people: peopleDoc({ stage: [{ id: "i1", name: "Sam", acs_id: null, present: true }] }) });
  expect(region("Backstage").getByRole("button", { name: "Join with camera" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Guests tool" })).toBeNull();
  openTool("Guests");
  expect(region("Guests tool").getByRole("button", { name: "Invite" })).toBeTruthy();
  expect(region("Stage").getByTestId("camera-tile").textContent).toContain("Sam");
});

test("backstage's invite tile opens the Guests tool, whose invites change the people shown", async () => {
  const server = openedBroadcast();
  fireEvent.click(region("Backstage").getByRole("button", { name: "Invite a guest" }));
  const tool = region("Guests tool");
  fireEvent.change(tool.getByLabelText("Name (optional)"), { target: { value: "Sam" } });
  server.people = peopleDoc({ revision: 2, invites: [invitation()] });
  fireEvent.click(tool.getByRole("button", { name: "Invite" }));
  expect(await region("Backstage").findByText("Sam")).toBeTruthy();
  expect(server.others.at(-1)).toMatchObject({ url: "/api/broadcasts/b1/people/invites", method: "POST", body: { role: "speaker", name: "Sam" } });
  expect(tool.getByLabelText("Invite link for Sam")).toBeTruthy();
});

test("the host's camera call carries on while tools and edit layout open and close", async () => {
  const call = new FakeRoomCall();
  room.call = call;
  openedBroadcast();
  fireEvent.click(region("Backstage").getByRole("button", { name: "Join with camera" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
  expect(await region("Backstage").findByRole("button", { name: "Mute" })).toBeTruthy();
  for (const tool of ["Guests", "Banners", "Comments", "Stream", "Stream"]) openTool(tool);
  openEditLayout();
  expect(screen.queryByRole("region", { name: "Backstage" })).toBeNull();
  closeEditLayout();
  expect(call.left).toBe(0);
  expect(call.joined).toHaveLength(1);
  expect(region("Backstage").getByRole("button", { name: "Mute" })).toBeTruthy();
});

test("a broadcast's studio has one Go live, in the top bar, which goes live with the broadcast", async () => {
  const server = openedBroadcast({ out: output({ destinations: [destination()] }) });
  openTool("Stream");
  const go = screen.getAllByRole("button", { name: "Go live" });
  expect(go).toHaveLength(1);
  expect(region("Studio top bar").getByRole("button", { name: "Go live" })).toBe(go[0]);
  expect(go[0].getAttribute("aria-disabled")).toBeNull();
  fireEvent.click(go[0]);
  await waitFor(() => expect(server.others).toContainEqual(expect.objectContaining({ url: "/api/broadcasts/b1/live", method: "POST" })));
  expect(server.calls.some((call) => call.url === "/api/studio/output/start")).toBe(false);
});

test("Go live waits for a destination when the broadcast does not record itself", () => {
  openedBroadcast({ item: broadcast({ record: false }), out: output({ destinations: [destination({ enabled: false })] }) });
  const go = region("Studio top bar").getByRole("button", { name: "Go live" });
  expect(go.getAttribute("aria-disabled")).toBe("true");
  expect(go.getAttribute("title")).toBe("Turn on a destination in the Stream tool first.");
});

test("the plain studio's one Go live is in the Stream tool", async () => {
  await opened();
  push("/api/studio/output/stream", output({ destinations: [destination()] }));
  expect(screen.queryByRole("button", { name: "Go live" })).toBeNull();
  openTool("Stream");
  expect(screen.getAllByRole("button", { name: "Go live" })).toHaveLength(1);
  expect(region("Stream tool").getByRole("button", { name: "Go live" })).toBeTruthy();
});

test("a widget is added to the scene with one click, at its own size, and its settings appear", async () => {
  const server = await opened();
  openEditLayout();
  const gallery = within(editLayout().getByRole("group", { name: "Widgets" }));
  expect(gallery.getAllByRole("button")).toHaveLength(11);
  fireEvent.click(gallery.getByRole("button", { name: "Add 3D pitch" }));
  await waitFor(() => expect(last(server).body.elements).toHaveLength(3));
  const added = last(server).body.elements[2];
  expect(added).toMatchObject({ type: "pitch3d", width: 900, height: 560, layer: 3, visible: true, props: { camera: "auto" } });
  expect(added.x + added.width).toBeLessThanOrEqual(1920);
  expect(added.y + added.height).toBeLessThanOrEqual(1080);

  fireEvent.click(gallery.getByRole("button", { name: "Add Graph" }));
  await waitFor(() => expect(last(server).body.elements.at(-1)).toMatchObject({ type: "graph", props: { metric: "momentum" } }));
});

test("a selected widget's settings change what it shows", async () => {
  const doc = studio();
  doc.scenes[0].elements.push(
    { id: "g", type: "graph", x: 0, y: 0, width: 760, height: 300, layer: 8, visible: true, props: { metric: "momentum" } },
    { id: "p", type: "player", x: 0, y: 400, width: 520, height: 440, layer: 9, visible: true, props: { player_id: null } },
  );
  const server = await opened(doc);
  openEditLayout();
  const layout = editLayout();
  fireEvent.click(layout.getByRole("button", { name: "Select graph" }));
  fireEvent.change(layout.getByLabelText("Over time"), { target: { value: "win_probability" } });
  await waitFor(() => expect(last(server).body.elements.find((item: any) => item.id === "g").props).toEqual({ metric: "win_probability" }));
  fireEvent.click(layout.getByRole("button", { name: "Select player" }));
  fireEvent.change(layout.getByLabelText("Player"), { target: { value: "hbc-9" } });
  await waitFor(() => expect(last(server).body.elements.find((item: any) => item.id === "p").props).toEqual({ player_id: "hbc-9" }));
});

test("the Comments tool shows the fan zone, and what it puts on screen appears on the stage", async () => {
  await opened();
  openTool("Comments");
  expect(region("Comments tool").getByText("Connecting to the fan zone…")).toBeTruthy();
  const winner = { id: "sp1", kind: "winner" as const, title: "Winner", text: "Picked from 12 commenters.", name: "Priya K", duration_s: 15, ends_at: 1010 };
  push("/api/fans/stream", fanZone({ spotlight: winner }));
  expect(within(screen.getByTestId("fan-on-air")).getByText("Priya K")).toBeTruthy();
  // The scene on air has no spotlight element, so the program gives it a box.
  expect(region("Stage").getByTestId("spotlight-name").textContent).toBe("🏆 Priya K");
  openEditLayout();
  expect(editLayout().queryByTestId("program-spotlight")).toBeNull();
});

test("comments that arrive while the Comments tool is closed are counted on the rail", async () => {
  await opened();
  push("/api/fans/stream", fanZone({ comments: [fanComment()] }));
  const comments = () => within(screen.getByRole("navigation", { name: "Tools" })).getByRole("button", { name: "Comments" });
  expect(comments().textContent).toBe("Comments");
  act(() => stream("/api/fans/stream").emitRaw(JSON.stringify(fanZone({ revision: 2, comments: [fanComment(), fanComment({ id: "c2", at: 1001 })] }))));
  expect(comments().textContent).toBe("Comments1");
  openTool("Comments");
  expect(comments().textContent).toBe("Comments");
  openTool("Comments");
  expect(comments().textContent).toBe("Comments");
});
