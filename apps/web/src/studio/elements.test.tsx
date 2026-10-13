import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { act, screen, waitFor } from "@testing-library/react";
import type { SceneElement } from "../contracts";
import { EMPTY, type MatchData } from "../stream/store";
import { element, matchEvent, narrative, recap, stats, status, studio } from "../test/fixtures";
import { renderUi } from "../test/render";
import { ElementView, type ProgramData } from "./elements";

const live: MatchData = {
  ...EMPTY, minute: 37, status: status({ score_home: 2, score_away: 1, minute: 30 }), stats: stats({ shots: 7 }, { shots: 2 }),
  narratives: [
    { ...narrative({ id: "n3", minute: 37, text: "Third line" }), highlighted: false },
    { ...narrative({ id: "n2", minute: 30, text: "Second line" }), highlighted: false },
    { ...narrative({ id: "n1", minute: 12, text: "First line" }), highlighted: false },
  ],
  recaps: [recap()],
};

function show(type: SceneElement["type"], over: Partial<ProgramData> = {}, props: Record<string, unknown> = {}) {
  const data: ProgramData = { match: live, studio: studio(), now: 1000, language: "en", ...over };
  return renderUi(<ElementView element={element({ type, props })} data={data} />);
}

test("the scoreboard shows teams, score and the running clock", () => {
  show("scoreboard");
  expect(screen.getByTestId("program-score").textContent).toBe("2 - 1");
  expect(screen.getByText("Northbridge FC")).toBeTruthy();
  expect(screen.getByText("37'")).toBeTruthy();
});

test("the scoreboard holds its box when there is no match", () => {
  show("scoreboard", { match: EMPTY });
  expect(screen.getByTestId("program-score").textContent).toBe("–");
});

test("narration shows the newest lines up to the number asked for", () => {
  show("narration", {}, { lines: 2 });
  expect(screen.getByText("Third line")).toBeTruthy();
  expect(screen.getByText("Second line")).toBeTruthy();
  expect(screen.queryByText("First line")).toBeNull();
});

test("narration with nothing to say explains itself in the program language", () => {
  show("narration", { match: EMPTY, language: "es" });
  expect(screen.getByText("Las narraciones aparecen aquí cuando ocurren momentos clave.")).toBeTruthy();
});

test("the banner shows the current message with its kind, and nothing when there is none", () => {
  const { unmount } = show("banner", { studio: studio({ banner: { id: "b", text: "GOAL!", kind: "goal", duration_s: 8, ends_at: 1008, source_id: null } }) });
  expect(screen.getByTestId("program-banner").textContent).toBe("GOAL!");
  expect(screen.getByTestId("program-banner").getAttribute("data-kind")).toBe("goal");
  unmount();
  show("banner");
  expect(screen.queryByTestId("program-banner")).toBeNull();
});

test("the ticker scrolls its items and is empty when switched off", () => {
  const { unmount } = show("ticker", { studio: studio({ ticker: { ...studio().ticker, messages: ["Welcome"] } }) });
  expect(screen.getByTestId("program-ticker").textContent).toContain("Welcome");
  expect(screen.getByTestId("program-ticker").textContent).toContain("Northbridge FC 2-1 Harbour City");
  unmount();
  show("ticker", { studio: studio({ ticker: { ...studio().ticker, enabled: false } }) });
  expect(screen.queryByTestId("program-ticker")).toBeNull();
});

test("the countdown shows the time left on the server's clock", () => {
  const counting = studio({ countdown: { kind: "break", ends_at: 1125, label: "" } });
  const { unmount } = show("countdown", { studio: counting, now: 1000 });
  expect(screen.getByTestId("program-countdown").textContent).toBe("Back in2:05");
  unmount();
  show("countdown", { studio: counting, now: 5000 });
  expect(screen.getByTestId("program-countdown").textContent).toBe("Back in0:00");
});

test("with no countdown running the element is empty", () => {
  show("countdown");
  expect(screen.queryByTestId("program-countdown")).toBeNull();
});

test("the recap shows the latest recap, and nothing before one exists", () => {
  const { unmount } = show("recap");
  expect(screen.getByTestId("program-recap").textContent).toContain("Half-time: Northbridge FC 1-0 Harbour City");
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  unmount();
  show("recap", { match: EMPTY });
  expect(screen.queryByTestId("program-recap")).toBeNull();
});

