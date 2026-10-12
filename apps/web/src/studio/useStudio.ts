import { useEffect, useState } from "react";
import type { Studio } from "../contracts";
import { newer, useLiveDocument } from "../stream/useLiveDocument";
import { STUDIO_STREAM } from "./api";

export { newer };

/** The studio document, kept live from the server's stream. */
export function useStudio(EventSourceImpl?: new (url: string) => EventSource, retryMs = 2000) {
  const { doc, offset, connected, accept } = useLiveDocument<Studio>(STUDIO_STREAM, EventSourceImpl, retryMs);
  return { studio: doc, offset, connected, accept };
}

/** This machine's clock in Unix seconds, refreshed on an interval. Add `offset` for server time. */
export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
