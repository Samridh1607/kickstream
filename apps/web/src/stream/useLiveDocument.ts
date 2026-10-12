import { useCallback, useEffect, useState } from "react";

const CLOSED = 2;

interface Revisioned {
  revision: number;
}

/** The document to keep: the incoming one only if its revision is higher. */
export function newer<T extends Revisioned>(current: T | null, incoming: T): T {
  return current === null || incoming.revision > current.revision ? incoming : current;
}

function hasRevision(value: unknown): value is Revisioned {
  return value !== null && typeof value === "object" && typeof (value as Revisioned).revision === "number";
}

/**
 * A server-held document, kept live from a Server-Sent Events stream.
 *
 * The first document after each (re)connection is authoritative even if its revision is
 * lower: the server may have restarted from an older or reset file.
 */
export function useLiveDocument<T extends Revisioned & { server_time: number }>(
  url: string,
  EventSourceImpl?: new (url: string) => EventSource,
  retryMs = 2000,
) {
  const [doc, setDoc] = useState<T | null>(null);
  const [offset, setOffset] = useState(0);
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const take = useCallback((incoming: T, authoritative: boolean) => {
    setDoc((current) => (authoritative ? incoming : newer(current, incoming)));
    setOffset(incoming.server_time - Date.now() / 1000);
  }, []);

  const accept = useCallback((incoming: T) => take(incoming, false), [take]);

  useEffect(() => {
    const source = new (EventSourceImpl ?? EventSource)(url);
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
      if (!hasRevision(parsed)) return;
      take(parsed as T, first);
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
  }, [url, EventSourceImpl, take, attempt, retryMs]);

  return { doc, offset, connected, accept };
}
