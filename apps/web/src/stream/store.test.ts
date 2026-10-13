import {
  agentRun, envelope, explanation, highlight, matchEvent, moment, narrative, overlay, pitchScene, play, playerReport, prediction, pressure,
  recap, stats, status, tactics,
} from "../test/fixtures";
import { EMPTY, latestOverlays, reduce, useMatch } from "./store";

const apply = (...envelopes: ReturnType<typeof envelope>[]) => envelopes.reduce(reduce, EMPTY);

test("each envelope type lands in its slice", () => {
  const data = apply(
    envelope(1, "match_status", status({ score_home: 1 })),
    envelope(2, "match_event", matchEvent()),
    envelope(3, "stats", stats({ shots: 4 })),
    envelope(4, "pressure", pressure()),
    envelope(5, "key_moment", moment(), true),
    envelope(6, "narrative", narrative(), true),
    envelope(7, "recap", recap()),
    envelope(8, "overlay", overlay()),
  );
  expect(data.lastId).toBe(8);
  expect(data.status?.score_home).toBe(1);
  expect(data.events).toHaveLength(1);
  expect(data.stats?.home.shots).toBe(4);
  expect(data.pressure?.cols).toBe(6);
  expect(data.moments).toEqual([{ ...moment(), highlighted: true }]);
  expect(data.narratives).toEqual([{ ...narrative(), highlighted: true }]);
  expect(data.recaps).toHaveLength(1);
  expect(data.overlays).toHaveLength(1);
});

test("narratives are newest first and moments oldest first", () => {
  const data = apply(
    envelope(1, "key_moment", moment({ id: "k1" })),
    envelope(2, "key_moment", moment({ id: "k2" })),
    envelope(3, "narrative", narrative({ id: "n1" })),
    envelope(4, "narrative", narrative({ id: "n2" })),
  );
  expect(data.moments.map((m) => m.id)).toEqual(["k1", "k2"]);
  expect(data.narratives.map((n) => n.id)).toEqual(["n2", "n1"]);
});

test("a repeated or older envelope is ignored", () => {
  const once = apply(envelope(5, "narrative", narrative()));
  expect(reduce(once, envelope(5, "narrative", narrative()))).toBe(once);
  expect(reduce(once, envelope(3, "narrative", narrative({ id: "older" })))).toBe(once);
});

test("an unknown envelope type advances the id and changes nothing else", () => {
  const data = reduce(EMPTY, { ...envelope(4, "stats", {}), type: "weather" as never });
  expect(data).toEqual({ ...EMPTY, lastId: 4 });
});

test("only the most recent events and overlays are kept", () => {
  let data = EMPTY;
  for (let id = 1; id <= 400; id++) data = reduce(data, envelope(id, "match_event", matchEvent({ seq: id })));
  expect(data.events).toHaveLength(40);
  expect(data.events[39].seq).toBe(400);
  for (let id = 401; id <= 800; id++) data = reduce(data, envelope(id, "overlay", overlay({ id: `o${id}` })));
  expect(data.overlays).toHaveLength(300);
  expect(data.overlays[299].id).toBe("o800");
});

test("latestOverlays keeps the newest overlay of each kind", () => {
  const latest = latestOverlays([
    overlay({ id: "a", kind: "lower_third" }),
    overlay({ id: "b", kind: "stat_card" }),
    overlay({ id: "c", kind: "lower_third" }),
  ]);
  expect(latest.lower_third?.id).toBe("c");
  expect(latest.stat_card?.id).toBe("b");
  expect(latest.recap_card).toBeUndefined();
});

test("the store applies envelopes, selects and resets", () => {
  const store = useMatch.getState();
  store.apply(envelope(1, "narrative", narrative()));
  store.select("m-1-k1");
  store.setConnection("live");
  expect(useMatch.getState().data.narratives).toHaveLength(1);
  expect(useMatch.getState().selectedId).toBe("m-1-k1");
  store.reset();
  expect(useMatch.getState()).toMatchObject({ data: EMPTY, selectedId: null, connection: "connecting" });
});

test("the match clock follows the newest envelope and never runs backwards", () => {
  let data = reduce(EMPTY, { ...envelope(1, "match_status", status()), minute: 0 });
  data = reduce(data, { ...envelope(2, "match_event", matchEvent()), minute: 37 });
  expect(data.minute).toBe(37);
  data = reduce(data, { ...envelope(3, "narrative", narrative()), minute: 23 });
  expect(data.minute).toBe(37);
});

test("what the match agents find lands in its own slices", () => {
  const data = apply(
    envelope(1, "play", play()),
    envelope(2, "tactics", tactics()),
    envelope(3, "prediction", prediction()),
    envelope(4, "explanation", explanation({ id: "x1" })),
    envelope(5, "explanation", explanation({ id: "x2" })),
    envelope(6, "pitch_scene", pitchScene()),
    envelope(7, "players", playerReport()),
    envelope(8, "highlight", highlight(), true),
    envelope(9, "agent_run", agentRun({ id: "r1" })),
    envelope(10, "agent_run", agentRun({ id: "r2" })),
  );
  expect(data.plays).toHaveLength(1);
  expect(data.tactics?.rhythm).toBe("fast");
  expect(data.prediction?.win_home).toBe(0.5);
  expect(data.explanations.map((item) => item.id)).toEqual(["x2", "x1"]); // newest first
  expect(data.pitch?.camera).toBe("attack_home");
  expect(data.players?.players).toHaveLength(2);
  expect(data.highlights).toEqual([{ ...highlight(), highlighted: true }]);
  expect(data.runs.map((run) => run.id)).toEqual(["r2", "r1"]);
});

test("stats and predictions build one point a minute for the graphs, in order, whichever arrives first", () => {
  const data = apply(
    envelope(1, "prediction", prediction({ minute: 2, win_home: 0.6, draw: 0.25, win_away: 0.15 })),
    envelope(2, "stats", { ...stats({ xg: 0.4 }, { xg: 0.1 }, 0.3), minute: 2 }),
    envelope(3, "stats", { ...stats({ xg: 0.2 }, { xg: 0.1 }, -0.1), minute: 1 }),
    envelope(4, "stats", { ...stats({ xg: 0.5 }, { xg: 0.1 }, 0.5), minute: 2 }),
  );
  expect(data.series).toEqual([
    { minute: 1, momentum: -0.1, xgHome: 0.2, xgAway: 0.1, winHome: null, draw: null, winAway: null },
    { minute: 2, momentum: 0.5, xgHome: 0.5, xgAway: 0.1, winHome: 0.6, draw: 0.25, winAway: 0.15 },
  ]);
});

test("only the latest structured events and runs are kept", () => {
  const many = Array.from({ length: 100 }, (_, index) => [
    envelope(index * 2 + 1, "play", play({ id: `y${index}` })), envelope(index * 2 + 2, "agent_run", agentRun({ id: `r${index}` })),
  ]).flat();
  const data = apply(...many);
  expect(data.plays).toHaveLength(40);
  expect(data.plays.at(-1)?.id).toBe("y99");
  expect(data.runs).toHaveLength(80);
  expect(data.runs[0].id).toBe("r99");
});
