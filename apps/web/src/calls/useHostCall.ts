import { useEffect, useRef, useState } from "react";
import type { CallSeat, People } from "../contracts";
import { hostSeat } from "../people/api";
import { openRoomCall } from "./open";
import type { RoomCall } from "./RoomCall";
import { useCallUpdates } from "./useCallUpdates";
import { useDevices } from "./useDevices";

export const muteProblem = (caught: unknown) => (caught instanceof Error ? caught.message : "The microphone could not be changed.");

/** Re-renders with the call, leaves it once it is replaced or the page goes, and keeps it muted while `mutedLive`. */
export function useCallLifecycle(call: RoomCall | null, mutedLive: boolean, onMuteFailed: (caught: unknown) => void) {
  useCallUpdates(call);
  const currentCall = useRef(call);
  useEffect(() => {
    currentCall.current = call;
    return () => {
      currentCall.current = null;
      // The call is being given up; there is nowhere to show a failed leave.
      call?.leave().catch(() => undefined);
    };
  }, [call]);
  const muteFailed = useRef(onMuteFailed);
  muteFailed.current = onMuteFailed;
  const mutedLiveNow = useRef(mutedLive);
  const joined = call?.state === "joined";
  useEffect(() => {
    mutedLiveNow.current = mutedLive;
    if (!call || !mutedLive) return;
    call.setMuted(true).catch((caught: unknown) => {
      if (currentCall.current === call) muteFailed.current(caught);
    });
  }, [call, mutedLive, joined]);
  return { currentCall, mutedLiveNow };
}

interface HostCallOptions {
  broadcastId: string;
  people: People | null;
  mutedLive: boolean;
  newCall?: (service: CallSeat["service"]) => RoomCall;
}

/** The studio host's own camera in the broadcast's room. */
export function useHostCall({ broadcastId, people, mutedLive, newCall = openRoomCall }: HostCallOptions) {
  const [call, setCall] = useState<RoomCall | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { currentCall, mutedLiveNow } = useCallLifecycle(call, mutedLive, (caught) => setProblem(muteProblem(caught)));
  const devices = useDevices(call);

  const join = async () => {
    if (!people?.service) return;
    const made = newCall(people.service);
    setCall(made);
    try {
      const seat = await hostSeat(broadcastId, people.host_name);
      await made.setMuted(mutedLiveNow.current);
      await made.join({ roomId: seat.room_id, token: seat.token, name: people.host_name, refresh: async () => (await hostSeat(broadcastId, people.host_name)).token });
      setProblem(null);
    } catch (caught) {
      // Leaving a call rejects its join that is still starting; that is not the host's problem.
      if (currentCall.current !== made) return;
      setCall(null);
      setProblem(caught instanceof Error ? caught.message : "Your camera could not join.");
    }
  };
  const toggleMute = async () => {
    if (!call) return;
    await call.setMuted(!call.muted).catch((caught: unknown) => setProblem(muteProblem(caught)));
  };
  return { call, devices, problem, setProblem, join, toggleMute };
}
