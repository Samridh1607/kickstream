import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { AutoLive } from "../contracts";
import { useMatch } from "../stream/store";
import { autoLive, autoLiveSettings, FakeEventSource, FakeEventSourceCtor, studio } from "../test/fixtures";
import { renderUi } from "../test/render";
import { AutoLiveOutput, AutoLivePage } from "./AutoLivePage";
import type { SpeakerDeps } from "./speaker";

const stream = (path: string) => FakeEventSource.instances.filter((source) => source.url.startsWith(path) && !source.closed).at(-1);

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function serve(reply: (call: Call) => unknown = () => autoLive()) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : null };
    if (url === "/api/matches/current") return new Response("{}", { status: 404 });
    calls.push(call);
    return new Response(JSON.stringify(reply(call)), { status: 200 });
  }));
  return calls;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  useMatch.setState({ data: useMatch.getInitialState().data, connection: "idle", selectedId: null });
});

const push = (doc: AutoLive) =>
  act(() => {
    const live = stream("/api/autolive/stream")!;
    live.open();
    live.emitRaw(JSON.stringify(doc));
  });

const pushStudio = () =>
  act(() => {
    const source = stream("/api/studio/stream")!;
    source.open();
    source.emitRaw(JSON.stringify(studio()));
  });

function silentVoice() {
  const said: string[] = [];
  const deps: Partial<SpeakerDeps> = {
    fetchSpeech: async () => {
      throw new Error("Azure Speech is not set up.");
    },
    audio: () => null,
    synth: () =>
      ({
        getVoices: () => [],
        speak: (utterance: { text: string; onend?: () => void }) => {
          said.push(utterance.text);
          queueMicrotask(() => utterance.onend?.());
        },
        cancel: () => {},
      }) as unknown as SpeechSynthesis,
    Utterance: class {
      constructor(public text: string) {}
    } as unknown as typeof SpeechSynthesisUtterance,
  };
  return { said, deps };
}

test("the output shows the screen on air under the live header, and moves to the next with its transition", () => {
  serve();
  const { deps } = silentVoice();
  renderUi(<AutoLiveOutput eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} speech={deps} />);
  expect(screen.getByTestId("autolive-output").textContent).toBe("");
  push(autoLive());
  pushStudio();
  expect(screen.getByTestId("autolive-title").textContent).toBe("Welcome");
  expect(screen.getByTestId("autolive-header").textContent).toContain("LIVE");
  expect(screen.getByTestId("element-scoreboard")).toBeTruthy();
  expect(screen.queryAllByRole("button")).toHaveLength(0);

  push(autoLive({ revision: 2, scene_id: "agent-tactics", transition: "iris" }));
  expect(screen.getByTestId("autolive-title").textContent).toBe("Tactical Analyst");
  expect(screen.getByTestId("autolive-header").textContent).toContain("AI agent");
  expect(screen.getByTestId("autolive-stage").getAttribute("data-transition")).toBe("iris");
  expect(screen.getByTestId("element-countdown")).toBeTruthy();
});

test("the output speaks each new commentary line once, with captions, and not a stale one it opens on", async () => {
  serve();
  const { said, deps } = silentVoice();
  renderUi(<AutoLiveOutput eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} speech={deps} />);
  const old = { id: "c0", scene_id: "welcome", text: "An old line.", source: "scripted" as const, at: 900 };
  push(autoLive({ commentary: old }));
  pushStudio();
  await act(async () => {});
  expect(said).toEqual([]);

  const line = { id: "c1", scene_id: "welcome", text: "Here's the Welcome card. Northbridge lead.", source: "model" as const, at: 1000 };
  push(autoLive({ revision: 2, commentary: line }));
  await waitFor(() => expect(said).toEqual([line.text]));
  push(autoLive({ revision: 3, commentary: line, matches_started: 1 }));
  await act(async () => {});
  expect(said).toEqual([line.text]);
});

test("with auto live off the output stays quiet", async () => {
  serve();
  const { said, deps } = silentVoice();
  renderUi(<AutoLiveOutput eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} speech={deps} />);
  push(autoLive({ settings: autoLiveSettings({ enabled: false }) }));
  pushStudio();
  push(autoLive({ revision: 2, settings: autoLiveSettings({ enabled: false }), commentary: { id: "c1", scene_id: "welcome", text: "Hello.", source: "scripted", at: 1000 } }));
  await act(async () => {});
  expect(said).toEqual([]);
});

test("the control page switches auto live, sets the minutes and the stream, and puts a screen on air", async () => {
  const calls = serve(() => autoLive({ revision: 9 }));
  const { deps } = silentVoice();
  renderUi(<AutoLivePage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} speech={deps} />);
  push(autoLive({ settings: autoLiveSettings({ enabled: false }) }));
  pushStudio();

  fireEvent.click(screen.getByRole("switch", { name: "Auto live" }));
  await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "PUT", url: "/api/autolive/settings", body: { enabled: true } }));

  push(autoLive({ revision: 10 }));
  const shortest = screen.getByRole("spinbutton", { name: /Shortest time/ });
  fireEvent.change(shortest, { target: { value: "6" } });
  fireEvent.blur(shortest);
  await waitFor(() => expect(calls.at(-1)?.body).toMatchObject({ min_minutes: 6, max_minutes: 10 }));

  const before = calls.length;
  fireEvent.change(shortest, { target: { value: "11" } });
  fireEvent.blur(shortest);
  expect(calls).toHaveLength(before);

  fireEvent.click(screen.getByRole("switch", { name: "Stream 24/7" }));
  await waitFor(() => expect(calls.at(-1)?.body).toMatchObject({ stream: true }));

  fireEvent.click(screen.getByRole("button", { name: "Show Tactical Analyst now" }));
  await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "POST", url: "/api/autolive/scenes/agent-tactics/show" }));

  fireEvent.click(screen.getByRole("checkbox", { name: "Tactical Analyst" }));
  await waitFor(() => expect(calls.at(-1)?.body).toMatchObject({ scenes: ["welcome"] }));
});

test("the control page shows the commentary as captions while its sound is off, and how Azure Speech stands", () => {
  serve();
  const { deps } = silentVoice();
  renderUi(<AutoLivePage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} speech={deps} />);
  const line = { id: "c1", scene_id: "welcome", text: "Over to the Welcome card.", source: "model" as const, at: Date.now() / 1000 };
  push(autoLive({ server_time: Date.now() / 1000, commentary: line }));
  pushStudio();
  expect(screen.getByTestId("autolive-caption").textContent).toContain("Over to the Welcome card.");
  expect(screen.getByText(/Azure Speech · centralindia/)).toBeTruthy();
  expect(screen.getByText(/120 of [\d,.\s]+ Azure Speech characters/)).toBeTruthy();
});
