import { useEffect, useState } from "react";
import type { RoomCall } from "./RoomCall";

/** Re-renders whenever the call changes: who is there, and whether it is joined, muted or showing a camera. */
export function useCallUpdates(call: RoomCall | null): void {
  const [, setTick] = useState(0);
  useEffect(() => call?.onChange(() => setTick((tick) => tick + 1)), [call]);
}
