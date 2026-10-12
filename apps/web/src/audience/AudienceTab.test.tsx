import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Audience } from "../contracts";
import { audience, fanQuestion, poll } from "../test/fixtures";
import { renderUi } from "../test/render";
import { AudienceTab } from "./AudienceTab";

interface Call {
  url: string;
  method: string;
  body: any;
}

/** Records the requests the tab makes. `onRun` executes them, as the studio page does. */
function setup(doc: Audience | null = audience(), accepted = true) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(doc ?? audience()), { status: 200 });
  }));
  const onRun = vi.fn(async (request: () => Promise<Audience>) => {
    await request();
    return accepted;
  });
  renderUi(<AudienceTab audience={doc} onRun={onRun} />);
  return { calls, onRun };
}

const last = (calls: Call[]) => calls[calls.length - 1];

test("before the audience arrives the tab says it is connecting", () => {
  setup(null);
  expect(screen.getByText("Connecting to the audience…")).toBeTruthy();
});

test("a poll is started from a question, one option per line, and a time limit", async () => {
  const { calls } = setup();
  fireEvent.change(screen.getByLabelText("Poll question"), { target: { value: "Who was best?" } });
  fireEvent.change(screen.getByLabelText("Options, one per line"), { target: { value: "Marrowby\n\n  Pruett  \nBellweather" } });
  fireEvent.change(screen.getByLabelText("Time limit"), { target: { value: "120" } });
  fireEvent.click(screen.getByRole("button", { name: "Start poll" }));
  await waitFor(() => expect(last(calls)).toEqual({
    url: "/api/studio/audience/poll", method: "POST", body: { question: "Who was best?", options: ["Marrowby", "Pruett", "Bellweather"], duration_s: 120 },
  }));
  await waitFor(() => expect((screen.getByLabelText("Poll question") as HTMLInputElement).value).toBe(""));
});

test("with no time limit none is sent, and a refused poll keeps what was typed", async () => {
  const { calls } = setup(audience(), false);
  fireEvent.change(screen.getByLabelText("Poll question"), { target: { value: "Who was best?" } });
  fireEvent.change(screen.getByLabelText("Options, one per line"), { target: { value: "A\nB" } });
  fireEvent.click(screen.getByRole("button", { name: "Start poll" }));
  await waitFor(() => expect(last(calls).body).toEqual({ question: "Who was best?", options: ["A", "B"] }));
  expect((screen.getByLabelText("Poll question") as HTMLInputElement).value).toBe("Who was best?");
});

test("the presets start a poll built from the match", async () => {
  const { calls } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Who will win?" }));
  await waitFor(() => expect(last(calls).body).toEqual({ preset: "winner" }));
  fireEvent.click(screen.getByRole("button", { name: "Who scores next?" }));
  await waitFor(() => expect(last(calls).body).toEqual({ preset: "next_goal" }));
});

test("the current poll shows live counts and can be closed and put on the program", async () => {
  const { calls } = setup(audience({ poll: poll() }));
  const current = within(screen.getByRole("region", { name: "Current poll" }));
  expect(current.getByText("Who will win?")).toBeTruthy();
  expect(current.getByText("Northbridge FC: 3")).toBeTruthy();
  fireEvent.click(screen.getByRole("switch", { name: "Show poll on the program" }));
  await waitFor(() => expect(last(calls)).toMatchObject({ url: "/api/studio/audience/poll/on-air", body: { on: true } }));
  fireEvent.click(screen.getByRole("button", { name: "Close poll" }));
  await waitFor(() => expect(last(calls)).toMatchObject({ url: "/api/studio/audience/poll/close", method: "POST" }));
});

