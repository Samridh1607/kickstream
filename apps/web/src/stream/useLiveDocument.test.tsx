import { act, renderHook, waitFor } from "@testing-library/react";
import type { Broadcasts } from "../contracts";
import { broadcasts, FakeEventSource, FakeEventSourceCtor } from "../test/fixtures";
import { newer, useLiveDocument } from "./useLiveDocument";

beforeEach(() => {
  FakeEventSource.instances = [];
});

const hook = () => renderHook(() => useLiveDocument<Broadcasts>("/api/broadcasts/stream", FakeEventSourceCtor, 10));
const push = (doc: Broadcasts) => act(() => FakeEventSource.last.emitRaw(JSON.stringify(doc)));

test("newer works for any document with a revision", () => {
  const two = broadcasts({ revision: 2 });
  expect(newer(null, two)).toBe(two);
  expect(newer(two, broadcasts({ revision: 1 }))).toBe(two);
  expect(newer(two, broadcasts({ revision: 3 })).revision).toBe(3);
});

test("it follows the given stream and ignores stale documents", () => {
  const { result } = hook();
  expect(FakeEventSource.last.url).toBe("/api/broadcasts/stream");
  act(() => FakeEventSource.last.open());
  push(broadcasts({ revision: 4, current_id: "b4" }));
  push(broadcasts({ revision: 3, current_id: "b3" }));
  expect(result.current.doc).toMatchObject({ revision: 4, current_id: "b4" });
  expect(result.current.connected).toBe(true);
});

test("the first document after a reconnect is taken even with a lower revision", () => {
  const { result } = hook();
  act(() => FakeEventSource.last.open());
  push(broadcasts({ revision: 40 }));
  act(() => FakeEventSource.last.fail(0));
  act(() => FakeEventSource.last.open());
  push(broadcasts({ revision: 0 }));
  expect(result.current.doc?.revision).toBe(0);
});

test("a refused stream is reopened, and accept applies an answer at once", async () => {
  const { result } = hook();
  const first = FakeEventSource.last;
  act(() => first.fail(2));
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
  act(() => result.current.accept(broadcasts({ revision: 9 })));
  expect(result.current.doc?.revision).toBe(9);
});

test("offset is the server clock minus this machine's clock", () => {
  vi.spyOn(Date, "now").mockReturnValue(2_000_000);
  const { result } = hook();
  act(() => FakeEventSource.last.open());
  push(broadcasts({ server_time: 2_030 }));
  expect(result.current.offset).toBe(30);
});

test("with no address there is nothing to follow", () => {
  const { result } = renderHook(() => useLiveDocument<Broadcasts>(null, FakeEventSourceCtor, 10));
  expect(FakeEventSource.instances).toHaveLength(0);
  expect([result.current.doc, result.current.connected]).toEqual([null, false]);
});
