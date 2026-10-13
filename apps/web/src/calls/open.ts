import type { CallSeat } from "../contracts";
import { AcsRoomCall } from "./acs";
import { LocalRoomCall } from "./local";
import type { RoomCall } from "./RoomCall";

export function openRoomCall(service: CallSeat["service"]): RoomCall {
  return service === "acs" ? new AcsRoomCall() : new LocalRoomCall();
}
