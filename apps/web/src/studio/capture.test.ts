import { type CaptureDeps, captureSocketUrl, startCapture } from "./capture";

class FakeTrack {
  stopped = false;
  constructor(public kind: string, private surface = "browser") {}
  getSettings() {
    return { displaySurface: this.surface };
  }
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  constructor(public tracks: FakeTrack[]) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}

class FakeRecorder {
  static supported = ["video/webm;codecs=h264,opus"];
  static last: FakeRecorder;
  static isTypeSupported = (type: string) => FakeRecorder.supported.includes(type);
  state = "inactive";
  every = 0;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  constructor(public stream: FakeStream, public options: { mimeType: string }) {
    FakeRecorder.last = this;
  }
  start(every: number) {
    this.state = "recording";
    this.every = every;
  }
  stop() {
    this.state = "inactive";
  }
}

class FakeSocket {
  static last: FakeSocket;
  static opens = true;
  readyState = 0;
  binaryType = "";
  sent: Blob[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => {
      if (FakeSocket.opens) {
        this.readyState = 1;
        this.onopen?.();
      } else {
        this.readyState = 3;
        this.onclose?.();
      }
    });
  }
  send(data: Blob) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

function deps(surface = "browser") {
  const video = new FakeTrack("video", surface);
  const sound = new FakeTrack("audio");
  const asked: unknown[] = [];
  const made: CaptureDeps = {
    display: async (constraints) => {
      asked.push(constraints);
      return new FakeStream([video]) as unknown as MediaStream;
    },
    audio: () => new FakeStream([sound]) as unknown as MediaStream,
    Stream: FakeStream as unknown as typeof MediaStream,
    Recorder: FakeRecorder as unknown as typeof MediaRecorder,
    Socket: FakeSocket as unknown as typeof WebSocket,
  };
  return { made, video, sound, asked };
}

const SIZE = { width: 1280, height: 720 };

beforeEach(() => {
  FakeSocket.opens = true;
  FakeRecorder.supported = ["video/webm;codecs=h264,opus"];
});

test("the capture socket is on this page's host and carries the token", () => {
  expect(captureSocketUrl("a b", { protocol: "http:", host: "127.0.0.1:5173" })).toBe("ws://127.0.0.1:5173/api/output/capture/socket?token=a%20b");
  expect(captureSocketUrl("t", { protocol: "https:", host: "kick.example" })).toBe("wss://kick.example/api/output/capture/socket?token=t");
});

test("the page records its own tab with the program's sound and sends it in quarter-second pieces", async () => {
  const { made, video, sound, asked } = deps();
  await startCapture("tok", SIZE, made);
  expect(asked[0]).toMatchObject({ audio: false, preferCurrentTab: true, selfBrowserSurface: "include", video: { width: 1280, height: 720, frameRate: 30 } });
  expect(FakeSocket.last.url).toMatch(/\/api\/output\/capture\/socket\?token=tok$/);
  expect(FakeRecorder.last.stream.tracks).toEqual([video, sound]);
  expect(FakeRecorder.last.options.mimeType).toBe("video/webm;codecs=h264,opus");
  expect([FakeRecorder.last.state, FakeRecorder.last.every]).toEqual(["recording", 250]);
  const piece = new Blob(["abc"]);
  FakeRecorder.last.ondataavailable?.({ data: piece });
  FakeRecorder.last.ondataavailable?.({ data: new Blob([]) });
  expect(FakeSocket.last.sent).toEqual([piece]);
});

test.each(["monitor", "window", ""])("anything but this tab (%s) is refused, so the desktop cannot go on air", async (surface) => {
  const { made, video } = deps(surface);
  await expect(startCapture("tok", SIZE, made)).rejects.toThrow("Only the program tab may be recorded.");
  expect(video.stopped).toBe(true);
});

test("a browser that cannot record the program says so", async () => {
  FakeRecorder.supported = [];
  const { made, video } = deps();
  await expect(startCapture("tok", SIZE, made)).rejects.toThrow("This browser cannot record the program.");
  expect(video.stopped).toBe(true);
});

test("a socket the pipeline refuses fails the capture and releases the tab", async () => {
  FakeSocket.opens = false;
  const { made, video } = deps();
  await expect(startCapture("tok", SIZE, made)).rejects.toThrow("The pipeline did not accept the recording.");
  expect(video.stopped).toBe(true);
});

test("the socket closing later stops the recording, and so does the returned stop", async () => {
  const first = deps();
  await startCapture("tok", SIZE, first.made);
  FakeSocket.last.onclose?.();
  expect(FakeRecorder.last.state).toBe("inactive");
  expect(first.video.stopped).toBe(true);

  const second = deps();
  const stop = await startCapture("tok", SIZE, second.made);
  stop();
  expect([FakeRecorder.last.state, second.video.stopped, FakeSocket.last.closed]).toEqual(["inactive", true, true]);
});
