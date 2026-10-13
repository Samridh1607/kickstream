import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { CopilotAnswer } from "../contracts";
import { renderUi } from "../test/render";
import { AskCopilot, CopilotCardView, useCopilot } from "./AskCopilot";

const answer = (over: Partial<CopilotAnswer> = {}): CopilotAnswer => ({
  id: "a1", question: "What is the score?", intent: "match", answer: "It is Northbridge FC 2-1 Harbour City in minute 37.",
  cards: [{
    kind: "match", title: "Northbridge FC 2-1 Harbour City", subtitle: "In minute 37", home: "Northbridge FC", away: "Harbour City", team: null,
    facts: [], compare: [{ label: "Shots", home: "7", away: "2" }], items: [],
  }],
  sources: [], followups: ["Who will win from here?", "Show me the head to head"], source: "scripted", searched: false, problem: null, ...over,
});

interface Call {
  url: string;
  body: any;
}

/** Answers each question with the next answer queued; `hold` keeps the reply back until released. */
function serve(answers: (CopilotAnswer | number)[], search = "Wikipedia") {
  const calls: Call[] = [];
  const queue = [...answers];
  let release: (() => void) | null = null;
  const server = { calls, hold: false, release: () => release?.() };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/copilot") return reply(200, { model: false, search, matches_remembered: 2 });
    calls.push({ url, body: JSON.parse(init!.body as string) });
    if (server.hold) await new Promise<void>((resolve) => { release = resolve; });
    const next = queue.shift() ?? answer();
    return typeof next === "number"
      ? reply(next, { detail: [{ loc: ["body", "question"], msg: "A question must be 1 to 300 characters.", type: "refusal" }] })
      : reply(200, next);
  }));
  return server;
}

beforeEach(() => useCopilot.setState({ open: false, turns: [], web: false }));

function opened() {
  renderUi(<AskCopilot />);
  fireEvent.click(screen.getByRole("button", { name: "Ask Copilot" }));
  return within(screen.getByRole("complementary", { name: "Ask Copilot" }));
}

const type = (pane: ReturnType<typeof opened>, text: string) => fireEvent.change(pane.getByLabelText("Ask a question"), { target: { value: text } });

test("the button opens the pane, which greets with questions to start from, and closes again", async () => {
  serve([]);
  renderUi(<AskCopilot />);
  const launcher = screen.getByRole("button", { name: "Ask Copilot" });
  expect(launcher.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("complementary")).toBeNull();
  fireEvent.click(launcher);
  const pane = within(screen.getByRole("complementary", { name: "Ask Copilot" }));
  expect(pane.getByText("What would you like to know?")).toBeTruthy();
  expect(pane.getByRole("button", { name: "Show me the head to head" })).toBeTruthy();
  await waitFor(() => expect(pane.getByText("Answers from the match and 2 on record")).toBeTruthy());
  fireEvent.click(pane.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("complementary")).toBeNull();
});

test("a starter question is asked and answered with its text, card and follow-ups", async () => {
  const server = serve([answer()]);
  const pane = opened();
  fireEvent.click(pane.getByRole("button", { name: "What is the score?" }));
  expect(pane.getByTestId("copilot-question").textContent).toBe("What is the score?");
  await waitFor(() => expect(pane.getByTestId("copilot-answer").textContent).toBe("It is Northbridge FC 2-1 Harbour City in minute 37."));
  expect(server.calls).toEqual([{ url: "/api/copilot/ask", body: { question: "What is the score?", mode: "fan", web: false } }]);
  const card = within(pane.getByTestId("copilot-card"));
  expect(card.getByRole("row", { name: "7 Shots 2" })).toBeTruthy();
  expect(pane.getByText("From the match data")).toBeTruthy();
  expect(pane.queryByText("What would you like to know?")).toBeNull();

  fireEvent.click(pane.getByRole("button", { name: "Who will win from here?" }));
  await waitFor(() => expect(server.calls).toHaveLength(2));
  expect(server.calls[1].body.question).toBe("Who will win from here?");
});

