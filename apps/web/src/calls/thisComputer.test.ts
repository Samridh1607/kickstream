import { act, renderHook, waitFor } from "@testing-library/react";
import type { LocalCamera } from "../contracts";
import { deviceIdFor, listDevices, type MediaDeps, namedDevices, openThisComputer, THIS_COMPUTER, useThisComputer } from "./thisComputer";

const device = (kind: MediaDeviceKind, deviceId: string, label: string) => ({ kind, deviceId, label, groupId: "g" }) as MediaDeviceInfo;

const DEVICES = [
  device("audioinput", "default", "Default - Microphone (Jabra EVOLVE 20)"),
  device("audioinput", "communications", "Communications - Microphone (Jabra EVOLVE 20)"),
  device("audioinput", "mic-jabra", "Microphone (Jabra EVOLVE 20)"),
  device("audioinput", "mic-array", "Microphone Array (Intel)"),
  device("videoinput", "cam-smart", "Smart Connect Camera"),
  device("videoinput", "cam-built-in", "Integrated Camera"),
  device("audiooutput", "speakers", "Speakers"),
];

function fakeStream(kinds: ("audio" | "video")[] = ["video", "audio"]) {
  const tracks = kinds.map((kind) => ({ kind, stop: vi.fn() }));
  return {
    tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
    getVideoTracks: () => tracks.filter((track) => track.kind === "video"),
  } as unknown as MediaStream & { tracks: { kind: string; stop: ReturnType<typeof vi.fn> }[] };
}

function media(devices: MediaDeviceInfo[] = DEVICES, stream = fakeStream()) {
  const deps = {
    getUserMedia: vi.fn(async () => stream),
    enumerateDevices: vi.fn(async () => devices),
  } satisfies MediaDeps;
  return deps;
}

const MINE: LocalCamera = { enabled: true, camera: "Smart Connect Camera", microphone: "Microphone (Jabra EVOLVE 20)", name: "Yash" };

test("only real cameras and microphones are offered, by name", () => {
  expect(namedDevices(DEVICES, "videoinput").map((found) => found.name)).toEqual(["Smart Connect Camera", "Integrated Camera"]);
  expect(namedDevices(DEVICES, "audioinput").map((found) => found.name)).toEqual(["Microphone (Jabra EVOLVE 20)", "Microphone Array (Intel)"]);
  expect(deviceIdFor(DEVICES, "videoinput", "Integrated Camera")).toBe("cam-built-in");
  expect(deviceIdFor(DEVICES, "videoinput", "A camera unplugged")).toBeUndefined();
  expect(deviceIdFor(DEVICES, "videoinput", null)).toBeUndefined();
});

test("listing asks once to use the devices when their names cannot be read yet, and lets them go", async () => {
  const unnamed = DEVICES.map((found) => ({ ...found, label: "" }) as MediaDeviceInfo);
  const asked = fakeStream();
  const deps = media();
  deps.enumerateDevices.mockResolvedValueOnce(unnamed);
  deps.getUserMedia.mockResolvedValueOnce(asked);
  const found = await listDevices(deps);
  expect(deps.getUserMedia).toHaveBeenCalledTimes(1);
  expect(asked.tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
  expect(found.cameras).toHaveLength(2);

  const named = media();
  await listDevices(named);
  expect(named.getUserMedia).not.toHaveBeenCalled();
});

test("the chosen devices are opened by their id in this browser, and the default when one is not here", async () => {
  const deps = media();
  await openThisComputer(MINE, true, deps);
  expect(deps.getUserMedia).toHaveBeenLastCalledWith({
    video: { deviceId: { exact: "cam-smart" }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: { deviceId: { exact: "mic-jabra" } },
  });
  await openThisComputer({ ...MINE, camera: "Unplugged camera", microphone: null }, true, deps);
  expect(deps.getUserMedia).toHaveBeenLastCalledWith({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true });
  await openThisComputer(MINE, false, deps);
  expect(deps.getUserMedia).toHaveBeenLastCalledWith(expect.objectContaining({ audio: false }));
});

test("on the program the camera becomes a person on stage and the microphone goes on the stream", async () => {
  const stream = fakeStream();
  const deps = media(DEVICES, stream);
  const connectAudio = vi.fn(() => () => {});
  const { result, rerender } = renderHook(({ setting }) => useThisComputer(setting, { sound: true, deps, connectAudio }), {
    initialProps: { setting: MINE as LocalCamera | null },
  });
  await waitFor(() => expect(result.current.tile?.stream).toBe(stream));
  expect(result.current.tile).toMatchObject({ id: THIS_COMPUTER, name: "Yash", acsId: null, present: true });
  expect(connectAudio).toHaveBeenCalledWith(stream);

  act(() => rerender({ setting: { ...MINE, enabled: false } }));
  expect(result.current.tile).toBeNull();
  expect(stream.tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
});

test("in a preview the microphone stays off, so no one hears themselves", async () => {
  const deps = media(DEVICES, fakeStream(["video"]));
  const connectAudio = vi.fn(() => () => {});
  const { result } = renderHook(() => useThisComputer({ ...MINE, name: "  " }, { sound: false, deps, connectAudio }));
  await waitFor(() => expect(result.current.tile?.stream).toBeTruthy());
  expect(result.current.tile?.name).toBe("Me");
  expect(connectAudio).not.toHaveBeenCalled();
  expect(deps.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
});

test("a camera that cannot be opened says why, and still shows the person", async () => {
  const deps = media();
  deps.getUserMedia.mockRejectedValue(new Error("Permission denied"));
  const { result } = renderHook(() => useThisComputer(MINE, { sound: true, deps }));
  await waitFor(() => expect(result.current.problem).toContain("Permission denied"));
  expect(result.current.tile).toMatchObject({ name: "Yash", stream: null });
});
