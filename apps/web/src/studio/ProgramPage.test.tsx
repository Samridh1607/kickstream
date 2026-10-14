import { act, screen, waitFor } from "@testing-library/react";
import { useMatch } from "../stream/store";
import { FakeRoomCall } from "../test/FakeRoomCall";
import {
  broadcast, broadcasts, callSeat, element, envelope, FakeEventSource, FakeEventSourceCtor, peopleDoc, scene, status, studio,
} from "../test/fixtures";
import { renderUi } from "../test/render";
import { isOutputView, ProgramPage, withReplayFallback } from "./ProgramPage";

const stream = (path: string) => FakeEventSource.instances.filter((source) => source.url.startsWith(path) && !source.closed).at(-1);

test("the studio shows its clean output when asked for it, or when the pipeline opens it to record", () => {
  expect(isOutputView("?output")).toBe(true);
  expect(isOutputView("?output=&capture=t1")).toBe(true);
  expect(isOutputView("?capture=t1")).toBe(true);
  expect(isOutputView("")).toBe(false);
  expect(isOutputView("?tab=banner")).toBe(false);
});

function serve(current: string | null) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const reply = (statusCode: number, body: unknown) => new Response(JSON.stringify(body), { status: statusCode });
    if (url === "/api/matches/current") return current ? reply(200, { match_id: current }) : reply(404, {});
    return reply(404, {});
  }));
}

beforeEach(() => {
  FakeEventSource.instances = [];
  useMatch.setState({ data: useMatch.getInitialState().data, connection: "idle", selectedId: null });
});

const push = (doc: ReturnType<typeof studio>) =>
  act(() => {
    const source = stream("/api/studio/stream")!;
    source.open();
    source.emitRaw(JSON.stringify(doc));
  });

test("before the studio document arrives the page is blank, with no controls", () => {
  serve(null);
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  expect(screen.getByTestId("program").textContent).toBe("");
  expect(screen.queryAllByRole("button")).toHaveLength(0);
});

test("it shows the active scene and cuts when the active scene changes", () => {
  serve(null);
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push(studio());
  expect(screen.getByTestId("element-scoreboard")).toBeTruthy();
  expect(screen.queryByTestId("element-countdown")).toBeNull();
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  push(studio({ revision: 2, active_scene_id: "s2" }));
  expect(screen.getByTestId("element-countdown")).toBeTruthy();
  expect(screen.queryByTestId("element-scoreboard")).toBeNull();
});

test("with no match the scene still holds its elements in place", () => {
  serve(null);
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push(studio());
  expect(screen.getByTestId("program-score").textContent).toBe("–");
  expect(screen.getByTestId("element-banner").style.width).toBe("700px");
});

test("it follows the current match in the studio's mode and language", async () => {
  serve("m-1");
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push(studio({ settings: { ...studio().settings, mode: "analyst", language: "es" } }));
  await waitFor(() => expect(stream("/api/matches/")?.url).toBe("/api/matches/m-1/stream?mode=analyst&lang=es"));
  act(() => {
    const match = stream("/api/matches/")!;
    match.open();
    match.emit(envelope(1, "match_status", status({ score_home: 3 })));
  });
  expect(screen.getByTestId("program-score").textContent).toBe("3 - 0");
});

test("the program credits the data of the match it is showing", async () => {
  serve("m-1");
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push(studio());
  await waitFor(() => expect(stream("/api/matches/")).toBeTruthy());
  expect(screen.queryByTestId("program-credit")).toBeNull();
  act(() => {
    const match = stream("/api/matches/")!;
    match.open();
    match.emit(envelope(1, "match_status", status({ source: "statsbomb", credit: "Data: StatsBomb" })));
  });
  expect(screen.getByTestId("program-credit").textContent).toBe("Data: StatsBomb");
});

