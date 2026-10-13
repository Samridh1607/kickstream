/** A seat in a broadcast's call room. The pages never see which calling service carries it. */

export interface Device {
  id: string;
  name: string;
}

export interface Participant {
  acsId: string;
  name: string;
  video: boolean;
  speaking: boolean;
  muted: boolean;
}

export type CallState = "idle" | "joining" | "joined" | "dropped";

export interface JoinOptions {
  roomId: string;
  token: string;
  /** The name the others see. */
  name: string;
  /** A fresh token, asked for before the current one expires. */
  refresh(): Promise<string>;
  /** The program page: it only receives, and needs no devices. */
  receiveOnly?: boolean;
}

export interface RoomCall {
  readonly state: CallState;
  readonly participants: readonly Participant[];
  readonly muted: boolean;
  readonly cameraOn: boolean;
  /** Why the call ended, written for people; null while it is fine. */
  readonly problem: string | null;
  /** Called after any of the above changes. Returns what stops it. */
  onChange(listener: () => void): () => void;
  cameras(): Promise<Device[]>;
  microphones(): Promise<Device[]>;
  /** Null turns the camera off. Before joining it drives the preview. */
  setCamera(deviceId: string | null): Promise<void>;
  setMicrophone(deviceId: string): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  join(options: JoinOptions): Promise<void>;
  leave(): Promise<void>;
  /** The host and co-hosts may mute anyone. */
  muteParticipant(acsId: string): Promise<void>;
  renderVideo(acsId: string, element: HTMLElement): () => void;
  renderLocal(element: HTMLElement): () => void;
  /** Everyone else in the room, mixed into one stream. */
  roomAudio(): Promise<MediaStream | null>;
}
