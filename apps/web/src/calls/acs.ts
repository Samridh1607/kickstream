import type {
  AudioDeviceInfo, Call, CallAgent, CallClient, DeviceManager, LocalVideoStream, RemoteParticipant, RemoteVideoStream,
  VideoDeviceInfo, VideoStreamRenderer,
} from "@azure/communication-calling";
import type { CallState, Device, JoinOptions, Participant, RoomCall } from "./RoomCall";

type Calling = typeof import("@azure/communication-calling");
type Common = typeof import("@azure/communication-common");

let sdk: Promise<[Calling, Common]> | null = null;
/** The calling SDK is large; only pages that use a call load it. */
const load = () => (sdk ??= Promise.all([import("@azure/communication-calling"), import("@azure/communication-common")]));

const idOf = (participant: RemoteParticipant) =>
  participant.identifier.kind === "communicationUser" ? participant.identifier.communicationUserId : "";
const cameraOf = (participant: RemoteParticipant | undefined) =>
  participant?.videoStreams.find((stream) => stream.mediaStreamType === "Video");
const toDevice = (device: VideoDeviceInfo | AudioDeviceInfo): Device => ({ id: device.id, name: device.name });

/** A seat in an Azure Communication Services room. */
export class AcsRoomCall implements RoomCall {
  state: CallState = "idle";
  participants: Participant[] = [];
  muted = true;
  cameraOn = false;
  problem: string | null = null;
  private readonly listeners = new Set<() => void>();
  private calling: Calling | null = null;
  private client: CallClient | null = null;
  private manager: Promise<DeviceManager> | null = null;
  private agent: CallAgent | null = null;
  private call: Call | null = null;
  private local: LocalVideoStream | null = null;

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    for (const listener of [...this.listeners]) listener();
  }

  private async start(): Promise<CallClient> {
    const [calling] = await load();
    this.calling = calling;
    this.client ??= new calling.CallClient();
    return this.client;
  }

  private devices(): Promise<DeviceManager> {
    this.manager ??= (async () => {
      const manager = await (await this.start()).getDeviceManager();
      const access = await manager.askDevicePermission({ audio: true, video: true });
      if (!access.audio && !access.video) throw new Error("The browser was not allowed to use the camera or microphone.");
      return manager;
    })();
    return this.manager;
  }

  async cameras() {
    return (await (await this.devices()).getCameras()).map(toDevice);
  }

  async microphones() {
    return (await (await this.devices()).getMicrophones()).map(toDevice);
  }

  async setCamera(deviceId: string | null) {
    if (deviceId === null) {
      if (this.local && this.call?.isLocalVideoStarted) await this.call.stopVideo(this.local);
      this.local = null;
      this.cameraOn = false;
      this.emit();
      return;
    }
    const camera = (await (await this.devices()).getCameras()).find((device) => device.id === deviceId);
    if (!camera) throw new Error("That camera is no longer connected.");
    if (this.local) {
      await this.local.switchSource(camera);
    } else {
      this.local = new this.calling!.LocalVideoStream(camera);
      if (this.call) await this.call.startVideo(this.local);
    }
    this.cameraOn = true;
    this.emit();
  }

  async setMicrophone(deviceId: string) {
    const manager = await this.devices();
    const microphone = (await manager.getMicrophones()).find((device) => device.id === deviceId);
    if (!microphone) throw new Error("That microphone is no longer connected.");
    await manager.selectMicrophone(microphone);
  }

  async setMuted(muted: boolean) {
    this.muted = muted;
    if (this.call && this.call.isMuted !== muted) await (muted ? this.call.mute() : this.call.unmute());
    this.emit();
  }

  async join({ roomId, token, name, refresh, receiveOnly = false }: JoinOptions) {
    const client = await this.start();
    const [, common] = await load();
    const credential = new common.AzureCommunicationTokenCredential({ token, tokenRefresher: () => refresh(), refreshProactively: true });
    this.agent = await client.createCallAgent(credential, { displayName: name });
    this.problem = null;
    this.state = "joining";
    this.emit();
    const sending = !receiveOnly && this.local ? { localVideoStreams: [this.local] } : undefined;
    const call = this.agent.join({ roomId }, { videoOptions: sending, audioOptions: { muted: receiveOnly || this.muted } });
    this.call = call;
    call.on("stateChanged", () => this.followState(call));
    call.on("remoteParticipantsUpdated", ({ added }) => {
      added.forEach((participant) => this.follow(participant));
      this.collect();
    });
    call.on("remoteAudioStreamsUpdated", () => this.emit());
    call.remoteParticipants.forEach((participant) => this.follow(participant));
    this.collect();
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (call.state === "Connected") resolve();
        else if (call.state === "Disconnected") reject(new Error(this.problem ?? "The call could not be joined."));
      };
      call.on("stateChanged", check);
      check();
    });
  }

  private followState(call: Call) {
    if (call !== this.call) return;
    if (call.state === "Connected") {
      this.state = "joined";
    } else if (call.state === "Disconnected") {
      this.state = "dropped";
      const reason = call.callEndReason;
      this.problem = reason && reason.code !== 0 ? `The call ended (code ${reason.code}${reason.subCode ? `/${reason.subCode}` : ""}).` : null;
    }
    this.emit();
  }

  private follow(participant: RemoteParticipant) {
    const changed = () => this.collect();
    participant.on("displayNameChanged", changed);
    participant.on("isMutedChanged", changed);
    participant.on("isSpeakingChanged", changed);
    participant.on("videoStreamsUpdated", ({ added }) => {
      added.forEach((stream) => stream.on("isAvailableChanged", changed));
      changed();
    });
    participant.videoStreams.forEach((stream) => stream.on("isAvailableChanged", changed));
  }

  private collect() {
    this.participants = (this.call?.remoteParticipants ?? []).map((participant) => ({
      acsId: idOf(participant),
      name: participant.displayName ?? "",
      video: Boolean(cameraOf(participant)?.isAvailable),
      speaking: participant.isSpeaking,
      muted: participant.isMuted,
    }));
    this.emit();
  }

  async leave() {
    const call = this.call;
    const agent = this.agent;
    this.call = null;
    this.agent = null;
    this.participants = [];
    this.state = "idle";
    try {
      if (call && call.state !== "Disconnected") await call.hangUp();
    } finally {
      await agent?.dispose();
      this.emit();
    }
  }

  async muteParticipant(acsId: string) {
    await this.call?.remoteParticipants.find((participant) => idOf(participant) === acsId)?.mute();
  }

  private draw(element: HTMLElement, pick: () => LocalVideoStream | RemoteVideoStream | null): () => void {
    let shown: LocalVideoStream | RemoteVideoStream | null = null;
    let renderer: VideoStreamRenderer | null = null;
    const update = () => {
      const next = pick();
      if (next === shown) return;
      shown = next;
      renderer?.dispose();
      renderer = null;
      element.replaceChildren();
      if (!next || !this.calling) return;
      const made = new this.calling.VideoStreamRenderer(next);
      renderer = made;
      made.createView({ scalingMode: "Crop" }).then(
        (view) => {
          if (renderer === made) element.replaceChildren(view.target);
        },
        () => {
          if (renderer === made) shown = null;
        },
      );
    };
    update();
    const off = this.onChange(update);
    return () => {
      off();
      renderer?.dispose();
      renderer = null;
      element.replaceChildren();
    };
  }

  renderVideo(acsId: string, element: HTMLElement) {
    return this.draw(element, () => {
      const stream = cameraOf(this.call?.remoteParticipants.find((participant) => idOf(participant) === acsId));
      return stream?.isAvailable ? stream : null;
    });
  }

  renderLocal(element: HTMLElement) {
    return this.draw(element, () => this.local);
  }

  async roomAudio() {
    const stream = this.call?.remoteAudioStreams[0];
    return stream ? await stream.getMediaStream() : null;
  }
}
