import { act, screen, waitFor } from "@testing-library/react";
import { useMatch } from "../stream/store";
import {
  element, envelope, FakeEventSource, FakeEventSourceCtor, scene, status, studio,
} from "../test/fixtures";
import { renderUi } from "../test/render";
import { ProgramPage, withReplayFallback } from "./ProgramPage";

const stream = (path: string) => FakeEventSource.instances.filter((source) => source.url.startsWith(path) && !source.closed).at(-1);

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