test("text is drawn with its size and alignment", () => {
  show("text", {}, { text: "Kick-off soon", size: 96, align: "left" });
  const text = screen.getByText("Kick-off soon");
  expect(text.style.fontSize).toBe("96px");
  expect(text.style.textAlign).toBe("left");
});

test("an image is drawn from the image store, and a missing one shows a placeholder", () => {
  const { unmount } = show("image", {}, { image_id: "abc.png", fit: "cover" });
  const image = screen.getByTestId("program-image") as HTMLImageElement;
  expect(image.getAttribute("src")).toBe("/api/studio/images/abc.png");
  expect(image.style.objectFit).toBe("cover");
  act(() => image.dispatchEvent(new Event("error")));
  expect(screen.queryByTestId("program-image")).toBeNull();
  unmount();
  show("image", {}, { image_id: null, fit: "contain" });
  expect(screen.queryByTestId("program-image")).toBeNull();
});

test("stats, pitch and timeline are drawn from the match", () => {
  show("stats");
  expect(screen.getByTestId("stat-shots").textContent).toContain("7");
  show("pitch", { match: { ...live, events: [matchEvent()] } }, { pressure: true });
  expect(screen.getAllByTestId("marker")).toHaveLength(1);
  show("timeline");
  const marker = screen.getByTitle("Half-time recap");
  expect(marker.closest("[inert]")).not.toBeNull();
});

test("a replay fetches the moment's events and reveals them as it plays", async () => {
  const events = Array.from({ length: 4 }, (_, index) => matchEvent({ id: `e${index}`, seq: index }));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ moment: {}, events }), { status: 200 })));
  const replay = { match_id: "m-1", moment_id: "m-1-k1", minute: 23, started_at: 1000, duration_s: 8 };
  const { rerender } = show("replay", { studio: studio({ replay }), now: 1002 });
  await waitFor(() => expect(screen.getAllByTestId("marker")).toHaveLength(1));
  expect(screen.getByTestId("program-replay").textContent).toContain("Replay · 23'");
  const later: ProgramData = { match: live, studio: studio({ replay }), now: 1008, language: "en" };
  // Re-render inside the same provider, so the element keeps its state and does not fetch again.
  rerender(
    <FluentProvider theme={webLightTheme}>
      <ElementView element={element({ type: "replay", props: {} })} data={later} />
    </FluentProvider>,
  );
  expect(screen.getAllByTestId("marker")).toHaveLength(4);
});

test("with no replay playing the element is empty", () => {
  show("replay");
  expect(screen.queryByTestId("program-replay")).toBeNull();
});

test("the cameras element tiles the people on stage with name tags and their video", () => {
  const rendered: string[] = [];
  const renderVideo = (acsId: string, box: HTMLElement) => {
    rendered.push(acsId);
    box.setAttribute("data-video", acsId);
    return () => box.removeAttribute("data-video");
  };
  const cameras = [
    { id: "i1", name: "Sam Lee", acsId: "8:acs:1", present: true },
    { id: "host", name: "Alex", acsId: null, present: false },
    { id: "i2", name: "Kim", acsId: "8:acs:2", present: true },
  ];
  show("cameras", { cameras, renderVideo }, { names: true });
  const grid = screen.getByTestId("program-cameras");
  expect([grid.style.gridTemplateColumns, grid.style.gridTemplateRows]).toEqual(["repeat(2, 1fr)", "repeat(2, 1fr)"]);
  expect(screen.getAllByTestId("camera-tile")).toHaveLength(3);
  expect(rendered).toEqual(["8:acs:1", "8:acs:2"]);
  expect(screen.getByText("Alex · away")).toBeTruthy();
  expect(screen.getByText("SL")).toBeTruthy();
});

test("one person on stage fills the box, and name tags can be switched off", () => {
  show("cameras", { cameras: [{ id: "i1", name: "Sam", acsId: null, present: true }] }, { names: false });
  const grid = screen.getByTestId("program-cameras");
  expect([grid.style.gridTemplateColumns, grid.style.gridTemplateRows]).toEqual(["repeat(1, 1fr)", "repeat(1, 1fr)"]);
  expect(screen.queryByText("Sam")).toBeNull();
});

test("with no one on stage the cameras element shows nothing", () => {
  show("cameras");
  expect(screen.queryByTestId("program-cameras")).toBeNull();
});
