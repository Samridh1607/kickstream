import { type Choices, getVoter, loadChoices, saveChoices, withAsked, withPollVote, withUpvoteToggled } from "./voter";

const VALID = /^[A-Za-z0-9-]{16,64}$/;

test("a browser gets one id and keeps it", () => {
  const first = getVoter();
  expect(first.id).toMatch(VALID);
  expect(first.remembered).toBe(true);
  expect(getVoter().id).toBe(first.id);
});

test.each([["garbage", "not a valid id!"], ["too short", "abc"], ["empty", ""]])("a stored id that is %s is replaced", (_, stored) => {
  localStorage.setItem("kickstream.voter", stored);
  const voter = getVoter();
  expect(voter.id).toMatch(VALID);
  expect(voter.id).not.toBe(stored);
  expect(localStorage.getItem("kickstream.voter")).toBe(voter.id);
});

test("with storage blocked the id lasts for the visit and says it is not remembered", () => {
  const blocked = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  const first = getVoter(blocked);
  expect(first.id).toMatch(VALID);
  expect(first.remembered).toBe(false);
  expect(getVoter(blocked).id).toBe(first.id);
  expect(loadChoices(blocked)).toEqual({ polls: {}, upvoted: [], asked: [] });
  expect(() => saveChoices({ polls: { p1: "o1" }, upvoted: [], asked: [] }, blocked)).not.toThrow();
});

test("choices are saved and read back", () => {
  expect(loadChoices()).toEqual({ polls: {}, upvoted: [], asked: [] });
  saveChoices({ polls: { p1: "o2" }, upvoted: ["q1"], asked: ["q2"] });
  expect(loadChoices()).toEqual({ polls: { p1: "o2" }, upvoted: ["q1"], asked: ["q2"] });
});

test.each([["invalid JSON", "{oops"], ["the wrong shape", '{"polls": 5, "upvoted": "x"}'], ["an array", "[1]"]])(
  "saved choices that are %s give empty choices", (_, raw) => {
    localStorage.setItem("kickstream.choices", raw);
    expect(loadChoices()).toEqual({ polls: {}, upvoted: [], asked: [] });
  });

test("recording a vote, an upvote and a question returns new choices", () => {
  const empty = { polls: {}, upvoted: [], asked: [] };
  expect(withPollVote(empty, "p1", "o1")).toEqual({ polls: { p1: "o1" }, upvoted: [], asked: [] });
  expect(withPollVote(withPollVote(empty, "p1", "o1"), "p1", "o3").polls).toEqual({ p1: "o3" });
  const up = withUpvoteToggled(empty, "q1");
  expect(up.upvoted).toEqual(["q1"]);
  expect(withUpvoteToggled(up, "q1").upvoted).toEqual([]);
  expect(withAsked(withAsked(empty, "q9"), "q9").asked).toEqual(["q9"]);
  expect(empty).toEqual({ polls: {}, upvoted: [], asked: [] });
});

test("only the forty most recent polls are remembered", () => {
  let choices: Choices = { polls: {}, upvoted: [], asked: [] };
  for (let n = 0; n < 45; n += 1) choices = withPollVote(choices, `p${n}`, "o1");
  expect(Object.keys(choices.polls)).toHaveLength(40);
  expect(choices.polls.p0).toBeUndefined();
  expect(choices.polls.p44).toBe("o1");
});
