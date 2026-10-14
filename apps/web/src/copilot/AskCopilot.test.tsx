import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { AgentCatalog, CopilotAnswer, CopilotChart } from "../contracts";
import { renderUi } from "../test/render";
import { AGENT_OPTIONS } from "./agents";
import { AskCopilot, CopilotCardView, useCopilot } from "./AskCopilot";
import { CopilotChartView } from "./Chart";
import { sampleAnswer, sampleTopic } from "./sample";

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

const catalog = (names: Record<string, string> = {}): AgentCatalog => ({
  model: false,
  agents: AGENT_OPTIONS.map((agent) => ({
    ...agent, name: names[agent.id] ?? agent.name, instructions: "", triggers: [], tools: [], outputs: [], upstream: [], enabled: true,
  })),
});

type Reply = CopilotAnswer | number | "offline" | "garbled";

/**
 * Answers each question with the next reply queued: an answer, a status refused with a reason, a network
 * failure, or a body that is not JSON. `hold` keeps the reply back until released. The agent catalog fails
 * unless one is given.
 */
function serve(answers: Reply[], search = "Wikipedia", agents: AgentCatalog | null = null) {
  const calls: Call[] = [];
  const queue = [...answers];
  let release: (() => void) | null = null;
  const server = { calls, hold: false, release: () => release?.() };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/copilot") return reply(200, { model: false, search, matches_remembered: 2 });
    if (url === "/api/agents") return agents ? reply(200, agents) : reply(500, {});
    calls.push({ url, body: JSON.parse(init!.body as string) });
    if (server.hold) await new Promise<void>((resolve) => { release = resolve; });
    const next = queue.shift() ?? answer();
    if (next === "offline") throw new TypeError("Failed to fetch");
    if (next === "garbled") return new Response("<!doctype html><p>Bad gateway</p>", { status: 200 });
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
  expect(server.calls).toEqual([{ url: "/api/copilot/ask", body: { question: "What is the score?", mode: "analyst", web: false, agent: null } }]);
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

test("a question the server refuses is answered with the reason and a sample, and the next one can be asked", async () => {
  const server = serve([422, answer()]);
  const pane = opened();
  fireEvent.click(pane.getByRole("button", { name: "What is the score?" }));
  expect((await pane.findByTestId("copilot-failure")).textContent).toBe("A question must be 1 to 300 characters.");
  type(pane, "What is the score?");
  fireEvent.click(pane.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(server.calls).toHaveLength(2));
  await waitFor(() => expect(pane.getAllByTestId("copilot-answer")).toHaveLength(2));
  expect(pane.getAllByTestId("copilot-failure")).toHaveLength(1);
  expect(pane.getAllByTestId("copilot-answer")[1].textContent).toBe("It is Northbridge FC 2-1 Harbour City in minute 37.");
});

test.each([
  ["a server error", 500 as Reply, "A question must be 1 to 300 characters."],
  ["a network failure", "offline" as Reply, "the network request failed."],
  ["a reply that is not JSON", "garbled" as Reply, "the reply was not valid JSON."],
])("on %s a clearly labelled sample answer is shown, with a table and a chart", async (_, failure, reason) => {
  serve([failure]);
  const pane = opened();
  fireEvent.click(pane.getByRole("button", { name: "Who will win from here?" }));
  expect((await pane.findByTestId("copilot-failure")).textContent).toBe(reason);
  expect(pane.getByText(/Ask Copilot could not be reached:/).textContent).toContain("Sample answer");
  const shown = within(pane.getByTestId("copilot-answer"));
  expect(shown.getByRole("heading", { name: "Sample forecast" })).toBeTruthy();
  expect(shown.getByText(/illustrative sample/)).toBeTruthy();
  expect(shown.getByRole("table")).toBeTruthy();
  expect(shown.getByRole("cell", { name: "Draw" })).toBeTruthy();
  expect(pane.getAllByTestId("copilot-chart").map((chart) => chart.getAttribute("data-kind"))).toEqual(["donut", "line"]);
  expect(pane.getByRole("img", { name: "Sample: win probability" })).toBeTruthy();
  expect(pane.getByText("Sample — not live data")).toBeTruthy();
  expect(pane.queryByText("From the match data")).toBeNull();
  expect(pane.getByRole("button", { name: "Why have the odds moved?" })).toBeTruthy();
});

test("a sample is picked by the agent the question was put to, or by its words", () => {
  expect(sampleTopic("anything", "tactical_analyst")).toBe("tactics");
  expect(sampleTopic("Who will win?", null)).toBe("prediction");
  expect(sampleTopic("Who is the best player so far?", null)).toBe("player");
  expect(sampleTopic("Show the last goal's play card", null)).toBe("highlights");
  expect(sampleTopic("What is the score?", null)).toBe("match");
  for (const topic of ["What is the score?", "odds?", "pressing?", "best player?", "highlight?"]) {
    const sample = sampleAnswer(topic, null);
    expect([sample.sample, sample.source, sample.agent]).toEqual([true, "scripted", null]);
    expect(sample.answer).toMatch(/^### Sample /);
    expect(sample.answer).toContain("| --- |");
    expect(sample.charts!.length).toBeGreaterThanOrEqual(1);
    expect(sample.charts!.every((chart) => chart.title.startsWith("Sample: "))).toBe(true);
  }
});

const open = (pane: ReturnType<typeof opened>) => within(pane.getByRole("listbox", { name: "Agents" }));
const names = (list: ReturnType<typeof open>) => list.getAllByRole("option").map((option) => option.querySelector("span")!.textContent);

test("typing @ opens the agent picker with all seven agents, and what follows filters it", async () => {
  serve([]);
  const pane = opened();
  await pane.findByText("Answers from the match and 2 on record");
  expect(pane.queryByRole("listbox")).toBeNull();
  type(pane, "@");
  const list = open(pane);
  expect(names(list)).toEqual(AGENT_OPTIONS.map((agent) => agent.name));
  expect(list.getByText("Detects pressure, rhythm, and tactical patterns.")).toBeTruthy();
  type(pane, "How is it going @tac");
  expect(names(open(pane))).toEqual(["Tactical Analyst"]);
  type(pane, "@play");
  expect(names(open(pane))).toEqual(["Event Interpreter", "Player Tracking Agent"]);
  type(pane, "@nobody");
  expect(open(pane).queryAllByRole("option")).toHaveLength(0);
  expect(pane.getByText("No agent matches “nobody”")).toBeTruthy();
  type(pane, "mail me at a@tac");
  expect(pane.queryByRole("listbox")).toBeNull();
});

test("the arrow keys move through the picker, Enter picks, and Escape closes it without closing the pane", async () => {
  serve([]);
  const pane = opened();
  await pane.findByText("Answers from the match and 2 on record");
  const input = pane.getByLabelText("Ask a question") as HTMLTextAreaElement;
  type(pane, "@");
  const selected = () => open(pane).getAllByRole("option").findIndex((option) => option.getAttribute("aria-selected") === "true");
  expect(selected()).toBe(0);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(selected()).toBe(2);
  expect(input.getAttribute("aria-activedescendant")).toBe(open(pane).getAllByRole("option")[2].id);
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(selected()).toBe(1);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(pane.queryByRole("listbox")).toBeNull();
  expect(screen.getByRole("complementary", { name: "Ask Copilot" })).toBeTruthy();

  type(pane, "What now @pre");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(pane.queryByRole("listbox")).toBeNull();
  expect(input.value).toBe("What now ");
  expect(pane.getByTestId("copilot-tagged").textContent).toContain("@Prediction Agent");

  type(pane, "What now @hig");
  fireEvent.keyDown(input, { key: "Tab" });
  expect(pane.getByTestId("copilot-tagged").textContent).toContain("@Highlights Agent");
});

test("a picked agent is shown as a tag that can be removed, and is sent with the question", async () => {
  const server = serve([answer({ agent: "tactical_analyst", intent: "tactics", answer: "Northbridge press high." })]);
  const pane = opened();
  const input = pane.getByLabelText("Ask a question") as HTMLTextAreaElement;
  type(pane, "@tac");
  fireEvent.click(open(pane).getByRole("option", { name: /Tactical Analyst/ }));
  expect(input.value).toBe("");
  fireEvent.click(pane.getByRole("button", { name: "Remove Tactical Analyst" }));
  expect(pane.queryByTestId("copilot-tagged")).toBeNull();

  fireEvent.click(pane.getByRole("button", { name: "Tag an agent" }));
  expect(names(open(pane))).toHaveLength(7);
  fireEvent.click(open(pane).getByRole("option", { name: /Tactical Analyst/ }));
  type(pane, "Who is pressing?");
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(server.calls).toHaveLength(1));
  expect(server.calls[0].body).toEqual({ question: "Who is pressing?", mode: "analyst", web: false, agent: "tactical_analyst" });
  expect(pane.queryByTestId("copilot-tagged")).toBeNull();
  expect(pane.getByTestId("copilot-asked-agent").textContent).toBe("Asked @Tactical Analyst");
  expect(await pane.findByText("Answered by Tactical Analyst")).toBeTruthy();
});

test("agent names come from the agent catalog when it answers", async () => {
  serve([answer({ agent: "highlights" })], "Wikipedia", catalog({ highlights: "Highlights Desk" }));
  const pane = opened();
  type(pane, "@");
  await waitFor(() => expect(names(open(pane))).toContain("Highlights Desk"));
  fireEvent.click(open(pane).getByRole("option", { name: /Highlights Desk/ }));
  fireEvent.click(pane.getByRole("button", { name: "Send" }));
  expect(await pane.findByText("Answered by Highlights Desk")).toBeTruthy();
  expect(pane.getByTestId("copilot-question").textContent).toBe("@Highlights Desk");
});

test("an answer is written in Markdown, with headings, tables, code and links that open apart from the studio", async () => {
  const text = [
    "### Pressing", "", "Northbridge **press high** and _win it back_ fast.", "",
    "- Field tilt `61%`", "- Pressure up", "",
    "| Measure | Home | Away |", "| --- | ---: | ---: |", "| Shots | 7 | 2 |", "",
    "See [the laws](https://example.org/laws). <b>raw</b>",
  ].join("\n");
  serve([answer({ answer: text })]);
  const pane = opened();
  fireEvent.click(pane.getByRole("button", { name: "What is the score?" }));
  const shown = within(await pane.findByTestId("copilot-answer"));
  expect(shown.getByRole("heading", { level: 3, name: "Pressing" })).toBeTruthy();
  expect(shown.getByText("press high").tagName).toBe("STRONG");
  expect(shown.getByText("win it back").tagName).toBe("EM");
  expect(shown.getByText("61%").tagName).toBe("CODE");
  expect(shown.getAllByRole("listitem")).toHaveLength(2);
  expect(shown.getByRole("columnheader", { name: "Away" })).toBeTruthy();
  expect(shown.getByRole("row", { name: "Shots 7 2" })).toBeTruthy();
  const link = shown.getByRole("link", { name: "the laws" });
  expect([link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")]).toEqual(["https://example.org/laws", "_blank", "noreferrer"]);
  expect(pane.getByTestId("copilot-answer").querySelector("b")).toBeNull();
});

test("an answer's charts are drawn: home against away, a ring of shares, lines and plain bars", async () => {
  const charts: CopilotChart[] = [
    { kind: "bar", title: "The two sides", unit: null, labels: ["Shots", "Expected goals"], series: [
      { name: "Northbridge FC", team: "home", values: [7, 1.4] }, { name: "Harbour City", team: "away", values: [2, 0.6] },
    ] },
    { kind: "donut", title: "Win probability", unit: "%", labels: ["Northbridge FC", "Draw", "Harbour City"], series: [{ name: "Win", team: null, values: [52, 28, 20] }] },
  ];
  serve([answer({ charts })]);
  const pane = opened();
  fireEvent.click(pane.getByRole("button", { name: "What is the score?" }));
  await waitFor(() => expect(pane.getAllByTestId("copilot-chart")).toHaveLength(2));
  expect(pane.getByRole("table", { name: "Northbridge FC compared with Harbour City" })).toBeTruthy();
  expect(pane.getByText("The two sides")).toBeTruthy();
  expect(pane.getByRole("img", { name: "Win probability" })).toBeTruthy();
  expect(pane.getByText("52%")).toBeTruthy();

  renderUi(<CopilotChartView chart={{ kind: "bar", title: "Ratings", unit: null, labels: ["A", "B"], series: [{ name: "Rating", team: null, values: [8.1, 7] }] }} />);
  expect(screen.getByRole("img", { name: "Ratings" }).textContent).toContain("8.1");
  renderUi(<CopilotChartView chart={{ kind: "line", title: "Home win", unit: "%", labels: ["0'", "45'"], series: [{ name: "Home", team: "home", values: [40, 48] }] }} />);
  expect(screen.getByRole("img", { name: "Home win: Home 48%" })).toBeTruthy();
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
