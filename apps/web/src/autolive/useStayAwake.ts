import { useEffect } from "react";

/** Cut off from the server this long, the page starts over rather than wait on reconnects that are not coming. */
export const RELOAD_AFTER_MS = 120_000;

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
}

interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

export interface StayAwakeOptions {
  /** Whether the page's live document is following the server. */
  connected: boolean;
  /** Reload the page after being cut off for `RELOAD_AFTER_MS`; off on the stream's own page, which the pipeline restarts. */
  reloadWhenCutOff: boolean;
  /** Stand-ins for the browser, for tests. */
  wakeLock?: WakeLockLike | null;
  reload?: () => void;
  document?: Document;
}

/**
 * Keeps a page that is left running for days on screen and on air: the screen is kept from sleeping
 * (the browser drops the lock whenever the tab is hidden, so it is taken again on return), and a page
 * that has lost the server for good loads itself again.
 */
export function useStayAwake({ connected, reloadWhenCutOff, wakeLock, reload, document: doc }: StayAwakeOptions) {
  useEffect(() => {
    const page = doc ?? (typeof document !== "undefined" ? document : undefined);
    const lock = wakeLock !== undefined ? wakeLock : (typeof navigator !== "undefined" ? (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock : undefined);
    if (!page || !lock) return;
    let held: WakeLockSentinelLike | null = null;
    let gone = false;
    const take = async () => {
      if (gone || page.visibilityState !== "visible" || (held && !held.released)) return;
      try {
        const sentinel = await lock.request("screen");
        if (gone) void sentinel.release().catch(() => undefined);
        else held = sentinel;
      } catch {
        // Refused (battery saver, or no permission): the page runs on, the screen may sleep.
      }
    };
    const onVisibility = () => void take();
    void take();
    page.addEventListener("visibilitychange", onVisibility);
    return () => {
      gone = true;
      page.removeEventListener("visibilitychange", onVisibility);
      if (held && !held.released) void held.release().catch(() => undefined);
    };
  }, [wakeLock, doc]);

  useEffect(() => {
    if (connected || !reloadWhenCutOff) return;
    const timer = setTimeout(() => (reload ?? (() => window.location.reload()))(), RELOAD_AFTER_MS);
    return () => clearTimeout(timer);
  }, [connected, reloadWhenCutOff, reload]);
}
