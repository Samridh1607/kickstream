import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RELOAD_AFTER_MS, useStayAwake } from "./useStayAwake";

class FakeLock {
  requests = 0;
  sentinels: { released: boolean; release(): Promise<void> }[] = [];
  async request() {
    this.requests += 1;
    const sentinel = { released: false, release: async () => { sentinel.released = true; } };
    this.sentinels.push(sentinel);
    return sentinel;
  }
}

function fakeDocument() {
  const target = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
  target.visibilityState = "visible";
  return target;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("holds the screen awake, takes it again on coming back to the tab, and lets go on leaving the page", async () => {
  const lock = new FakeLock();
  const page = fakeDocument();
  const { unmount } = renderHook(() =>
    useStayAwake({ connected: true, reloadWhenCutOff: true, wakeLock: lock, document: page as unknown as Document }));
  await act(async () => {});
  expect(lock.requests).toBe(1);

  // Hidden, the browser drops the lock; shown again, the page asks once more.
  lock.sentinels[0].released = true;
  page.visibilityState = "hidden";
  await act(async () => { page.dispatchEvent(new Event("visibilitychange")); });
  expect(lock.requests).toBe(1);
  page.visibilityState = "visible";
  await act(async () => { page.dispatchEvent(new Event("visibilitychange")); });
  expect(lock.requests).toBe(2);

  // Still held: no second request.
  await act(async () => { page.dispatchEvent(new Event("visibilitychange")); });
  expect(lock.requests).toBe(2);

  unmount();
  await act(async () => {});
  expect(lock.sentinels[1].released).toBe(true);
});

test("a refused lock leaves the page running", async () => {
  const lock = { request: vi.fn().mockRejectedValue(new Error("NotAllowedError")) };
  const page = fakeDocument();
  renderHook(() => useStayAwake({ connected: true, reloadWhenCutOff: true, wakeLock: lock, document: page as unknown as Document }));
  await act(async () => {});
  expect(lock.request).toHaveBeenCalledOnce();
});

test("reloads only after being cut off from the server for the whole while", () => {
  const reload = vi.fn();
  const { rerender } = renderHook((connected: boolean) =>
    useStayAwake({ connected, reloadWhenCutOff: true, wakeLock: null, reload }), { initialProps: false });
  act(() => vi.advanceTimersByTime(RELOAD_AFTER_MS - 1000));
  rerender(true); // back in time
  act(() => vi.advanceTimersByTime(RELOAD_AFTER_MS * 2));
  expect(reload).not.toHaveBeenCalled();

  rerender(false);
  act(() => vi.advanceTimersByTime(RELOAD_AFTER_MS));
  expect(reload).toHaveBeenCalledOnce();
});

test("the stream's own page is never reloaded: the pipeline restarts it", () => {
  const reload = vi.fn();
  renderHook(() => useStayAwake({ connected: false, reloadWhenCutOff: false, wakeLock: null, reload }));
  act(() => vi.advanceTimersByTime(RELOAD_AFTER_MS * 3));
  expect(reload).not.toHaveBeenCalled();
});
