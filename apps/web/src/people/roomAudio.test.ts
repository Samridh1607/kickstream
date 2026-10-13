import type { ProgramAudio } from "../studio/capture";
import { connectRoomAudio } from "./roomAudio";

test("the room's voices join the program mix through a muted media element that plays them", () => {
  const connected: unknown[] = [];
  const node = { connect: (to: unknown) => connected.push(to), disconnect: vi.fn() };
  const program = { context: { createMediaStreamSource: vi.fn(() => node) }, input: {} } as unknown as ProgramAudio;
  const element = { muted: false, srcObject: null as unknown, play: vi.fn(async () => {}), pause: vi.fn() };
  const stream = {} as MediaStream;
  const undo = connectRoomAudio(stream, program, () => element as unknown as HTMLAudioElement);
  expect([element.muted, element.srcObject]).toEqual([true, stream]);
  expect(element.play).toHaveBeenCalled();
  expect(program.context.createMediaStreamSource).toHaveBeenCalledWith(stream);
  expect(connected).toEqual([program.input]);
  undo();
  expect(node.disconnect).toHaveBeenCalled();
  expect(element.srcObject).toBeNull();
});
