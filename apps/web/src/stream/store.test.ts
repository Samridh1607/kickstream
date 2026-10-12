import {
  envelope, matchEvent, moment, narrative, overlay, pressure, recap, stats, status,
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
