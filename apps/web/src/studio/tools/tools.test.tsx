import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { People, QueuedMatch, Sources, Studio } from "../../contracts";
import { renderUi } from "../../test/render";
import { invitation, output, peopleDoc, studio } from "../../test/fixtures";
import { SETUP } from "../../people/PeoplePanel";
import { BannersTool } from "./BannersTool";
import { GuestsTool } from "./GuestsTool";
import { MatchTool } from "./MatchTool";
import { StreamTool } from "./StreamTool";

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

function serve(answer: People = peopleDoc()) {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(answer), { status: 200 });
  }));
  return sent;
}

function showBanners() {
  const props = { onShow: vi.fn(async () => true), onClear: vi.fn(), onAuto: vi.fn(), onSaveTicker: vi.fn() };
  renderUi(<BannersTool studio={studio()} {...props} />);
  return props;
}

/** Runs each request as the studio page does and reports whether it was accepted. */
function showGuests(people: People | null) {
  const onRun = vi.fn(async (request: () => Promise<People>) => {
    await request();
    return true;
  });
  renderUi(<GuestsTool broadcastId="b1" people={people} onRun={onRun} />);
  return onRun;
}

test("the banners tool shows the banner and the ticker, and shows the banner typed", async () => {
  const { onShow } = showBanners();
  expect(screen.getByRole("region", { name: "Banner" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Ticker" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Banner text"), { target: { value: "Half-time" } });
  fireEvent.click(screen.getByRole("button", { name: "Show banner" }));
  await waitFor(() => expect(onShow).toHaveBeenCalledWith("Half-time"));
});

test("saving the ticker sends one message per line", () => {
  const { onSaveTicker } = showBanners();
  fireEvent.change(screen.getByLabelText("Messages, one per line"), { target: { value: "Welcome\n\n  Kick-off at 3  " } });
  fireEvent.click(screen.getByRole("button", { name: "Save ticker" }));
  expect(onSaveTicker).toHaveBeenCalledWith(expect.objectContaining({ messages: ["Welcome", "Kick-off at 3"] }));
});

test("the guests tool invites someone with a role and a name, then clears the name", async () => {
  const sent = serve();
  const onRun = showGuests(peopleDoc());
  fireEvent.change(screen.getByLabelText("Role"), { target: { value: "cohost" } });
  fireEvent.change(screen.getByLabelText("Name (optional)"), { target: { value: "Kim" } });
  fireEvent.click(screen.getByRole("button", { name: "Invite" }));
  await waitFor(() => expect(onRun).toHaveBeenCalled());
  expect(sent.at(-1)).toMatchObject({ url: "/api/broadcasts/b1/people/invites", method: "POST", body: { role: "cohost", name: "Kim" } });
  await waitFor(() => expect((screen.getByLabelText("Name (optional)") as HTMLInputElement).value).toBe(""));
});

test("revoking an invite from the guests tool stops the link", async () => {
  const sent = serve();
  const onRun = showGuests(peopleDoc({ invites: [invitation()] }));
  const guests = within(screen.getByRole("list", { name: "Guests" }));
  expect((guests.getByLabelText("Invite link for Sam") as HTMLInputElement).value).toBe("https://guests.example/guest/abc");
  fireEvent.click(guests.getByRole("button", { name: "Revoke invite for Sam" }));
  await waitFor(() => expect(onRun).toHaveBeenCalled());
  expect(sent.at(-1)).toMatchObject({ url: "/api/broadcasts/b1/people/invites/i1", method: "DELETE" });
});

test("each invite shows its public link to copy, its role and whether the guest is here", () => {
  serve();
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const joinedSam = invitation({ joined_name: "Sam", acs_id: "8:fake:2", present: true });
  showGuests(peopleDoc({ invites: [joinedSam, invitation({ id: "i2", role: "member", name: "Mia", link: "/guest/def" })] }));
  const guests = within(screen.getByRole("list", { name: "Guests" }));
  fireEvent.click(guests.getByRole("button", { name: "Copy link for Sam" }));
  expect(writeText).toHaveBeenCalledWith("https://guests.example/guest/abc");
  expect(guests.getByText("Present")).toBeTruthy();
  expect(guests.getByText("Not joined yet")).toBeTruthy();
  expect(guests.getByText("Member")).toBeTruthy();
});

test("a link that cannot be copied is explained", async () => {
  serve();
  const writeText = vi.fn(async () => {
    throw new Error("Denied");
  });
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  showGuests(peopleDoc({ invites: [invitation()] }));
  fireEvent.click(screen.getByRole("button", { name: "Copy link for Sam" }));
  expect(await screen.findByText("The link could not be copied. Select it and copy it yourself.")).toBeTruthy();
});

test("with no calling service the guests tool says how to set one up", () => {
  showGuests(peopleDoc({ service: null }));
  expect(screen.getByText(SETUP)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
});

const SIMULATED = { id: "simulated", name: "Simulated", kind: "simulated", detail: "full", available: true } as const;

/**
 * Answers /api/sources with each of `answers` in turn, staying on the last, stop with 204, a start with a new match,
 * and a studio change with the studio.
 */
function serveSources(...answers: Sources[]) {
  const sent: Sent[] = [];
  let read = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (url === "/api/matches/stop") return new Response(null, { status: 204 });
    if (url === "/api/matches") return new Response(JSON.stringify({ match_id: "m-2" }), { status: 201 });
    if (url.startsWith("/api/studio")) return new Response(JSON.stringify(studio()), { status: 200 });
    return new Response(JSON.stringify(answers[Math.min(read++, answers.length - 1)]), { status: 200 });
  }));
  return sent;
}