test("cutting to a Fan or Analyst scene switches the commentary to that scene's", async () => {
  serve("m-1");
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  const fanAndAnalyst = [scene({ mode: "fan" }), scene({ id: "s2", name: "Analyst desk", template: "Analyst desk", mode: "analyst" })];
  push(studio({ scenes: [fanAndAnalyst[0], fanAndAnalyst[1]], settings: { ...studio().settings, mode: "analyst" } }));
  await waitFor(() => expect(stream("/api/matches/")?.url).toBe("/api/matches/m-1/stream?mode=fan&lang=en"));
  push(studio({ revision: 2, scenes: [fanAndAnalyst[0], fanAndAnalyst[1]], active_scene_id: "s2" }));
  await waitFor(() => expect(stream("/api/matches/")?.url).toBe("/api/matches/m-1/stream?mode=analyst&lang=en"));
});

test("a banner from the studio appears on the program", () => {
  serve(null);
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push(studio());
  expect(screen.queryByTestId("program-banner")).toBeNull();
  push(studio({ revision: 2, banner: { id: "b", text: "Welcome", kind: "custom", duration_s: 8, ends_at: 1008, source_id: null } }));
  expect(screen.getByTestId("program-banner").textContent).toBe("Welcome");
});

test("a scene without a replay element gets one while a replay is playing", () => {
  const replay = { match_id: "m-1", moment_id: "m-1-k1", minute: 23, started_at: 1000, duration_s: 8 };
  const plain = scene();
  expect(withReplayFallback(plain, studio())).toBe(plain);
  const added = withReplayFallback(plain, studio({ replay }));
  expect(added.elements).toHaveLength(plain.elements.length + 1);
  expect(added.elements.at(-1)).toMatchObject({ type: "replay", visible: true });
  expect(added.elements.at(-1)!.layer).toBeGreaterThan(Math.max(...plain.elements.map((item) => item.layer)));

  const own = scene({ elements: [element({ id: "r", type: "replay", props: {} })] });
  expect(withReplayFallback(own, studio({ replay }))).toBe(own);
  const hidden = scene({ elements: [element({ id: "r", type: "replay", visible: false, props: {} })] });
  expect(withReplayFallback(hidden, studio({ replay })).elements).toHaveLength(2);
});

test("after the stream is refused the page reconnects and takes the server's document", async () => {
  serve(null);
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  push(studio({ revision: 40 }));
  const first = stream("/api/studio/stream")!;
  act(() => first.fail(2));
  await waitFor(() => expect(stream("/api/studio/stream")).not.toBe(first));
  expect(screen.getByTestId("element-scoreboard")).toBeTruthy();
  push(studio({ revision: 0, active_scene_id: "s2" }));
  expect(screen.getByTestId("element-countdown")).toBeTruthy();
});

test("the page offers to record itself only when opened with a capture token, and only once it has the studio", async () => {
  serve(null);
  const page = window as unknown as { __kickstreamStartCapture?: () => Promise<void> };
  const capture = vi.fn(async () => () => {});
  window.history.pushState({}, "", "/studio?output&capture=run-token");
  try {
    renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10_000} capture={capture} />);
    expect(page.__kickstreamStartCapture).toBeUndefined();
    push(studio());
    expect(typeof page.__kickstreamStartCapture).toBe("function");
    await page.__kickstreamStartCapture!();
    expect(capture).toHaveBeenCalledWith("run-token", { width: window.innerWidth, height: window.innerHeight });
  } finally {
    window.history.pushState({}, "", "/studio?output");
  }
});

test("without a capture token the page never offers to record itself", () => {
  serve(null);
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10_000} />);
  push(studio());
  expect((window as unknown as { __kickstreamStartCapture?: unknown }).__kickstreamStartCapture).toBeUndefined();
});

