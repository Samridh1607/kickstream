import { useCallback, useEffect, useState } from "react";
import { BROADCASTS_STREAM } from "../broadcasts/api";
import { openRoomCall } from "../calls/open";
import type { RoomCall } from "../calls/RoomCall";
import { useCallUpdates } from "../calls/useCallUpdates";
import type { Broadcasts, CallSeat, People } from "../contracts";
import { useLiveDocument } from "../stream/useLiveDocument";
import type { CameraTile } from "../studio/elements";
import { peopleStream, programSeat } from "./api";
import { connectRoomAudio } from "./roomAudio";
import { stageTiles } from "./stage";

export interface ProgramCallOptions {
  eventSource?: new (url: string) => EventSource;
  retryMs?: number;
  newCall?: (service: CallSeat["service"]) => RoomCall;
  seat?: (broadcastId: string) => Promise<CallSeat>;
  connectAudio?: (stream: MediaStream) => () => void;
  rejoinMs?: number;
}

/**
 * The program's receive-only seat in the room of the broadcast on air, else of the current one: who
 * is on stage, their video, and their voices on the stream.
 */
export function useProgramCall({
  eventSource, retryMs, newCall = openRoomCall, seat = programSeat, connectAudio = connectRoomAudio, rejoinMs = 3000,
}: ProgramCallOptions = {}): { cameras: CameraTile[]; renderVideo?: (acsId: string, element: HTMLElement) => () => void } {
  const { doc: broadcasts } = useLiveDocument<Broadcasts>(BROADCASTS_STREAM, eventSource, retryMs);
  const target = broadcasts?.broadcasts.find((item) => item.state === "live")?.id ?? broadcasts?.current_id ?? null;
  const { doc } = useLiveDocument<People>(target ? peopleStream(target) : null, eventSource, retryMs);
  const people = doc?.broadcast_id === target ? doc : null;
  const roomId = people?.room_id ?? null;
  const service = people?.service ?? null;

  const [call, setCall] = useState<RoomCall | null>(null);
  const [attempt, setAttempt] = useState(0);
  useCallUpdates(call);

  useEffect(() => {
    if (!target || !roomId || !service) return;
    const made = newCall(service);
    // Leaving below may make the join still in flight reject; that is no reason to join again.
    let gone = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const again = () => {
      if (gone || retry !== undefined) return;
      retry = setTimeout(() => setAttempt((count) => count + 1), rejoinMs);
    };
    const off = made.onChange(() => {
      if (made.state === "dropped") again();
    });
    setCall(made);
    seat(target)
      .then((given) => (gone ? undefined : made.join({
        roomId: given.room_id, token: given.token, name: "Program", receiveOnly: true, refresh: async () => (await seat(target)).token,
      })))
      .catch(again);
    return () => {
      gone = true;
      clearTimeout(retry);
      off();
      setCall(null);
      made.leave().catch(() => {});
    };
  }, [target, roomId, service, attempt, newCall, seat, rejoinMs]);

  const joined = call?.state === "joined";
  useEffect(() => {
    if (!call || !joined) return;
    let gone = false;
    let undo: (() => void) | null = null;
    const attach = () => {
      if (undo || gone) return;
      call.roomAudio().then((stream) => {
        if (!gone && stream && !undo) undo = connectAudio(stream);
      }).catch(() => {});
    };
    attach();
    const off = call.onChange(attach);
    return () => {
      gone = true;
      off();
      undo?.();
    };
  }, [call, joined, connectAudio]);

  const renderVideo = useCallback((acsId: string, element: HTMLElement) => call?.renderVideo(acsId, element) ?? (() => {}), [call]);
  return { cameras: stageTiles(people), renderVideo: call ? renderVideo : undefined };
}
