import type { AutoLive, AutoLiveSettings } from "../contracts";
import { send, StudioRequestError } from "../studio/api";

export const AUTOLIVE_STREAM = "/api/autolive/stream";

const id = encodeURIComponent;
const call = (method: string, path = "", body?: unknown) => send<AutoLive>(method, `/api/autolive${path}`, body);

export const saveAutoLiveSettings = (settings: AutoLiveSettings) => call("PUT", "/settings", settings);
export const nextScene = () => call("POST", "/next");
export const showScene = (sceneId: string) => call("POST", `/scenes/${id(sceneId)}/show`);
export const sayNow = () => call("POST", "/say");

/** The text in the auto live voice, as MP3 from Azure Speech. Rejects with the reason when Azure cannot say it. */
export async function fetchSpeech(text: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch("/api/autolive/speech", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!response.ok) {
    let message = `Azure Speech failed (${response.status}).`;
    try {
      const body = (await response.json()) as { detail?: { msg?: unknown }[] };
      const first = Array.isArray(body.detail) ? body.detail[0] : undefined;
      if (typeof first?.msg === "string") message = first.msg;
    } catch {
      // Not JSON: keep the generic message.
    }
    throw new StudioRequestError(response.status, "speech", message);
  }
  return response.arrayBuffer();
}