test("a second call shares the running capture, unmounting stops it, and the function goes away", async () => {
  serve(null);
  const page = window as unknown as { __kickstreamStartCapture?: () => Promise<void> };
  const stop = vi.fn();
  const capture = vi.fn(async () => stop);
  window.history.pushState({}, "", "/studio?output&capture=run-token");
  try {
    const view = renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10_000} capture={capture} />);
    push(studio());
    const first = page.__kickstreamStartCapture!();
    const second = page.__kickstreamStartCapture!();
    expect(second).toBe(first);
    await first;
    await page.__kickstreamStartCapture!();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    view.unmount();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(page.__kickstreamStartCapture).toBeUndefined();
  } finally {
    window.history.pushState({}, "", "/studio?output");
  }
});

test("after a failed capture a later call may try again", async () => {
  serve(null);
  const page = window as unknown as { __kickstreamStartCapture?: () => Promise<void> };
  const capture = vi.fn().mockRejectedValueOnce(new Error("refused")).mockResolvedValue(() => {});
  window.history.pushState({}, "", "/studio?output&capture=run-token");
  try {
    renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10_000} capture={capture} />);
    push(studio());
    await expect(page.__kickstreamStartCapture!()).rejects.toThrow("refused");
    await page.__kickstreamStartCapture!();
    expect(capture).toHaveBeenCalledTimes(2);
  } finally {
    window.history.pushState({}, "", "/studio?output");
  }
});

function serveSeats() {
  const asked: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    asked.push(url);
    if (url.endsWith("/program/seat")) return new Response(JSON.stringify(callSeat({ acs_id: "8:fake:program" })), { status: 200 });
    return new Response("{}", { status: 404 });
  }));
  return asked;
}

function showWithGuests(call: FakeRoomCall, connectAudio = vi.fn(() => () => {})) {
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} newCall={() => call} connectAudio={connectAudio} rejoinMs={10} />);
  push(studio());
  act(() => {
    const doc = stream("/api/broadcasts/stream")!;
    doc.open();
    doc.emitRaw(JSON.stringify(broadcasts({ broadcasts: [broadcast({ state: "live" })], current_id: "b1" })));
  });
  act(() => {
    const doc = stream("/api/broadcasts/b1/people/stream")!;
    doc.open();
    doc.emitRaw(JSON.stringify(peopleDoc({ stage: [{ id: "i1", name: "Sam", acs_id: "8:fake:2", present: true }] })));
  });
  return connectAudio;
}

test("the program joins the room of the broadcast on air, shows who is on stage and carries their voices", async () => {
  const asked = serveSeats();
  const call = new FakeRoomCall();
  call.audio = {} as MediaStream;
  const connectAudio = showWithGuests(call);
  await waitFor(() => expect(call.joined).toHaveLength(1));
  expect(asked).toContain("/api/broadcasts/b1/people/program/seat");
  expect(call.joined[0]).toMatchObject({ roomId: "room-1", token: "t1", name: "Program", receiveOnly: true });
  expect(screen.getByTestId("camera-tile").textContent).toContain("Sam");
  await waitFor(() => expect(call.rendered).toContain("8:fake:2"));
  await waitFor(() => expect(connectAudio).toHaveBeenCalledWith(call.audio));
});

test("the program rejoins by itself when the call drops", async () => {
  serveSeats();
  const call = new FakeRoomCall();
  showWithGuests(call);
  await waitFor(() => expect(call.joined).toHaveLength(1));
  act(() => call.drop());
  await waitFor(() => expect(call.joined).toHaveLength(2));
});

test("with no room the program joins nothing", async () => {
  serveSeats();
  const call = new FakeRoomCall();
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} newCall={() => call} />);
  push(studio());
  act(() => {
    const doc = stream("/api/broadcasts/stream")!;
    doc.open();
    doc.emitRaw(JSON.stringify(broadcasts({ broadcasts: [broadcast()], current_id: "b1" })));
  });
  act(() => {
    const doc = stream("/api/broadcasts/b1/people/stream")!;
    doc.open();
    doc.emitRaw(JSON.stringify(peopleDoc({ room_id: null })));
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(call.joined).toHaveLength(0);
});
