import { act, renderHook, waitFor } from "@testing-library/react";
import { FakeEventSource, FakeEventSourceCtor, studio } from "../test/fixtures";
import { newer, useStudio } from "./useStudio";

beforeEach(() => {
  FakeEventSource.instances = [];
});

const push = (doc: ReturnType<typeof studio>) => act(() => FakeEventSource.last.emitRaw(JSON.stringify(doc)));

test("newer keeps the document with the higher revision", () => {
  const two = studio({ revision: 2 });
  expect(newer(null, two)).toBe(two);
  expect(newer(two, studio({ revision: 1 }))).toBe(two);
  expect(newer(two, studio({ revision: 2 }))).toBe(two);
  const three = studio({ revision: 3 });
  expect(newer(two, three)).toBe(three);
});

test("it opens the studio stream and follows it, ignoring stale documents", () => {
  const { result } = renderHook(() => useStudio(FakeEventSourceCtor, 10));
  expect(FakeEventSource.last.url).toBe("/api/studio/stream");
  expect(result.current.studio).toBeNull();
  act(() => FakeEventSource.last.open());
  push(studio({ revision: 4 }));
  expect(result.current.studio?.revision).toBe(4);
  expect(result.current.connected).toBe(true);
  push(studio({ revision: 3, active_scene_id: "s2" }));
  expect(result.current.studio?.active_scene_id).toBe("s1");
  push(studio({ revision: 5, active_scene_id: "s2" }));
  expect(result.current.studio?.active_scene_id).toBe("s2");
});

test("the first document after a reconnect is taken even if its revision is lower", () => {
  const { result } = renderHook(() => useStudio(FakeEventSourceCtor, 10));
  act(() => FakeEventSource.last.open());
  push(studio({ revision: 40 }));
  act(() => FakeEventSource.last.fail(0));
  expect(result.current.connected).toBe(false);
  act(() => FakeEventSource.last.open());
  push(studio({ revision: 0, active_scene_id: "s2" }));
  expect(result.current.studio).toMatchObject({ revision: 0, active_scene_id: "s2" });
});

test("a refused stream is reopened after a pause", async () => {
  renderHook(() => useStudio(FakeEventSourceCtor, 10));
  const first = FakeEventSource.last;
  act(() => first.fail(2));
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
  expect(first.closed).toBe(true);
});

test("accept applies the answer to a change at once, unless the stream is already ahead", () => {
  const { result } = renderHook(() => useStudio(FakeEventSourceCtor, 10));
  act(() => FakeEventSource.last.open());
  push(studio({ revision: 5 }));
  act(() => result.current.accept(studio({ revision: 6, active_scene_id: "s2" })));
  expect(result.current.studio?.active_scene_id).toBe("s2");
  act(() => result.current.accept(studio({ revision: 4, active_scene_id: "s1" })));
  expect(result.current.studio?.active_scene_id).toBe("s2");
});

test("offset is the server clock minus this machine's clock", () => {
  vi.spyOn(Date, "now").mockReturnValue(2_000_000);
  const { result } = renderHook(() => useStudio(FakeEventSourceCtor, 10));
  act(() => FakeEventSource.last.open());
  push(studio({ server_time: 2_090 }));
  expect(result.current.offset).toBe(90);
});

test("garbage on the stream is ignored", () => {
  const { result } = renderHook(() => useStudio(FakeEventSourceCtor, 10));
  act(() => FakeEventSource.last.open());
  act(() => FakeEventSource.last.emitRaw("{oops"));
  act(() => FakeEventSource.last.emitRaw("42"));
  expect(result.current.studio).toBeNull();
});
