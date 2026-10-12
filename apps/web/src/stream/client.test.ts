import { envelope, FakeEventSource, FakeEventSourceCtor, narrative } from "../test/fixtures";
import { connect } from "./client";
import type { Connection } from "./store";

function setup() {
  FakeEventSource.instances = [];
  const connections: Connection[] = [];
  const received: unknown[] = [];
  const close = connect(
    "/api/matches/m-1/stream?mode=fan&lang=en",
    { onEnvelope: (item) => received.push(item), onConnection: (state) => connections.push(state) },
    FakeEventSourceCtor,
  );
  return { source: FakeEventSource.last, connections, received, close };
}

test("it opens the given url and reports connecting then live", () => {
  const { source, connections } = setup();
  expect(source.url).toBe("/api/matches/m-1/stream?mode=fan&lang=en");
  source.open();
  expect(connections).toEqual(["connecting", "live"]);
});

test("it passes parsed envelopes on", () => {
  const { source, received } = setup();
  const item = envelope(7, "narrative", narrative());
  source.emit(item);
  expect(received).toEqual([item]);
});

test.each([
  ["malformed JSON", "{oops"],
  ["a non-object", "42"],
  ["null", "null"],
  ["an object without an id", JSON.stringify({ type: "narrative", payload: {} })],
  ["an object without a type", JSON.stringify({ id: 3, payload: {} })],
])("it skips %s without failing", (_, data) => {
  const { source, received } = setup();
  source.emitRaw(data);
  source.emit(envelope(8, "narrative", narrative()));
  expect(received).toHaveLength(1);
});

test("a dropped connection the browser will retry is reported as reconnecting", () => {
  const { source, connections } = setup();
  source.open();
  source.fail(0);
  source.open();
  expect(connections).toEqual(["connecting", "live", "reconnecting", "live"]);
});

test("a connection the server refused is reported as no_match", () => {
  const { source, connections } = setup();
  source.fail(2);
  expect(connections).toEqual(["connecting", "no_match"]);
});

test("the returned function closes the connection", () => {
  const { source, close } = setup();
  close();
  expect(source.closed).toBe(true);
});
