/**
 * The program page recording itself for the pipeline's hidden browser.
 *
 * Sound captured from a tab arrives silent in a hidden browser, so the page owns one audio mix
 * and records that beside the picture. Anything that should be heard on the stream connects to
 * `programAudio().input`.
 */

export interface ProgramAudio {
  context: AudioContext;
  /** Connect a source here to put it on the stream. */
  input: AudioNode;
  stream: MediaStream;
}

let shared: ProgramAudio | null = null;

export function programAudio(): ProgramAudio {
  if (shared) return shared;
  const context = new AudioContext();
  const output = context.createMediaStreamDestination();
  const input = context.createGain();
  input.connect(output);
  // An inaudible source keeps the track producing sound, so the recording always has audio to carry.
  const quiet = context.createConstantSource();
  const off = context.createGain();
  off.gain.value = 0;
  quiet.connect(off).connect(output);
  quiet.start();
  shared = { context, input, stream: output.stream };
  return shared;
}

interface Place {
  protocol: string;
  host: string;
}

export function captureSocketUrl(token: string, place: Place): string {
  const scheme = place.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${place.host}/api/output/capture/socket?token=${encodeURIComponent(token)}`;
}

/** What capture needs from the browser. Tests pass stand-ins. */
export interface CaptureDeps {
  display(constraints: object): Promise<MediaStream>;
  /** The program's sound, once it is running. Rejects if it cannot be started. */
  audio(): Promise<MediaStream>;
  Stream: typeof MediaStream;
  Recorder: typeof MediaRecorder;
  Socket: typeof WebSocket;
}

/** Stops a capture. Safe to call more than once; `ended` settles once it has stopped, however that came about. */
export type StopCapture = (() => void) & { ended?: Promise<void> };

const browser = (): CaptureDeps => ({
  display: (constraints) => navigator.mediaDevices.getDisplayMedia(constraints as DisplayMediaStreamOptions),
  audio: async () => {
    const program = programAudio();
    // Without a user gesture the context can stay suspended and the track would carry nothing.
    if (program.context.state === "suspended") await program.context.resume();
    return program.stream;
  },
  Stream: MediaStream,
  Recorder: MediaRecorder,
  Socket: WebSocket,
});

const FORMATS = ["video/webm;codecs=h264,opus", "video/webm;codecs=vp8,opus"];
const PIECE_MS = 250;
const OPEN = 1;

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onclose = () => reject(new Error("The pipeline did not accept the recording."));
  });
}

/**
 * Record this tab with the program's sound and send it to the pipeline. Resolves to a function that stops it.
 * The pipeline reads the socket closing as "the page stopped sending", so any way this ends closes the socket.
 */
export async function startCapture(token: string, size: { width: number; height: number }, deps: CaptureDeps = browser()): Promise<StopCapture> {
  const shown = await deps.display({
    video: { width: size.width, height: size.height, frameRate: 30 },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
  });
  let socket: WebSocket | undefined;
  let recorder: MediaRecorder | undefined;
  let done = false;
  let finish!: () => void;
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop: StopCapture = () => {
    if (done) return;
    done = true;
    try {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    } finally {
      shown.getTracks().forEach((track) => track.stop());
      socket?.close();
      finish();
    }
  };
  stop.ended = ended;
  try {
    const [picture] = shown.getVideoTracks();
    // Anything but this tab would put the streamer's screen on air.
    if (picture?.getSettings().displaySurface !== "browser") throw new Error("Only the program tab may be recorded.");
    const mimeType = FORMATS.find((format) => deps.Recorder.isTypeSupported(format));
    if (!mimeType) throw new Error("This browser cannot record the program.");

    const opening = new deps.Socket(captureSocketUrl(token, window.location));
    socket = opening;
    opening.binaryType = "arraybuffer";
    await opened(opening);
    // From here the pipeline closing the socket means the run is over; there is no gap before this.
    opening.onclose = stop;
    picture.onended = stop;

    const sound = await deps.audio();
    if (done || opening.readyState !== OPEN) throw new Error("The pipeline closed the recording.");

    const made = new deps.Recorder(new deps.Stream([picture, ...sound.getAudioTracks()]), { mimeType, videoBitsPerSecond: 8_000_000 });
    recorder = made;
    made.ondataavailable = (event) => {
      if (event.data.size > 0 && opening.readyState === OPEN) opening.send(event.data);
    };
    made.onerror = stop;
    made.onstop = stop;
    made.start(PIECE_MS);
    return stop;
  } catch (problem) {
    stop();
    throw problem;
  }
}
