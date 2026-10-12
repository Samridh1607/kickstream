/**
 * An EventSource-shaped reader over a WebSocket.
 *
 * Browsers allow only six HTTP connections to one server, and each EventSource holds one for
 * as long as the page is open. The studio and the program together would use them all, and no
 * button press could reach the server. WebSockets are not counted in that limit, so pages
 * follow live data through this class. It keeps the part of the EventSource interface the app
 * uses: `readyState`, `onopen`, `onmessage`, `onerror`, `close`, and reconnecting by itself.
 */

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;
/** Close codes that mean "do not come back": the match is unknown, or this page is not allowed. */
const REFUSED = new Set([4404, 1008]);

interface Place {
  protocol: string;
  host: string;
}

/** The socket address for a stream path, resuming after the last id seen when there is one. */
export function socketUrl(streamPath: string, place: Place, lastId: number): string {
  const [path, query = ""] = streamPath.split("?");
  const params = [query, lastId > 0 ? `after=${lastId}` : ""].filter(Boolean).join("&");
  const scheme = place.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${place.host}${path.replace(/\/stream$/, "/socket")}${params ? `?${params}` : ""}`;
}

export class SocketSource {
  readyState = CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private lastId = 0;
  private finished = false;
  private readonly path: string;
  private readonly Impl: typeof WebSocket;
  private readonly retryMs: number;

  constructor(path: string, Impl: typeof WebSocket = WebSocket, retryMs = 1000) {
    this.path = path;
    this.Impl = Impl;
    this.retryMs = retryMs;
    this.connect();
  }

  private connect(): void {
    const socket = new this.Impl(socketUrl(this.path, window.location, this.lastId));
    this.socket = socket;
    socket.onopen = () => {
      if (this.finished) return;
      this.readyState = OPEN;
      this.onopen?.(new Event("open"));
    };
    socket.onmessage = (message) => {
      if (this.finished) return;
      this.remember(message.data);
      this.onmessage?.({ data: message.data } as MessageEvent);
    };
    socket.onclose = (closed) => {
      if (this.finished) return;
      if (REFUSED.has(closed.code)) {
        this.readyState = CLOSED;
      } else {
        // Dropped, or the server restarted: come back, as an EventSource would.
        this.readyState = CONNECTING;
        this.retry = setTimeout(() => this.connect(), this.retryMs);
      }
      this.onerror?.(new Event("error"));
    };
  }

  /** Match envelopes carry a numeric id; remembering it lets a reconnection skip what was seen. */
  private remember(data: unknown): void {
    if (typeof data !== "string") return;
    try {
      const id = (JSON.parse(data) as { id?: unknown }).id;
      if (typeof id === "number") this.lastId = id;
    } catch {
      // Not JSON: nothing to resume from.
    }
  }

  close(): void {
    this.finished = true;
    this.readyState = CLOSED;
    clearTimeout(this.retry);
    this.socket?.close();
  }
}

/** What pages use to follow a live stream. Tests pass a scripted stand-in where this would go. */
export const LiveSource = SocketSource as unknown as new (url: string) => EventSource;
