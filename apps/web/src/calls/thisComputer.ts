import { useEffect, useMemo, useState } from "react";
import type { LocalCamera } from "../contracts";
import { connectRoomAudio } from "../people/roomAudio";
import type { CameraTile } from "../studio/elements";

/**
 * This computer's own camera and microphone on the program, with no call service in between.
 *
 * The studio saves the devices by name, not id: ids differ from one browser to another, and the
 * program that is streamed runs in the pipeline's hidden browser on this same computer.
 */

export const THIS_COMPUTER = "this-computer";

export interface MediaDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
}

const browserMedia = (): MediaDeps => ({
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
});

// "Default" and "Communications" stand for one of the real devices, which are listed too.
const ALIASES = new Set(["default", "communications"]);

export interface NamedDevice {
  id: string;
  name: string;
}

/** Real cameras and microphones, by name. Names are empty until the page may use the devices. */
export function namedDevices(devices: readonly MediaDeviceInfo[], kind: "videoinput" | "audioinput"): NamedDevice[] {
  return devices
    .filter((device) => device.kind === kind && device.label && !ALIASES.has(device.deviceId))
    .map((device) => ({ id: device.deviceId, name: device.label }));
}

/** The id of the device with this name here, if there is one. */
export function deviceIdFor(devices: readonly MediaDeviceInfo[], kind: "videoinput" | "audioinput", name: string | null | undefined) {
  if (!name) return undefined;
  return namedDevices(devices, kind).find((device) => device.name === name)?.id;
}

/** The cameras and microphones, asking once to use them so that their names can be read. */
export async function listDevices(deps: MediaDeps = browserMedia()) {
  let devices = await deps.enumerateDevices();
  if (!devices.some((device) => device.label)) {
    const asked = await deps.getUserMedia({ video: true, audio: true });
    asked.getTracks().forEach((track) => track.stop());
    devices = await deps.enumerateDevices();
  }
  return { cameras: namedDevices(devices, "videoinput"), microphones: namedDevices(devices, "audioinput") };
}

/** Opens the chosen camera, and the chosen microphone when `sound`; a device not found here falls back to the default. */
export async function openThisComputer(setting: LocalCamera, sound: boolean, deps: MediaDeps = browserMedia()): Promise<MediaStream> {
  const devices = await deps.enumerateDevices();
  const camera = deviceIdFor(devices, "videoinput", setting.camera);
  const microphone = deviceIdFor(devices, "audioinput", setting.microphone);
  return deps.getUserMedia({
    video: { ...(camera ? { deviceId: { exact: camera } } : {}), width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: sound ? (microphone ? { deviceId: { exact: microphone } } : true) : false,
  });
}

export interface ThisComputerOptions {
  /** Put the microphone on the program's sound: only where the program is recorded, never in a preview. */
  sound: boolean;
  deps?: MediaDeps;
  connectAudio?: (stream: MediaStream) => () => void;
}

/** This computer's camera as one of the people on the program, while the studio has it on. */
export function useThisComputer(setting: LocalCamera | null | undefined, { sound, deps, connectAudio = connectRoomAudio }: ThisComputerOptions) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const on = Boolean(setting?.enabled);
  const camera = setting?.camera ?? null;
  const microphone = setting?.microphone ?? null;

  useEffect(() => {
    if (!on) {
      setStream(null);
      setProblem(null);
      return;
    }
    let current = true;
    let opened: MediaStream | null = null;
    let disconnect = () => {};
    openThisComputer({ enabled: true, camera, microphone, name: "" }, sound, deps)
      .then((made) => {
        if (!current) {
          made.getTracks().forEach((track) => track.stop());
          return;
        }
        opened = made;
        if (sound && made.getAudioTracks().length > 0) disconnect = connectAudio(made);
        setStream(made);
        setProblem(null);
      })
      .catch((caught: unknown) => {
        if (!current) return;
        setStream(null);
        setProblem(`This computer's camera could not be opened (${caught instanceof Error ? caught.message : "unknown reason"}).`);
      });
    return () => {
      current = false;
      disconnect();
      opened?.getTracks().forEach((track) => track.stop());
    };
  }, [on, camera, microphone, sound, deps, connectAudio]);

  const name = setting?.name.trim() || "Me";
  const tile = useMemo<CameraTile | null>(
    () => (on ? { id: THIS_COMPUTER, name, acsId: null, present: true, stream } : null),
    [on, name, stream],
  );
  return { tile, problem };
}
