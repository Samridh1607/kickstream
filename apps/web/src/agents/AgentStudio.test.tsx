import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { App } from "../App";
import type { AgentCatalog, MatchStatus } from "../contracts";
import { EMPTY, type MatchData, useMatch } from "../stream/store";
import {
  agentCatalog, agentRun, AWAY, envelope, explanation, FakeEventSource, FakeEventSourceCtor, highlight, HOME, pitchScene, play, playerReport,
  prediction, status, tactics,
} from "../test/fixtures";
import { renderUi } from "../test/render";
import { AgentFlow } from "./AgentFlow";
import { agentState, downstream, runsOf } from "./api";

const live: MatchData = { ...EMPTY, minute: 12, status: status({ minute: 12 }), runs: [agentRun(), agentRun({ id: "r2", agent: "highlights", minute: 4 })] };

test("an agent is working when it reported in the last match minute, idle otherwise, and off when switched off", () => {
  const catalog = agentCatalog(["visualization"]);
  const state = (id: string, match = live) => agentState(catalog.agents.find((agent) => agent.id === id)!, match);
  expect(state("prediction")).toBe("working");
  expect(state("highlights")).toBe("idle");
  expect(state("tactical_analyst")).toBe("idle");
  expect(state("visualization")).toBe("off");
  expect(state("prediction", { ...live, status: status({ state: "finished" }) })).toBe("idle");
});

test("an agent's listeners and its own runs are found", () => {
  expect(downstream(agentCatalog(), "event_interpreter").map((agent) => agent.id)).toEqual([
    "tactical_analyst", "prediction", "player_tracking", "visualization", "highlights",
  ]);
  expect(downstream(agentCatalog(), "explainability")).toEqual([]);
  expect(runsOf(live.runs, "highlights").map((run) => run.id)).toEqual(["r2"]);
});

test("the flow draws every agent and moves only the edges into agents that are working", () => {
  const picked: string[] = [];
  renderUi(<AgentFlow catalog={agentCatalog(["tactical_analyst"])} match={live} selected="prediction" onSelect={(id) => picked.push(id)} />);
  expect(screen.getByTestId("flow-prediction").getAttribute("data-state")).toBe("working");
  expect(screen.getByTestId("flow-tactical_analyst").getAttribute("data-state")).toBe("off");
  expect(screen.getByRole("button", { name: "Prediction Agent: Working" }).getAttribute("aria-pressed")).toBe("true");
  const edges = screen.getAllByTestId("flow-edge");
  expect(edges).toHaveLength(11); // two sources, and nine links between agents
  expect(edges.filter((edge) => edge.getAttribute("data-flowing") === "true")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Highlights Agent: Idle" }));
  expect(picked).toEqual(["highlights"]);
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function serve(catalog: AgentCatalog | null = agentCatalog()) {
  let current = catalog;
  const calls: Call[] = [];
  const reply = (statusCode: number, body: unknown) => new Response(JSON.stringify(body), { status: statusCode });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (url === "/api/teams") return reply(200, { home: HOME, away: AWAY });
    if (url === "/api/matches/current") return reply(200, { match_id: "m-1" });
    if (url === "/api/agents") return current ? reply(200, current) : reply(500, {});
    if (url.startsWith("/api/agents/") && method === "PUT") {
      const agentId = url.split("/").pop();
      if (agentId === "highlights") return reply(503, { detail: [{ loc: ["body", "agent"], msg: "The change could not be saved. Nothing was changed.", type: "refusal" }] });
      const enabled = (JSON.parse(init!.body as string) as { enabled: boolean }).enabled;
      current = { ...current!, agents: current!.agents.map((agent) => (agent.id === agentId ? { ...agent, enabled } : agent)) };
      return reply(200, current);
    }
    return reply(404, {});
  }));
  return calls;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  useMatch.setState({ data: useMatch.getInitialState().data, connection: "idle", selectedId: null });
});

