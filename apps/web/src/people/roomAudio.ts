import { type ProgramAudio, programAudio } from "../studio/capture";

/**
 * Puts the room's voices on the stream. Chrome lets remote WebRTC sound into Web Audio only while a
 * media element plays it, so a muted one does.
 */
export function connectRoomAudio(stream: MediaStream, program: ProgramAudio = programAudio(), makeAudio = () => new Audio()): () => void {
  const element = makeAudio();
  element.muted = true;
  element.srcObject = stream;
  void element.play().catch(() => {});
  const source = program.context.createMediaStreamSource(stream);
  source.connect(program.input);
  return () => {
    source.disconnect();
    element.pause();
    element.srcObject = null;
  };
}
