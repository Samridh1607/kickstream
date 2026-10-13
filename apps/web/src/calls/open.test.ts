import { AcsRoomCall } from "./acs";
import { LocalRoomCall } from "./local";
import { openRoomCall } from "./open";

test("the room's service decides which call joins it", () => {
  expect(openRoomCall("acs")).toBeInstanceOf(AcsRoomCall);
  expect(openRoomCall("fake")).toBeInstanceOf(LocalRoomCall);
});