async function opened(over: Partial<MatchStatus> = {}) {
  renderUi(<App eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  await waitFor(() => expect(FakeEventSource.last?.url).toBe("/api/matches/m-1/stream?mode=analyst&lang=en"), { timeout: 10_000 });
  const source = FakeEventSource.last;
  act(() => {
    source.open();
    [
      envelope(1, "match_status", status({ minute: 12, ...over })),
      envelope(2, "play", play()),
      envelope(3, "tactics", tactics()),
      envelope(4, "prediction", prediction()),
      envelope(5, "pitch_scene", pitchScene()),
      envelope(6, "players", playerReport()),
      envelope(7, "highlight", highlight()),
      envelope(8, "highlight", highlight({ id: "m-1-h2", kind: "hidden", category: "long_sequence", title: "9-touch move by Harbour City", team: "away", score: 58, moment_id: null }), true),
      envelope(9, "explanation", explanation()),
      envelope(10, "agent_run", { ...agentRun(), minute: 12 }),
    ].forEach((item) => source.emit({ ...item, minute: 12 }));
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Prediction Agent" })).toBeTruthy());
  return source;
}

const rail = () => within(screen.getByRole("navigation", { name: "Match intelligence" }));

test("the page opens on the overview: the flow, and what each agent has found", async () => {
  serve();
  await opened();
  expect(rail().getByRole("button", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByTestId("agent-flow")).toBeTruthy();
  expect(screen.getByTestId("tactics-summary").textContent).toContain("winning the ball high");
  expect(within(screen.getByTestId("card-prediction")).getByTestId("share-home").textContent).toContain("50%");
  expect(screen.getByTestId("tracked-name").textContent).toBe("Luca Marrowby");
  expect(within(screen.getByTestId("card-tactics")).getByText("High press")).toBeTruthy();
  expect(screen.getByTestId("pitch3d").getAttribute("data-camera")).toBe("attack_home");
  expect(screen.getByText("They are not letting Harbour City settle.")).toBeTruthy();
  expect(screen.getAllByTestId("agent-run")).toHaveLength(1);
});

test("agent cards that need positions say so on a key-events match", async () => {
  serve();
  await opened({ detail: "key_events", source: "openligadb" });
  const card = (testId: string) => within(screen.getByTestId(testId));
  expect(card("card-pitch").getByTestId("live-data-only").textContent).toBe("Not available with live data");
  expect(screen.queryByTestId("pitch3d")).toBeNull();
  expect(card("card-pitch").queryByRole("button", { name: "Add to scene" })).toBeNull();
  expect(card("card-tactics").getByTestId("live-data-only")).toBeTruthy();
  expect(screen.queryByTestId("tactics-summary")).toBeNull();
  expect(card("card-prediction").getByTestId("share-home").textContent).toContain("50%");
  expect(card("card-prediction").queryByTestId("live-data-only")).toBeNull();

  fireEvent.click(rail().getByRole("button", { name: "Prediction Agent" }));
  expect(card("card-prediction").getByText("Chance to score in the next 10 minutes")).toBeTruthy();
  expect(card("card-prediction").queryByRole("img", { name: "Danger by zone of the pitch" })).toBeNull();
  expect(card("card-prediction").getByTestId("live-data-only")).toBeTruthy();
});

test("on a fully detailed match the same cards draw positions", async () => {
  serve();
  await opened({ detail: "full", source: "statsbomb" });
  expect(screen.queryByTestId("live-data-only")).toBeNull();
  expect(screen.getByTestId("pitch3d")).toBeTruthy();
  fireEvent.click(rail().getByRole("button", { name: "Prediction Agent" }));
  expect(within(screen.getByTestId("card-prediction")).getByRole("img", { name: "Danger by zone of the pitch" })).toBeTruthy();
});

test("highlights are listed best first and can be narrowed to the hidden events", async () => {
  serve();
  await opened();
  const card = within(screen.getByTestId("card-highlights"));
  expect(card.getAllByTestId("highlight").map((item) => item.getAttribute("data-kind"))).toEqual(["key", "hidden"]);
  expect(card.getByText("Highlighted for you")).toBeTruthy();
  fireEvent.change(card.getByLabelText("Highlights to show"), { target: { value: "hidden" } });
  expect(card.getAllByTestId("highlight")).toHaveLength(1);
  expect(card.getByText("Hidden · Long move")).toBeTruthy();
});

test("an agent's page shows what it is told, what sets it off, its tools, its connections and its work", async () => {
  serve();
  await opened();
  fireEvent.click(rail().getByRole("button", { name: "Prediction Agent" }));
  expect(screen.getByRole("heading", { name: "Prediction Agent" })).toBeTruthy();
  expect(screen.getByText("Forecasts likely next moves or danger areas.")).toBeTruthy();
  expect(screen.getByText("Instructions for the Prediction Agent.")).toBeTruthy();
  expect(screen.getByText("tool_one")).toBeTruthy();
  expect(screen.getByText("Listens to Event Interpreter. Heard by Explainability Agent.")).toBeTruthy();
  expect(screen.getByTestId("agent-state").textContent).toBe("Working");
  expect(screen.getByText("Where the danger has been coming from")).toBeTruthy();
  expect(screen.getAllByTestId("agent-run")).toHaveLength(1);

  fireEvent.click(within(screen.getByLabelText("Connected agents")).getByRole("button", { name: "Explainability Agent" }));
  expect(screen.getByRole("heading", { name: "Explainability Agent" })).toBeTruthy();
  expect(screen.getByText("Written from a script")).toBeTruthy();
  expect(screen.getByText("pressure: 60 out of 100")).toBeTruthy();
});

test("the Event Interpreter's page lists the structured events", async () => {
  serve();
  await opened();
  fireEvent.click(rail().getByRole("button", { name: "Event Interpreter" }));
  const row = screen.getByTestId("play");
  expect(row.textContent).toContain("12:05");
  expect(row.textContent).toContain("attacking third, centre");
  expect(row.textContent).toContain("#4 · 3");
});

test("switching an agent off asks the server, shows it off, and warns the agents that listen to it", async () => {
  const calls = serve();
  await opened();
  fireEvent.click(rail().getByRole("button", { name: "Prediction Agent" }));
  fireEvent.click(screen.getByRole("switch", { name: "Prediction Agent on" }));
  await waitFor(() => expect(screen.getByTestId("agent-state").textContent).toBe("Off"));
  expect(calls.find((call) => call.method === "PUT")).toEqual({ url: "/api/agents/prediction", method: "PUT", body: { enabled: false } });
  expect(screen.getByText("While this agent is off, Explainability Agent has less to work on.")).toBeTruthy();
});

test("a switch the server refuses is reported and the agent stays as it was", async () => {
  serve();
  await opened();
  fireEvent.click(rail().getByRole("button", { name: "Highlights Agent" }));
  fireEvent.click(screen.getByRole("switch", { name: "Highlights Agent on" }));
  await waitFor(() => expect(screen.getByText("The change could not be saved. Nothing was changed.")).toBeTruthy());
  expect((screen.getByRole("switch", { name: "Highlights Agent on" }) as HTMLInputElement).checked).toBe(true);
});

test("when the agents cannot be loaded the page says so and still shows their output", async () => {
  serve(null);
  renderUi(<App eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  await waitFor(() => expect(screen.getByText("The agents could not be loaded. Their output is still shown as it arrives.")).toBeTruthy());
  expect(screen.queryByTestId("agent-flow")).toBeNull();
  expect(screen.getByTestId("card-prediction")).toBeTruthy();
});

test("the older views are still a click away", async () => {
  serve();
  await opened();
  fireEvent.click(rail().getByRole("button", { name: "Match" }));
  expect(screen.getByRole("img", { name: "Pitch" })).toBeTruthy();
  fireEvent.click(rail().getByRole("button", { name: "Overlay" }));
  expect(screen.getByText("Overlays appear here once the match starts.")).toBeTruthy();
});
