import type { Envelope } from "../contracts";
import type { Connection } from "./store";

export interface StreamHandlers {
  onEnvelope(envelope: Envelope): void;
  onConnection(connection: Connection): void;
}

const CLOSED = 2;

function isEnvelope(value: unknown): value is Envelope {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "number" && typeof candidate.type === "string";
}

/**
 * Opens the one stream connection for a viewer. The browser reconnects a dropped connection
 * by itself and sends Last-Event-ID, so the server replays only what was missed. A connection
 * the server refuses (unknown match) is left closed and reported as "no_match".
 */
export function connect(
  url: string,
  handlers: StreamHandlers,
  EventSourceImpl: new (url: string) => EventSource = EventSource,
): () => void {
  handlers.onConnection("connecting");
  const source = new EventSourceImpl(url);
  source.onopen = () => handlers.onConnection("live");
  source.onmessage = (message) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch {
      return;
    }
    if (isEnvelope(parsed)) handlers.onEnvelope(parsed);
  };
  source.onerror = () => handlers.onConnection(source.readyState === CLOSED ? "no_match" : "reconnecting");
  return () => source.close();
}
