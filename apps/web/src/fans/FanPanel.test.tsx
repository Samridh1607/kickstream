import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { FanZone } from "../contracts";
import { StudioRequestError } from "../studio/api";
import { fanComment, fanPoll, fanZone, superchat } from "../test/fixtures";
import { renderUi } from "../test/render";
import { FanPanel } from "./FanPanel";

interface Call {
  url: string;
  method: string;
  body: any;
}

/** Answers every fan-zone request with the document given, and records what was asked. */
function serve(answer: FanZone = fanZone({ revision: 2 })) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(answer), { status: 200 });
  }));
  return calls;
}

function open(doc: FanZone | null) {
  const accepted: FanZone[] = [];
  const onRun = async (request: () => Promise<FanZone>) => {
    try {
      accepted.push(await request());
      return true;
    } catch (caught) {
      if (caught instanceof StudioRequestError) return false;
      throw caught;
    }
  };
  renderUi(<FanPanel fans={doc} onRun={onRun} />);
  return accepted;
}

const section = (name: string) => within(screen.getByRole("region", { name }));
const last = (calls: Call[]) => calls[calls.length - 1];

test("before the fan zone has loaded the panel says so", () => {
  open(null);
  expect(screen.getByText("Connecting to the fan zone…")).toBeTruthy();
});

test("the panel says where comments come from and marks the demo feed", () => {
  open(fanZone());
  expect(screen.getByText("Demo feed")).toBeTruthy();
  expect(screen.getByText("Nothing from the fan zone is on screen.")).toBeTruthy();
  expect((screen.getByRole("option", { name: "X" }) as HTMLOptionElement).disabled).toBe(true);
});

test("a failing source shows its problem", () => {
  open(fanZone({ source_state: "failing", problem: "X's limit on searches was reached." }));
  expect(screen.getByText("Source failing")).toBeTruthy();
  expect(screen.getByText("X's limit on searches was reached.")).toBeTruthy();
});

test("the quick summary shows the sentence, the mood, the topics and what was raised", () => {
  open(fanZone({
    summary: {
      text: "The chat is busy (12 a minute) and mostly positive.", per_minute: 12, total: 48,
      mood: { positive: 70, neutral: 20, negative: 10 }, topics: [{ label: "#kickstream", count: 9 }],
      platforms: [{ platform: "x", count: 30 }], raised: [{ currency: "USD", amount: 25 }],
    },
  }));
  expect(screen.getByTestId("fan-summary").textContent).toBe("The chat is busy (12 a minute) and mostly positive.");
  expect(screen.getByRole("img", { name: "Positive 70%, Neutral 20%, Negative 10%" })).toBeTruthy();
  expect(screen.getByText("#kickstream · 9")).toBeTruthy();
  expect(screen.getByText("USD 25.00 raised")).toBeTruthy();
  expect(screen.getByText("48 comments")).toBeTruthy();
});

test("a comment can be liked and put on screen, and the list can show only liked ones", async () => {
  const calls = serve();
  const accepted = open(fanZone({ comments: [fanComment(), fanComment({ id: "c2", author: "Tom", text: "Poor ref", liked: true, demo: true })] }));
  const rows = screen.getAllByTestId("fan-panel-comment");
  expect(rows.map((row) => within(row).getByText(/goal|ref/).textContent)).toEqual(["Poor ref", "What a goal!"]); // newest first
  expect(within(rows[0]).getByText("Demo")).toBeTruthy();

  fireEvent.click(within(rows[1]).getByRole("button", { name: /^Like/ }));
  await waitFor(() => expect(last(calls)).toEqual({ url: "/api/fans/comments/c1/like", method: "POST", body: { liked: true } }));
  fireEvent.click(within(rows[0]).getByRole("button", { name: "Unlike" }));
  await waitFor(() => expect(last(calls).body).toEqual({ liked: false }));
  fireEvent.click(within(rows[1]).getByRole("button", { name: "Show on screen" }));
  await waitFor(() => expect(last(calls).url).toBe("/api/fans/comments/c1/spotlight"));
  await waitFor(() => expect(accepted).toHaveLength(3));

  fireEvent.click(section("Comments").getByRole("switch", { name: "Liked only" }));
  expect(screen.getAllByTestId("fan-panel-comment")).toHaveLength(1);
});

