import { LocalRoomCall } from "./local";

function stubDevices() {
  const stopped: number[] = [];
  let made = 0;
  const getUserMedia = vi.fn(async () => {
    const id = ++made;
    return { getTracks: () => [{ stop: () => stopped.push(id) }] } as unknown as MediaStream;
  });
  const enumerateDevices = vi.fn(async () => [
    { kind: "videoinput", deviceId: "cam1", label: "Front camera" },
    { kind: "audioinput", deviceId: "mic1", label: "" },
  ] as MediaDeviceInfo[]);
  Object.defineProperty(window.navigator, "mediaDevices", { value: { getUserMedia, enumerateDevices }, configurable: true });
  return { getUserMedia, stopped };
}

test("a call with no service lists devices once allowed, previews the camera, and is always alone", async () => {
  const { getUserMedia, stopped } = stubDevices();
  const call = new LocalRoomCall();
  expect(await call.cameras()).toEqual([{ id: "cam1", name: "Front camera" }]);
  expect(await call.microphones()).toEqual([{ id: "mic1", name: "Microphone 1" }]);
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(stopped).toEqual([1]);
  await call.setCamera("cam1");
  expect(call.cameraOn).toBe(true);
  const box = document.createElement("div");
  const stop = call.renderLocal(box);
  expect(box.querySelector("video")?.muted).toBe(true);
  await call.join({ roomId: "room-1", token: "t", name: "Sam", refresh: async () => "t" });
  expect([call.state, call.participants]).toEqual(["joined", []]);
  await call.setCamera(null);
  expect([call.cameraOn, stopped]).toEqual([false, [1, 2]]);
  stop();
  expect(box.children).toHaveLength(0);
});
