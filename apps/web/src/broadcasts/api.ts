import type { Broadcasts } from "../contracts";
import { send, toError } from "../studio/api";

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

/** Adds the version of a reel edited in Clipchamp, replacing any before it. The file is sent as it is. */
export async function addEditedReel(broadcastId: string, reelId: string, file: Blob & { name?: string }): Promise<Broadcasts> {
  const response = await fetch(`/api/broadcasts/${id(broadcastId)}/reels/${id(reelId)}/edited`, {
    method: "PUT",
    // A header carries only ASCII, so the file's name travels percent-encoded.
    headers: { "content-type": file.type || "video/mp4", "x-file-name": encodeURIComponent(file.name ?? "") },
    body: file,
  });
  if (!response.ok) throw await toError(response);
  return (await response.json()) as Broadcasts;
}

/** Goes back to the original reel. */
export const removeEditedReel = (broadcastId: string, reelId: string) => call("DELETE", `/${id(broadcastId)}/reels/${id(reelId)}/edited`);

export const broadcastPath = (broadcastId: string) => `/broadcasts/${id(broadcastId)}`;
/** The studio, working on this broadcast. */
export const studioPath = (broadcastId: string) => `/broadcasts/${id(broadcastId)}/studio`;
export const recordingUrl = (broadcastId: string, file: string) => `/api/broadcasts/${id(broadcastId)}/recordings/${id(file)}`;
export const reelUrl = (broadcastId: string, reelId: string) => `/api/broadcasts/${id(broadcastId)}/reels/${id(reelId)}.mp4`;
/** The edited version; `version` changes when it is replaced, so a browser never shows the one before. */
export const editedReelUrl = (broadcastId: string, reelId: string, version: number) =>
  `/api/broadcasts/${id(broadcastId)}/reels/${id(reelId)}/edited.mp4?v=${version}`;