test("a poll is started from a preset, shown with its votes, put on screen and closed", async () => {
  const calls = serve();
  open(fanZone());
  const poll = section("Poll");
  expect(poll.getByText("No poll is running.")).toBeTruthy();
  expect((poll.getByRole("button", { name: "Start poll" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(poll.getByRole("button", { name: "Next goal" }));
  fireEvent.change(poll.getByLabelText("Close after (minutes)"), { target: { value: "5" } });
  fireEvent.click(poll.getByRole("button", { name: "Start poll" }));
  await waitFor(() => expect(last(calls)).toEqual({
    url: "/api/fans/poll", method: "POST", body: { question: "Will there be another goal?", options: ["Yes", "No"], minutes: 5 },
  }));
});

test("a running poll shows each option's votes and its controls", async () => {
  const calls = serve();
  open(fanZone({ poll: fanPoll(), poll_on_air: false }));
  const card = within(screen.getByTestId("fan-poll"));
  expect(card.getByText("1. Home")).toBeTruthy();
  expect(card.getByText("3 · 75%")).toBeTruthy();
  fireEvent.click(card.getByRole("switch", { name: "On screen" }));
  await waitFor(() => expect(last(calls)).toEqual({ url: "/api/fans/poll/air", method: "PUT", body: { on_air: true } }));
  fireEvent.click(card.getByRole("button", { name: "Close voting" }));
  await waitFor(() => expect(last(calls).url).toBe("/api/fans/poll/close"));
  fireEvent.click(screen.getByRole("button", { name: "Show poll result" }));
  await waitFor(() => expect(last(calls).url).toBe("/api/fans/poll/announce"));
});

test("quick actions pick a winner from the chosen pool and send a custom message", async () => {
  const calls = serve();
  open(fanZone());
  const quick = section("Quick actions");
  fireEvent.change(quick.getByLabelText("Pick the winner from"), { target: { value: "supporters" } });
  fireEvent.click(quick.getByRole("button", { name: "Pick a winner" }));
  await waitFor(() => expect(last(calls)).toEqual({ url: "/api/fans/winner", method: "POST", body: { pool: "supporters" } }));

  const show = quick.getByRole("button", { name: "Show message" }) as HTMLButtonElement;
  expect(show.disabled).toBe(true);
  fireEvent.change(quick.getByLabelText("Custom message"), { target: { value: "Welcome, everyone!" } });
  fireEvent.change(quick.getByLabelText("Message title"), { target: { value: "Half-time" } });
  fireEvent.click(show);
  await waitFor(() => expect(last(calls).body).toEqual({ title: "Half-time", text: "Welcome, everyone!", duration_s: 10 }));
  await waitFor(() => expect((quick.getByLabelText("Custom message") as HTMLTextAreaElement).value).toBe(""));
});

test("what is on screen is shown with what is waiting, and can be taken off", async () => {
  const calls = serve();
  const winner = { id: "sp1", kind: "winner" as const, title: "Winner", text: "Picked from 12 commenters.", name: "Priya K", duration_s: 15, ends_at: 1010 };
  open(fanZone({ spotlight: winner, spotlight_queue: [{ ...winner, id: "sp2" }] }));
  const onAir = within(screen.getByTestId("fan-on-air"));
  expect(onAir.getByText("Priya K")).toBeTruthy();
  expect(onAir.getByText("1 waiting")).toBeTruthy();
  fireEvent.click(onAir.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(last(calls)).toEqual({ url: "/api/fans/spotlight", method: "DELETE", body: undefined }));
});

test("superchats list the supporter and amount, and one can be added by hand or thanked on screen", async () => {
  const calls = serve();
  open(fanZone({ superchats: [superchat()] }));
  const chats = section("Superchats");
  expect(chats.getByText("Asha · USD 20.00")).toBeTruthy();
  fireEvent.click(chats.getByRole("button", { name: "Thank Asha on screen" }));
  await waitFor(() => expect(last(calls).url).toBe("/api/fans/superchats/s1/spotlight"));

  const add = chats.getByRole("button", { name: "Add superchat" }) as HTMLButtonElement;
  expect(add.disabled).toBe(true);
  fireEvent.change(chats.getByLabelText("Supporter's name"), { target: { value: "Ben" } });
  fireEvent.change(chats.getByLabelText("Amount"), { target: { value: "7.5" } });
  fireEvent.change(chats.getByLabelText("Currency"), { target: { value: "eur" } });
  fireEvent.change(chats.getByLabelText("Their message"), { target: { value: "Allez" } });
  fireEvent.click(add);
  await waitFor(() => expect(last(calls).body).toEqual({ name: "Ben", amount: 7.5, currency: "EUR", message: "Allez" }));

  fireEvent.click(chats.getByRole("switch", { name: "Show each new superchat on screen automatically" }));
  await waitFor(() => expect(last(calls)).toEqual({ url: "/api/fans/settings", method: "PUT", body: { source: "demo", auto_superchat: true } }));
});

test("the source can be changed, and X is offered once it is set up", async () => {
  const calls = serve();
  open(fanZone({ x_available: true }));
  fireEvent.change(screen.getByLabelText("Source"), { target: { value: "x" } });
  await waitFor(() => expect(last(calls).body).toEqual({ source: "x", auto_superchat: false }));
  fireEvent.click(screen.getByRole("button", { name: "Clear comments, poll and superchats" }));
  await waitFor(() => expect(last(calls)).toEqual({ url: "/api/fans", method: "DELETE", body: undefined }));
});
