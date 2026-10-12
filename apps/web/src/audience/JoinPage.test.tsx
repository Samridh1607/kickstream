import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Audience } from "../contracts";
import { audience, FakeEventSource, FakeEventSourceCtor, fanQuestion, poll } from "../test/fixtures";
import { renderUi } from "../test/render";
import { JoinPage } from "./JoinPage";

interface Call {
  url: string;
  voter: string | null;
  body: any;
}

function serve(doc: Audience) {
  const calls: Call[] = [];
  const server = { calls, refuse: null as null | { status: number; msg: string } };
  const reply = (statusCode: number, body: unknown) => new Response(JSON.stringify(body), { status: statusCode });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, voter: new Headers(init?.headers).get("x-voter"), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (server.refuse) return reply(server.refuse.status, { detail: [{ loc: ["body", "text"], msg: server.refuse.msg, type: "refusal" }] });
    const next = { ...doc, revision: doc.revision + calls.length };
    return url.endsWith("/questions") ? reply(201, { id: "q-new", audience: next }) : reply(200, next);
  }));
  return server;
}

beforeEach(() => {
  FakeEventSource.instances = [];
});

function opened(doc: Audience) {
  const server = serve(doc);
  const view = renderUi(<JoinPage eventSource={FakeEventSourceCtor} retryMs={10} />);
  act(() => {
    FakeEventSource.last.open();
    FakeEventSource.last.emitRaw(JSON.stringify(doc));
  });
  return { server, view };
}

const doc = () => audience({ poll: poll(), questions: [fanQuestion()] });

test("it follows the fan stream and shows the poll and questions", () => {
  opened(doc());
  expect(FakeEventSource.last.url).toBe("/api/audience/stream");
  expect(screen.getByText("Who will win?")).toBeTruthy();
  expect(screen.getByText("Why the change?")).toBeTruthy();
});

test("a vote is sent with this browser's id and remembered across a reload", async () => {
  const { server, view } = opened(doc());
  fireEvent.click(screen.getByRole("button", { name: "Harbour City" }));
  await waitFor(() => expect(server.calls).toHaveLength(1));
  expect(server.calls[0]).toMatchObject({ url: "/api/audience/poll/vote", body: { option_id: "o3" } });
  expect(server.calls[0].voter).toMatch(/^[A-Za-z0-9-]{16,64}$/);
  await waitFor(() => expect(within(screen.getByTestId("poll-option-o3")).getByText("Your vote")).toBeTruthy());

  view.unmount();
  opened(doc());
  expect(within(screen.getByTestId("poll-option-o3")).getByText("Your vote")).toBeTruthy();
  expect(screen.queryByText("Vote to see the results.")).toBeNull();
});

test("every request from one browser carries the same id", async () => {
  const { server } = opened(doc());
  fireEvent.click(screen.getByRole("button", { name: "Draw" }));
  fireEvent.click(screen.getByRole("button", { name: "Upvote: Why the change?" }));
  await waitFor(() => expect(server.calls).toHaveLength(2));
  expect(server.calls[1].url).toBe("/api/audience/questions/q1/vote");
  expect(server.calls[1].voter).toBe(server.calls[0].voter);
});

test("an upvote is remembered, and pressing again is sent to remove it", async () => {
  const { server } = opened(doc());
  const upvote = () => screen.getByRole("button", { name: "Upvote: Why the change?" });
  fireEvent.click(upvote());
  await waitFor(() => expect(upvote().getAttribute("aria-pressed")).toBe("true"));
  fireEvent.click(upvote());
  await waitFor(() => expect(upvote().getAttribute("aria-pressed")).toBe("false"));
  expect(server.calls).toHaveLength(2);
});

test("a question the fan asks is marked as theirs", async () => {
  const start = doc();
  const { server } = opened(start);
  fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "Who is pressing?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(server.calls).toHaveLength(1));
  expect(server.calls[0]).toMatchObject({ url: "/api/audience/questions", body: { text: "Who is pressing?", nickname: "" } });
  const withMine = audience({ revision: 50, poll: poll(), questions: [fanQuestion(), fanQuestion({ id: "q-new", text: "Who is pressing?", nickname: "Fan", votes: 1 })] });
  act(() => FakeEventSource.last.emitRaw(JSON.stringify(withMine)));
  expect(within(screen.getByTestId("question-q-new")).getByText("Yours")).toBeTruthy();
});

test("a refusal shows the server's reason and remembers nothing", async () => {
  const { server } = opened(doc());
  server.refuse = { status: 409, msg: "This poll is closed." };
  fireEvent.click(screen.getByRole("button", { name: "Harbour City" }));
  expect(await screen.findByText("This poll is closed.")).toBeTruthy();
  expect(screen.getByText("Vote to see the results.")).toBeTruthy();
  expect(JSON.parse(localStorage.getItem("kickstream.choices") ?? "{}").polls ?? {}).toEqual({});
});

test("a request that never reaches the server shows a retry message in the fan's language", async () => {
  opened(doc());
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
  fireEvent.change(screen.getByLabelText("Language"), { target: { value: "es" } });
  fireEvent.click(screen.getByRole("button", { name: "Harbour City" }));
  expect(await screen.findByText("No se pudo enviar. Inténtalo de nuevo.")).toBeTruthy();
});

test("the language picker changes the page and is remembered", () => {
  opened(doc());
  fireEvent.change(screen.getByLabelText("Language"), { target: { value: "hi" } });
  expect(screen.getByRole("button", { name: "भेजें" })).toBeTruthy();
  expect(JSON.parse(localStorage.getItem("kickstream.profile") ?? "{}").language).toBe("hi");
});
