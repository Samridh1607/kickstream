import { audience } from "../test/fixtures";
import { StudioRequestError } from "../studio/api";
import { airDraft, askQuestion, createPoll, presetPoll, saveDraft, setPollOnAir, upvoteQuestion, votePoll } from "./api";

function serve(statusCode: number, body: unknown, headers: Record<string, string> = {}) {
  const mock = vi.fn(async () => new Response(JSON.stringify(body), { status: statusCode, headers }));
  vi.stubGlobal("fetch", mock);
  return () => {
    const [url, init] = mock.mock.calls[mock.mock.calls.length - 1] as unknown as [string, RequestInit];
    return { url, method: init.method, voter: new Headers(init.headers).get("x-voter"), body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
  };
}

test("fan calls carry the browser's id", async () => {
  const last = serve(200, audience({ revision: 5 }));
  expect((await votePoll("voter-ann-0000001", "o2")).revision).toBe(5);
  expect(last()).toEqual({ url: "/api/audience/poll/vote", method: "POST", voter: "voter-ann-0000001", body: { option_id: "o2" } });
  await upvoteQuestion("voter-ann-0000001", "q 1");
  expect(last()).toMatchObject({ url: "/api/audience/questions/q%201/vote", voter: "voter-ann-0000001" });
});

test("asking returns the new question's id with the audience", async () => {
  const last = serve(201, { id: "q7", audience: audience() });
  const asked = await askQuestion("voter-ann-0000001", "Why?", "Ann");
  expect(asked.id).toBe("q7");
  expect(last().body).toEqual({ text: "Why?", nickname: "Ann" });
});

test("studio calls go to the studio routes without a voter id", async () => {
  const last = serve(200, audience());
  await createPoll({ question: "Who wins?", options: ["A", "B"], duration_s: 60 });
  expect(last()).toEqual({ url: "/api/studio/audience/poll", method: "POST", voter: null, body: { question: "Who wins?", options: ["A", "B"], duration_s: 60 } });
  await presetPoll("winner");
  expect(last().body).toEqual({ preset: "winner" });
  await setPollOnAir(true);
  expect(last()).toMatchObject({ url: "/api/studio/audience/poll/on-air", method: "PUT", body: { on: true } });
  await saveDraft("An answer.");
  expect(last()).toMatchObject({ url: "/api/studio/audience/draft", method: "PUT", body: { text: "An answer." } });
  await airDraft();
  expect(last()).toMatchObject({ url: "/api/studio/audience/draft/air", method: "POST", body: {} });
  await airDraft(45);
  expect(last().body).toEqual({ duration_s: 45 });
});

test("a refusal carries the server's message", async () => {
  serve(429, { detail: [{ loc: ["body", "text"], msg: "You can ask again in 18 seconds.", type: "refusal" }] }, { "retry-after": "18" });
  const error = await askQuestion("voter-ann-0000001", "Again?", "").catch((caught) => caught);
  expect(error).toBeInstanceOf(StudioRequestError);
  expect([error.status, error.field, error.message]).toEqual([429, "text", "You can ask again in 18 seconds."]);
});