/** Runs each studio change as the studio page does. */
const studioRuns = () => vi.fn(async (request: () => Promise<Studio>) => {
  await request();
  return true;
});

const queuing = (sent: Sent[]) => sent.filter((call) => call.url === "/api/studio/queued-match");
const withQueued = (queued_match: QueuedMatch | null) => studio({ settings: { ...studio().settings, queued_match } });

test("the Match tool shows the running match, its problem, and stops it", async () => {
  const problem = "API-Football could not be reached. Kickstream will keep trying.";
  const running = { match_id: "m-3", source: "api_football", ref: "1", title: "Arsenal vs Chelsea", problem } as const;
  const sent = serveSources({ sources: [SIMULATED], running }, { sources: [SIMULATED], running: null });
  renderUi(<MatchTool studio={studio()} onRun={studioRuns()} onStarted={vi.fn()} />);
  const playing = within(await screen.findByRole("region", { name: "Now playing" }));
  expect(playing.getByText("Arsenal vs Chelsea")).toBeTruthy();
  expect(playing.getByText("API-Football live")).toBeTruthy();
  expect(playing.getByText(problem)).toBeTruthy();
  expect(screen.getByRole("radio", { name: "Simulated match" })).toBeTruthy();

  fireEvent.click(playing.getByRole("button", { name: "Stop match" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull());
  expect(sent.filter((call) => call.url === "/api/matches/stop")).toEqual([{ url: "/api/matches/stop", method: "POST", body: undefined }]);
  expect(sent.filter((call) => call.url === "/api/sources")).toHaveLength(2);
});

test("the Match tool reads the sources again every so often", async () => {
  const sent = serveSources({ sources: [SIMULATED], running: null });
  renderUi(<MatchTool studio={studio()} onRun={studioRuns()} onStarted={vi.fn()} pollMs={10} />);
  await waitFor(() => expect(sent.filter((call) => call.url === "/api/sources").length).toBeGreaterThanOrEqual(3));
});

test("the Match tool shows the match the countdown will start, and clears it", async () => {
  const sent = serveSources({ sources: [SIMULATED], running: null });
  const onRun = studioRuns();
  const queued = { source: "statsbomb", ref: "43/3/8658", speed: 10, title: "France vs Croatia" } as const;
  renderUi(<MatchTool studio={withQueued(queued)} onRun={onRun} onStarted={vi.fn()} />);
  const next = within(screen.getByRole("region", { name: "Next match" }));
  expect(next.getByText("Starts when the countdown ends")).toBeTruthy();
  expect(next.getByText("France vs Croatia")).toBeTruthy();
  expect(next.getByText("StatsBomb replay · 10×")).toBeTruthy();

  fireEvent.click(next.getByRole("button", { name: "Clear" }));
  await waitFor(() => expect(onRun).toHaveBeenCalled());
  expect(queuing(sent)).toEqual([{ url: "/api/studio/queued-match", method: "PUT", body: null }]);
});

test("with nothing chosen the Match tool shows no next match", async () => {
  serveSources({ sources: [SIMULATED], running: null });
  renderUi(<MatchTool studio={studio()} onRun={studioRuns()} onStarted={vi.fn()} />);
  await screen.findByRole("radio", { name: "Simulated match" });
  expect(screen.queryByRole("region", { name: "Next match" })).toBeNull();
});

test("choosing in the picker keeps the choice for the countdown without starting it", async () => {
  const sent = serveSources({ sources: [SIMULATED], running: null });
  renderUi(<MatchTool studio={studio()} onRun={studioRuns()} onStarted={vi.fn()} />);
  await screen.findByRole("radio", { name: "Simulated match" });
  expect(queuing(sent)).toEqual([]);
  fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "10" } });
  await waitFor(() => expect(queuing(sent)).toEqual([
    { url: "/api/studio/queued-match", method: "PUT", body: { source: "simulated", ref: null, speed: 10, title: null } },
  ]));
  expect(sent.filter((call) => call.url === "/api/matches")).toEqual([]);
});

test("a match started from the tool is kept for the countdown too, unless it already is", async () => {
  const sent = serveSources({ sources: [SIMULATED], running: null });
  const onStarted = vi.fn();
  const view = renderUi(<MatchTool studio={studio()} onRun={studioRuns()} onStarted={onStarted} />);
  fireEvent.click(await screen.findByRole("button", { name: "Start match" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith("m-2"));
  const simulated = { source: "simulated", ref: null, speed: 30, title: null } as const;
  await waitFor(() => expect(queuing(sent)).toEqual([{ url: "/api/studio/queued-match", method: "PUT", body: simulated }]));

  view.unmount();
  sent.length = 0;
  renderUi(<MatchTool studio={withQueued(simulated)} onRun={studioRuns()} onStarted={onStarted} />);
  fireEvent.click(await screen.findByRole("button", { name: "Start match" }));
  await waitFor(() => expect(sent.filter((call) => call.url === "/api/matches")).toHaveLength(1));
  await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(2));
  expect(queuing(sent)).toEqual([]);
});

test("the stream tool shows the output controls with one Stream region", () => {
  renderUi(<StreamTool output={output()} now={1000} onRun={vi.fn(async () => true)} />);
  expect(screen.getByRole("region", { name: "Stream" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Destinations" })).toBeTruthy();
});
