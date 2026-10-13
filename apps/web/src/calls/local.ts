import type { CallState, Device, JoinOptions, Participant, RoomCall } from "./RoomCall";

/**
 * A call with no service behind it: the devices and the preview work, and no one else is ever there.
 * For trying guests without Azure, and for the end-to-end tests.
 */
export class LocalRoomCall implements RoomCall {
  state: CallState = "idle";
  participants: Participant[] = [];
  muted = true;
  cameraOn = false;
  problem: string | null = null;
  private readonly listeners = new Set<() => void>();
  private stream: MediaStream | null = null;
  private allowed: Promise<void> | null = null;

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    for (const listener of [...this.listeners]) listener();
  }

  /** Browsers name devices only once the page may use them. */
  private allow(): Promise<void> {
    this.allowed ??= navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then((probe) => {
      probe.getTracks().forEach((track) => track.stop());
    });
    return this.allowed;
  }

  private async devices(kind: MediaDeviceKind, fallback: string): Promise<Device[]> {
    await this.allow();
    const found = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === kind);
    return found.map((device, n) => ({ id: device.deviceId, name: device.label || `${fallback} ${n + 1}` }));
  }

  cameras() {
    return this.devices("videoinput", "Camera");
  }

  microphones() {
    return this.devices("audioinput", "Microphone");
  }

  async setCamera(deviceId: string | null) {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.cameraOn = false;
    if (deviceId !== null) {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
      this.cameraOn = true;
    }
    this.emit();
  }

  async setMicrophone(_deviceId: string) {}

  async setMuted(muted: boolean) {
    this.muted = muted;
    this.emit();
  }

  async join(_options: JoinOptions) {
    this.state = "joined";
    this.emit();
  }

  async leave() {
    await this.setCamera(null);
    this.state = "idle";
    this.emit();
  }

  async muteParticipant(_acsId: string) {}

  renderVideo(_acsId: string, _element: HTMLElement) {
    return () => {};
  }

  renderLocal(element: HTMLElement) {
    const video = document.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.style.cssText = "width: 100%; height: 100%; object-fit: cover";
    const show = () => {
      if (video.srcObject !== this.stream) video.srcObject = this.stream;
    };
    show();
    element.replaceChildren(video);
    const off = this.onChange(show);
    return () => {
      off();
      video.srcObject = null;
      element.replaceChildren();
    };
  }

  async roomAudio() {
    return null;
  }
}
