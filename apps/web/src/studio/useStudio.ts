import { useCallback, useEffect, useState } from "react";
import type { Studio } from "../contracts";
import { STUDIO_STREAM } from "./api";

const CLOSED = 2;

/** The document to keep: the incoming one only if its revision is higher. */
export function newer(current: Studio | null, incoming: Studio): Studio {
  return current === null || incoming.revision > current.revision ? incoming : current;
}

function isStudio(value: unknown): value is Studio {
  return value !== null && typeof value === "object" && typeof (value as Studio).revision === "number";
}

/**
 * The studio document, kept live from the server's stream.
 *
 * The first document after each (re)connection is authoritative even if its revision is
 * lower: the server may have restarted from an older or reset file.
 */
export function useStudio(EventSourceImpl?: new (url: string) => EventSource, retryMs = 2000) {
  const [studio, setStudio] = useState<Studio | null>(null);
  const [offset, setOffset] = useState(0);
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const take = useCallback((doc: Studio, authoritative: boolean) => {
    setStudio((current) => (authoritative ? doc : newer(current, doc)));
    setOffset(doc.server_time - Date.now() / 1000);
  }, []);

  const accept = useCallback((doc: Studio) => take(doc, false), [take]);

  useEffect(() => {
    const source = new (EventSourceImpl ?? EventSource)(STUDIO_STREAM);
    let first = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    source.onopen = () => {
      first = true;
      setConnected(true);
    };
    source.onmessage = (message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        return;
      }
      if (!isStudio(parsed)) return;
      take(parsed, first);
      first = false;
    };
    source.onerror = () => {
      setConnected(false);
      // The browser retries a dropped stream itself. One the server refused stays closed.
      if (source.readyState === CLOSED) retry = setTimeout(() => setAttempt((count) => count + 1), retryMs);
    };
    return () => {
      clearTimeout(retry);
      source.close();
    };
  }, [EventSourceImpl, take, attempt, retryMs]);

  return { studio, offset, connected, accept };
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
