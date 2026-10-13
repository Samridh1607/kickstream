import type { Broadcasts } from "../contracts";
import { send } from "../studio/api";

export const BROADCASTS_STREAM = "/api/broadcasts/stream";

const id = encodeURIComponent;
const call = (method: string, path: string, body?: unknown) => send<Broadcasts>(method, `/api/broadcasts${path}`, body);

export interface BroadcastDraft {
  title: string;
  description: string;
  record: boolean;
}

export const createBroadcast = (draft: BroadcastDraft) => call("POST", "", draft);
export const editBroadcast = (broadcastId: string, changed: { title: string; description: string }) =>
  call("PUT", `/${id(broadcastId)}`, changed);
export const deleteBroadcast = (broadcastId: string) => call("DELETE", `/${id(broadcastId)}`);
/** Makes it the current broadcast: the one the studio works on and the next stream belongs to. */
export const selectBroadcast = (broadcastId: string) => call("POST", `/${id(broadcastId)}/select`);
/** Makes it the current broadcast and starts the stream. */
export const goLiveWith = (broadcastId: string) => call("POST", `/${id(broadcastId)}/live`);
export const endBroadcast = (broadcastId: string) => call("POST", `/${id(broadcastId)}/end`);
export const generateReels = (broadcastId: string) => call("POST", `/${id(broadcastId)}/reels`);
export const deleteReel = (broadcastId: string, reelId: string) => call("DELETE", `/${id(broadcastId)}/reels/${id(reelId)}`);

export const broadcastPath = (broadcastId: string) => `/broadcasts/${id(broadcastId)}`;
/** The studio, working on this broadcast. */
export const studioPath = (broadcastId: string) => `/broadcasts/${id(broadcastId)}/studio`;
export const recordingUrl = (broadcastId: string, file: string) => `/api/broadcasts/${id(broadcastId)}/recordings/${id(file)}`;
export const reelUrl = (broadcastId: string, reelId: string) => `/api/broadcasts/${id(broadcastId)}/reels/${id(reelId)}.mp4`;
