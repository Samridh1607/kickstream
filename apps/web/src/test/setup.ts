import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

const inBrowser = typeof window !== "undefined";

afterEach(() => {
  cleanup();
  if (inBrowser) localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// jsdom does not implement these browser APIs that Fluent UI components call.
// Tests that opt into the node environment have no window at all.
if (inBrowser && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (inBrowser) {
  globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
}
