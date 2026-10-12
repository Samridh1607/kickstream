import { act, renderHook, waitFor } from "@testing-library/react";
import type { Audience } from "../contracts";
import { audience, FakeEventSource, FakeEventSourceCtor } from "../test/fixtures";
import { newer, useLiveDocument } from "./useLiveDocument";

beforeEach(() => {
  FakeEventSource.instances = [];
});

const hook = () => renderHook(() => useLiveDocument<Audience>("/api/audience/stream", FakeEventSourceCtor, 10));
const push = (doc: Audience) => act(() => FakeEventSource.last.emitRaw(JSON.stringify(doc)));

test("newer works for any document with a revision", () => {
  const two = audience({ revision: 2 });
  expect(newer(null, two)).toBe(two);
  expect(newer(two, audience({ revision: 1 }))).toBe(two);
  expect(newer(two, audience({ revision: 3 })).revision).toBe(3);
});

test("it follows the given stream and ignores stale documents", () => {
  const { result } = hook();
  expect(FakeEventSource.last.url).toBe("/api/audience/stream");
  act(() => FakeEventSource.last.open());
  push(audience({ revision: 4, poll_on_air: true }));
  push(audience({ revision: 3, poll_on_air: false }));
  expect(result.current.doc).toMatchObject({ revision: 4, poll_on_air: true });
  expect(result.current.connected).toBe(true);
});

test("the first document after a reconnect is taken even with a lower revision", () => {
  const { result } = hook();
  act(() => FakeEventSource.last.open());
  push(audience({ revision: 40 }));
  act(() => FakeEventSource.last.fail(0));
  act(() => FakeEventSource.last.open());
  push(audience({ revision: 0 }));
  expect(result.current.doc?.revision).toBe(0);
});

test("a refused stream is reopened, and accept applies an answer at once", async () => {
  const { result } = hook();
  const first = FakeEventSource.last;
  act(() => first.fail(2));
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
  act(() => result.current.accept(audience({ revision: 9 })));
  expect(result.current.doc?.revision).toBe(9);
});

test("offset is the server clock minus this machine's clock", () => {
  vi.spyOn(Date, "now").mockReturnValue(2_000_000);
  const { result } = hook();
  act(() => FakeEventSource.last.open());
  push(audience({ server_time: 2_030 }));
  expect(result.current.offset).toBe(30);
});
