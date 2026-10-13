import type { CallState, Device, JoinOptions, Participant, RoomCall } from "../calls/RoomCall";

/** A scriptable call: it records what the page asked for, and the test says who is in the room. */
export class FakeRoomCall implements RoomCall {
  state: CallState = "idle";
  participants: Participant[] = [];
  muted = true;
  cameraOn = false;
  problem: string | null = null;
  cameraList: Device[] = [{ id: "cam1", name: "Front camera" }];
  microphoneList: Device[] = [{ id: "mic1", name: "Headset" }];
  failDevices: string | null = null;
  failJoin: string | null = null;
  audio: MediaStream | null = null;
  joined: JoinOptions[] = [];
  mutedOthers: string[] = [];
  rendered: string[] = [];
  left = 0;
  private readonly listeners = new Set<() => void>();

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit() {
    for (const listener of [...this.listeners]) listener();
  }

  async cameras() {
    if (this.failDevices) throw new Error(this.failDevices);
    return this.cameraList;
  }

  async microphones() {
    if (this.failDevices) throw new Error(this.failDevices);
    return this.microphoneList;
  }

  async setCamera(deviceId: string | null) {
    this.cameraOn = deviceId !== null;
    this.emit();
  }

  async setMicrophone(_deviceId: string) {}

  async setMuted(muted: boolean) {
    this.muted = muted;
    this.emit();
  }

  async join(options: JoinOptions) {
    if (this.failJoin) throw new Error(this.failJoin);
    this.joined.push(options);
    this.state = "joined";
    this.emit();
  }

  async leave() {
    this.left += 1;
    this.state = "idle";
    this.emit();
  }

  async muteParticipant(acsId: string) {
    this.mutedOthers.push(acsId);
  }

  renderVideo(acsId: string, element: HTMLElement) {
    this.rendered.push(acsId);
    element.setAttribute("data-video", acsId);
    return () => element.removeAttribute("data-video");
  }

  renderLocal(element: HTMLElement) {
    element.setAttribute("data-video", "local");
    return () => element.removeAttribute("data-video");
  }

  async roomAudio() {
    return this.audio;
  }

  drop() {
    this.state = "dropped";
    this.emit();
  }
}
