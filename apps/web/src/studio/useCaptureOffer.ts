import { useEffect, useMemo } from "react";
import { startCapture, type StopCapture } from "./capture";

/**
 * Opened by the pipeline's hidden browser with a `capture` token, a page offers to record itself.
 * It offers only once `ready`, so the stream never begins on an empty frame. The pipeline calls
 * the function; a page may only ask to be captured in answer to an action.
 */
export function useCaptureOffer(ready: boolean, capture: typeof startCapture = startCapture) {
  const token = useMemo(() => new URLSearchParams(window.location.search).get("capture"), []);
  useEffect(() => {
    if (!token || !ready) return;
    const page = window as unknown as { __kickstreamStartCapture?: () => Promise<void> };
    // At most one capture at a time: a call while one starts or runs gets the same promise.
    let current: Promise<void> | null = null;
    let stopRunning: (() => void) | null = null;
    let gone = false;
    page.__kickstreamStartCapture = () => {
      if (current) return current;
      const attempt: Promise<void> = (async () => {
        const stop = await capture(token, { width: window.innerWidth, height: window.innerHeight });
        if (gone) {
          stop();
          return;
        }
        stopRunning = stop;
        // Once it has ended by itself, a later call may start a new one.
        void (stop as StopCapture).ended?.then(() => {
          if (current === attempt) {
            current = null;
            stopRunning = null;
          }
        });
      })();
      current = attempt;
      attempt.catch(() => {
        if (current === attempt) current = null;
      });
      return attempt;
    };
    return () => {
      gone = true;
      stopRunning?.();
      delete page.__kickstreamStartCapture;
    };
  }, [token, ready, capture]);
}