test("a closed poll cannot be closed again, and an earlier poll can be shown again", async () => {
  const earlier = poll({ id: "p0", question: "First goal?", state: "closed" });
  const { calls } = setup(audience({ poll: poll({ state: "closed" }), poll_on_air: true, history: [earlier] }));
  expect(screen.queryByRole("button", { name: "Close poll" })).toBeNull();
  expect((screen.getByRole("switch", { name: "Show poll on the program" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Show again: First goal?" }));
  await waitFor(() => expect(last(calls)).toMatchObject({ url: "/api/studio/audience/history/p0/restore", method: "POST" }));
});

test("questions can be hidden, unhidden and sent to the expert", async () => {
  const questions = [fanQuestion(), fanQuestion({ id: "q2", text: "Something rude", state: "hidden", votes: 1 })];
  const { calls } = setup(audience({ questions }));
  expect(within(screen.getByTestId("studio-question-q1")).getByText("2 votes · Ann")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hide: Why the change?" }));
  await waitFor(() => expect(last(calls).url).toBe("/api/studio/audience/questions/q1/hide"));
  fireEvent.click(screen.getByRole("button", { name: "Unhide: Something rude" }));
  await waitFor(() => expect(last(calls).url).toBe("/api/studio/audience/questions/q2/unhide"));
  fireEvent.click(screen.getByRole("button", { name: "Ask the expert: Why the change?" }));
  await waitFor(() => expect(last(calls).url).toBe("/api/studio/audience/questions/q1/ask"));
  expect(screen.queryByRole("button", { name: "Ask the expert: Something rude" })).toBeNull();
});

test("an answered question is listed with its answer and can still be hidden", async () => {
  const { calls } = setup(audience({ questions: [fanQuestion({ state: "answered", answer: "Fresh legs." })] }));
  const answered = within(screen.getByTestId("studio-question-q1"));
  expect(answered.getByText("Fresh legs.")).toBeTruthy();
  expect(answered.getAllByRole("button")).toHaveLength(1);
  fireEvent.click(answered.getByRole("button", { name: "Hide: Why the change?" }));
  await waitFor(() => expect(last(calls).url).toBe("/api/studio/audience/questions/q1/hide"));
});

test.each([
  ["writing", "", "The expert is writing…"],
  ["unavailable", "", "No expert answer. Write your own."],
  ["ready", "Fresh legs for the press.", "Check the answer, edit it if you like, then put it on air."],
] as const)("a %s draft says what to do", (state, text, note) => {
  setup(audience({ questions: [fanQuestion()], draft: { question_id: "q1", text, state } }));
  const draft = within(screen.getByRole("region", { name: "Answer draft" }));
  expect(draft.getByText(note)).toBeTruthy();
  expect(draft.getByText("Why the change?")).toBeTruthy();
  expect((draft.getByLabelText("Answer") as HTMLTextAreaElement).value).toBe(text);
});

test("the edited answer is saved and then put on air", async () => {
  const { calls } = setup(audience({ questions: [fanQuestion()], draft: { question_id: "q1", text: "Fresh legs.", state: "ready" } }));
  fireEvent.change(screen.getByLabelText("Answer"), { target: { value: "Fresh legs for the press." } });
  fireEvent.click(screen.getByRole("button", { name: "Put on air" }));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[0]).toMatchObject({ url: "/api/studio/audience/draft", method: "PUT", body: { text: "Fresh legs for the press." } });
  expect(calls[1]).toMatchObject({ url: "/api/studio/audience/draft/air", method: "POST" });
});

test("an empty answer cannot be put on air, and a draft can be discarded", async () => {
  const { calls } = setup(audience({ questions: [fanQuestion()], draft: { question_id: "q1", text: "", state: "unavailable" } }));
  expect((screen.getByRole("button", { name: "Put on air" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Discard answer" }));
  await waitFor(() => expect(last(calls)).toMatchObject({ url: "/api/studio/audience/draft", method: "DELETE" }));
});

test("if saving the edited answer is refused it is not put on air", async () => {
  const { calls } = setup(audience({ questions: [fanQuestion()], draft: { question_id: "q1", text: "Old.", state: "ready" } }), false);
  fireEvent.change(screen.getByLabelText("Answer"), { target: { value: "New." } });
  fireEvent.click(screen.getByRole("button", { name: "Put on air" }));
  await waitFor(() => expect(calls).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls).toHaveLength(1);
});

test("a Q&A on air can be taken off", async () => {
  const qa = { question_id: "q1", question: "Why the change?", nickname: "Ann", answer: "Fresh legs.", ends_at: 1030 };
  const { calls } = setup(audience({ qa }));
  expect(within(screen.getByRole("region", { name: "On air" })).getByText("Fresh legs.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Take off air" }));
  await waitFor(() => expect(last(calls)).toMatchObject({ url: "/api/studio/audience/qa", method: "DELETE" }));
});