test("a typed question is sent with Enter, and Shift and Enter only adds a line", async () => {
  const server = serve([answer()]);
  const pane = opened();
  const input = pane.getByLabelText("Ask a question") as HTMLTextAreaElement;
  expect((pane.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  type(pane, "  Tell me about Marrowby ");
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(server.calls).toHaveLength(0);
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(server.calls[0].body.question).toBe("Tell me about Marrowby"));
  expect(input.value).toBe("");
});

test("while an answer is on its way the pane says so and takes no second question", async () => {
  const server = serve([answer()]);
  server.hold = true;
  const pane = opened();
  type(pane, "What is the score?");
  fireEvent.click(pane.getByRole("button", { name: "Send" }));
  expect(await pane.findByRole("status", { name: "Copilot is answering" })).toBeTruthy();
  type(pane, "And the tactics?");
  expect((pane.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(pane.getByLabelText("Ask a question"), { key: "Enter" });
  expect(server.calls).toHaveLength(1);
  server.release();
  await waitFor(() => expect(pane.getByTestId("copilot-answer")).toBeTruthy());
  expect(pane.queryByRole("status")).toBeNull();
});

test("with web search on, the question is searched for and the sources are linked safely", async () => {
  const found = answer({
    intent: "web", answer: "From Wikipedia: Offside is one of the laws.", cards: [], searched: true,
    sources: [{ title: "Offside (association football)", url: "https://en.wikipedia.org/wiki/Offside", snippet: "Offside is one of the laws." }],
  });
  const server = serve([found]);
  const pane = opened();
  await waitFor(() => expect((pane.getByRole("switch", { name: "Search the web" }) as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(pane.getByRole("switch", { name: "Search the web" }));
  expect(pane.getByText(/Your question is sent to Wikipedia\./)).toBeTruthy();
  type(pane, "What is the offside rule?");
  fireEvent.click(pane.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(server.calls[0].body.web).toBe(true));
  const link = await pane.findByRole("link", { name: /Offside \(association football\)/ });
  expect([link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")]).toEqual([
    "https://en.wikipedia.org/wiki/Offside", "_blank", "noopener noreferrer",
  ]);
  expect(pane.getByText("Searched Wikipedia")).toBeTruthy();
});

test("when web search is not set up its switch is off, and a search problem is shown with the answer", async () => {
  serve([answer({ problem: "The web could not be reached.", searched: true })], "");
  const pane = opened();
  await waitFor(() => expect((pane.getByRole("switch", { name: "Search the web" }) as HTMLInputElement).disabled).toBe(true));
  fireEvent.click(pane.getByRole("button", { name: "What is the score?" }));
  expect(await pane.findByText("The web could not be reached.")).toBeTruthy();
  expect(pane.getByText("Searched the web")).toBeTruthy();
});

test("a question the server refuses is answered with the reason, and the next one can be asked", async () => {
  const server = serve([422, answer()]);
  const pane = opened();
  fireEvent.click(pane.getByRole("button", { name: "What is the score?" }));
  expect((await pane.findByTestId("copilot-failure")).textContent).toBe("A question must be 1 to 300 characters.");
  type(pane, "What is the score?");
  fireEvent.click(pane.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(server.calls).toHaveLength(2));
  await waitFor(() => expect(pane.getByTestId("copilot-answer")).toBeTruthy());
});

test("the conversation survives closing the pane, and a new chat clears it", async () => {
  serve([answer()]);
  const pane = opened();
  fireEvent.click(pane.getByRole("button", { name: "What is the score?" }));
  await waitFor(() => expect(pane.getByTestId("copilot-answer")).toBeTruthy());
  fireEvent.keyDown(pane.getByLabelText("Ask a question"), { key: "Escape" });
  expect(screen.queryByRole("complementary")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Ask Copilot" }));
  const again = within(screen.getByRole("complementary", { name: "Ask Copilot" }));
  expect(again.getByTestId("copilot-question").textContent).toBe("What is the score?");
  fireEvent.click(again.getByRole("button", { name: "New chat" }));
  expect(again.getByText("What would you like to know?")).toBeTruthy();
});

test("a card shows its facts and its moments, as plain text", () => {
  renderUi(<CopilotCardView card={{
    kind: "play", title: "Goal for Northbridge FC: Luca Marrowby", subtitle: "23' · Northbridge FC", home: null, away: null, team: "home",
    facts: [{ label: "Minute", value: "23'" }, { label: "Why it was chosen", value: "<b>xG 0.42</b>" }], compare: [],
    items: [{ when: "22:51", title: "Pass by Kellan Whitlock", detail: "middle third, centre · progression", team: "home" }],
  }} />);
  const card = screen.getByTestId("copilot-card");
  expect(card.getAttribute("data-kind")).toBe("play");
  expect(within(card).getByText("<b>xG 0.42</b>")).toBeTruthy();
  expect(within(card).getByText("22:51")).toBeTruthy();
  expect(within(card).queryByRole("table")).toBeNull();
});
