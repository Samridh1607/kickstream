import { SocketSource, socketUrl } from "./SocketSource";

/** A scriptable stand-in for the browser WebSocket. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static get last(): FakeSocket {
    return FakeSocket.instances[FakeSocket.instances.length - 1];
  }

  closedByPage = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  close() {
    this.closedByPage = true;
  }
}

const Impl = FakeSocket as unknown as typeof WebSocket;

function setup(url = "/api/studio/stream") {
  FakeSocket.instances = [];
  const events: string[] = [];
  const source = new SocketSource(url, Impl, 10);
  source.onopen = () => events.push("open");
  source.onmessage = (message) => events.push(`message:${message.data}`);
  source.onerror = () => events.push(`error:${source.readyState}`);
  return { source, events };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a stream path becomes the socket path on this page's host", () => {
  const here = { protocol: "http:", host: "127.0.0.1:5173" };
  expect(socketUrl("/api/studio/stream", here, 0)).toBe("ws://127.0.0.1:5173/api/studio/socket");
  expect(socketUrl("/api/matches/m-1/stream?mode=fan&lang=en", here, 0)).toBe("ws://127.0.0.1:5173/api/matches/m-1/socket?mode=fan&lang=en");
  expect(socketUrl("/api/broadcasts/stream", { protocol: "https:", host: "kick.example" }, 0)).toBe("wss://kick.example/api/broadcasts/socket");
});

test("a reconnection asks for what came after the last id it saw", () => {
  const here = { protocol: "http:", host: "h" };
  expect(socketUrl("/api/matches/m-1/stream?mode=fan&lang=en", here, 412)).toBe("ws://h/api/matches/m-1/socket?mode=fan&lang=en&after=412");
  expect(socketUrl("/api/studio/stream", here, 7)).toBe("ws://h/api/studio/socket?after=7");
});

test("it reports open and passes messages on, like an EventSource", () => {
  const { source, events } = setup();
  expect(source.readyState).toBe(0);
  expect(FakeSocket.last.url).toMatch(/\/api\/studio\/socket$/);
  FakeSocket.last.onopen?.();
  expect(source.readyState).toBe(1);
  FakeSocket.last.onmessage?.({ data: '{"revision":1}' });
  expect(events).toEqual(["open", 'message:{"revision":1}']);
});

test("a dropped socket is reopened and reported as connecting, not closed", async () => {
  const { source, events } = setup("/api/matches/m-1/stream?mode=fan&lang=en");
  const first = FakeSocket.last;
  first.onopen?.();
  first.onmessage?.({ data: '{"id":41,"type":"stats"}' });
  first.onmessage?.({ data: '{"id":42,"type":"stats"}' });
  first.onclose?.({ code: 1006 });
  expect(source.readyState).toBe(0);
  expect(events[events.length - 1]).toBe("error:0");
  await wait(40);
  expect(FakeSocket.instances).toHaveLength(2);
  expect(FakeSocket.last.url).toMatch(/socket\?mode=fan&lang=en&after=42$/);
  FakeSocket.last.onopen?.();
  expect(events[events.length - 1]).toBe("open");
});

test.each([4404, 1008])("a socket the server refused with %d stays closed", async (code) => {
  const { source, events } = setup();
  FakeSocket.last.onclose?.({ code });
  expect(source.readyState).toBe(2);
  expect(events).toEqual(["error:2"]);
  await wait(40);
  expect(FakeSocket.instances).toHaveLength(1);
});

test("closing stops everything, including a reconnection already scheduled", async () => {
  const { source, events } = setup();
  FakeSocket.last.onclose?.({ code: 1006 });
  source.close();
  expect(source.readyState).toBe(2);
  await wait(40);
  expect(FakeSocket.instances).toHaveLength(1);

  const again = setup();
  again.source.close();
  expect(FakeSocket.last.closedByPage).toBe(true);
  FakeSocket.last.onclose?.({ code: 1000 });
  FakeSocket.last.onmessage?.({ data: "late" });
  expect(again.events).toEqual([]);
  expect(events).toEqual(["error:0"]);
});

test("messages that are not JSON are still passed on and do not disturb the resume point", () => {
  const { events } = setup("/api/matches/m-1/stream");
  FakeSocket.last.onmessage?.({ data: "{oops" });
  FakeSocket.last.onmessage?.({ data: '{"id":"x"}' });
  expect(events).toEqual(["message:{oops", 'message:{"id":"x"}']);
});
