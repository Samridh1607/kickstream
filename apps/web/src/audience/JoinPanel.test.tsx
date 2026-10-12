import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { audience, fanQuestion, poll } from "../test/fixtures";
import { renderUi } from "../test/render";
import { JoinPanel } from "./JoinPanel";
import type { Choices } from "./voter";

const NONE: Choices = { polls: {}, upvoted: [], asked: [] };

function setup(over: Partial<Parameters<typeof JoinPanel>[0]> = {}) {
  const handlers = { onVote: vi.fn(), onAsk: vi.fn(async () => true), onUpvote: vi.fn() };
  renderUi(<JoinPanel audience={audience()} choices={NONE} remembered language="en" problem={null} {...handlers} {...over} />);
  return handlers;
}

test("before the audience arrives, and with no poll, it says there is no poll", () => {
  setup({ audience: null });
  expect(screen.getByText("No poll right now.")).toBeTruthy();
});

test("an open poll offers its options and hides the results until the fan votes", () => {
  const handlers = setup({ audience: audience({ poll: poll() }) });
  expect(screen.getByText("Who will win?")).toBeTruthy();
  expect(screen.getByText("Vote to see the results.")).toBeTruthy();
  expect(screen.queryByText(/votes/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Harbour City" }));
  expect(handlers.onVote).toHaveBeenCalledWith("o3");
});

test("after voting the fan sees the results and which option is theirs, and can change it", () => {
  const handlers = setup({ audience: audience({ poll: poll() }), choices: { ...NONE, polls: { p1: "o1" } } });
  const mine = within(screen.getByTestId("poll-option-o1"));
  expect(mine.getByText("Your vote")).toBeTruthy();
  expect(mine.getByText("3 votes · 75%")).toBeTruthy();
  expect(within(screen.getByTestId("poll-option-o2")).getByText("0 votes · 0%")).toBeTruthy();
  expect(within(screen.getByTestId("poll-option-o3")).queryByText("Your vote")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Harbour City" }));
  expect(handlers.onVote).toHaveBeenCalledWith("o3");
});

test("a closed poll shows results to everyone and takes no votes", () => {
  setup({ audience: audience({ poll: poll({ state: "closed" }) }) });
  expect(screen.getByText("Closed")).toBeTruthy();
  expect(within(screen.getByTestId("poll-option-o1")).getByText("3 votes · 75%")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Harbour City" })).toBeNull();
});

test("a poll with no votes shows zero percent, not a division error", () => {
  const empty = poll({ state: "closed", options: [{ id: "a", text: "A", votes: 0 }, { id: "b", text: "B", votes: 0 }] });
  setup({ audience: audience({ poll: empty }) });
  expect(screen.getAllByText("0 votes · 0%")).toHaveLength(2);
});

test("questions are listed with votes, and an upvote reports the question", () => {
  const questions = [fanQuestion(), fanQuestion({ id: "q2", text: "Who is pressing?", nickname: "Ben", votes: 1 })];
  const handlers = setup({ audience: audience({ questions }), choices: { ...NONE, upvoted: ["q2"] } });
  const first = within(screen.getByTestId("question-q1"));
  expect(first.getByText("Why the change?")).toBeTruthy();
  expect(first.getByText("Ann")).toBeTruthy();
  const upvote = first.getByRole("button", { name: "Upvote: Why the change?" });
  expect(upvote.getAttribute("aria-pressed")).toBe("false");
  expect(upvote.textContent).toContain("2");
  fireEvent.click(upvote);
  expect(handlers.onUpvote).toHaveBeenCalledWith("q1");
  expect(within(screen.getByTestId("question-q2")).getByRole("button", { name: "Upvote: Who is pressing?" }).getAttribute("aria-pressed")).toBe("true");
});

test("a fan's own question is marked and cannot be upvoted by them", () => {
  setup({ audience: audience({ questions: [fanQuestion()] }), choices: { ...NONE, asked: ["q1"] } });
  const mine = within(screen.getByTestId("question-q1"));
  expect(mine.getByText("Yours")).toBeTruthy();
  expect((mine.getByRole("button", { name: "Upvote: Why the change?" }) as HTMLButtonElement).disabled).toBe(true);
});

test("an answered question shows the expert's answer and takes no more votes", () => {
  setup({ audience: audience({ questions: [fanQuestion({ state: "answered", answer: "Fresh legs for the press." })] }) });
  const answered = within(screen.getByTestId("question-q1"));
  expect(answered.getByText("Expert answer")).toBeTruthy();
  expect(answered.getByText("Fresh legs for the press.")).toBeTruthy();
  expect((answered.getByRole("button", { name: "Upvote: Why the change?" }) as HTMLButtonElement).disabled).toBe(true);
});

test("markup in fan text is shown as text and creates no elements", () => {
  const text = '<img src=x onerror="alert(1)"> <b>why?</b>';
  const { container } = renderUi(
    <JoinPanel audience={audience({ questions: [fanQuestion({ text, nickname: "<i>x</i>" })] })} choices={NONE} remembered language="en"
      problem={null} onVote={vi.fn()} onAsk={vi.fn(async () => true)} onUpvote={vi.fn()} />,
  );
  expect(screen.getByText(text)).toBeTruthy();
  expect(container.querySelector("img, b, i")).toBeNull();
});

test("asking sends the trimmed question and nickname, and clears the question when accepted", async () => {
  const handlers = setup();
  const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "  Why the change?  " } });
  fireEvent.change(screen.getByLabelText("Nickname (optional)"), { target: { value: " Ann " } });
  fireEvent.click(send);
  await waitFor(() => expect(handlers.onAsk).toHaveBeenCalledWith("Why the change?", "Ann"));
  await waitFor(() => expect((screen.getByLabelText("Your question") as HTMLTextAreaElement).value).toBe(""));
  expect((screen.getByLabelText("Nickname (optional)") as HTMLInputElement).value).toBe(" Ann ");
});

test("a refused question stays in the box with the reason shown", async () => {
  const onAsk = vi.fn(async () => false);
  setup({ onAsk, problem: "You can ask again in 18 seconds." });
  fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "Again?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(onAsk).toHaveBeenCalled());
  expect((screen.getByLabelText("Your question") as HTMLTextAreaElement).value).toBe("Again?");
  expect(screen.getByText("You can ask again in 18 seconds.")).toBeTruthy();
});

test("the question box stops at 200 characters and the nickname at 24", () => {
  setup();
  expect((screen.getByLabelText("Your question") as HTMLTextAreaElement).maxLength).toBe(200);
  expect((screen.getByLabelText("Nickname (optional)") as HTMLInputElement).maxLength).toBe(24);
});

test("when choices cannot be remembered the fan is told", () => {
  setup({ remembered: false });
  expect(screen.getByText(/votes may not be remembered after a reload/)).toBeTruthy();
});

test("the panel follows the fan's language", () => {
  setup({ language: "es", audience: audience({ poll: poll(), questions: [fanQuestion()] }) });
  expect(screen.getByText("Vota para ver los resultados.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Enviar" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Apoyar: Why the change?" })).toBeTruthy();
});
