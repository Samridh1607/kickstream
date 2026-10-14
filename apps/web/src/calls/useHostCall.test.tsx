import { renderHook, waitFor } from "@testing-library/react";
import { FakeRoomCall } from "../test/FakeRoomCall";
import { useCallLifecycle } from "./useHostCall";

test("a replaced call is left, and the last one is left on unmount", () => {
  const first = new FakeRoomCall();
  const second = new FakeRoomCall();
  const { rerender, unmount } = renderHook(({ call }) => useCallLifecycle(call, false, () => undefined), { initialProps: { call: first } });
  rerender({ call: second });
  expect(first.left).toBe(1);
  expect(second.left).toBe(0);
  unmount();
  expect(second.left).toBe(1);
});

test("a call is muted once the broadcast mutes it, and a failed mute is reported", async () => {
  const call = new FakeRoomCall();
  call.muted = false;
  const failed = vi.fn();
  const { rerender } = renderHook(({ mutedLive }) => useCallLifecycle(call, mutedLive, failed), { initialProps: { mutedLive: false } });
  expect(call.muted).toBe(false);
  rerender({ mutedLive: true });
  await waitFor(() => expect(call.muted).toBe(true));
  expect(failed).not.toHaveBeenCalled();

  call.setMuted = () => Promise.reject(new Error("Microphone is busy"));
  rerender({ mutedLive: false });
  rerender({ mutedLive: true });
  await waitFor(() => expect(failed).toHaveBeenCalledWith(new Error("Microphone is busy")));
});
