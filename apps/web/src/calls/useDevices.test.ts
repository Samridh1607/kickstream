import { renderHook, waitFor } from "@testing-library/react";
import { FakeRoomCall } from "../test/FakeRoomCall";
import { useDevices } from "./useDevices";

test("a call given up while its microphone is being chosen is not given a camera", async () => {
  const call = new FakeRoomCall();
  let chosen: (() => void) | undefined;
  call.setMicrophone = () => new Promise<void>((resolve) => {
    chosen = resolve;
  });
  const setCamera = vi.spyOn(call, "setCamera");
  const { unmount } = renderHook(() => useDevices(call));
  await waitFor(() => expect(chosen).toBeDefined());
  unmount();
  chosen!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(setCamera).not.toHaveBeenCalled();
});
