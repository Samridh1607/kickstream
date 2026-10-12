import type { KeyMoment, MatchEvent, Scene, Studio, StudioSettings, Ticker } from "../contracts";

export const STUDIO_STREAM = "/api/studio/stream";

/** A change the studio refused, or a request that failed. `field` names what was wrong, when known. */
export class StudioRequestError extends Error {
  readonly status: number;
  readonly field: string | null;

  constructor(status: number, field: string | null, message: string) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

async function toError(response: Response): Promise<StudioRequestError> {
  let field: string | null = null;
  let message = `The request failed (${response.status}).`;
  try {
    const body = (await response.json()) as { detail?: { loc?: unknown[]; msg?: unknown }[] };
    const first = Array.isArray(body.detail) ? body.detail[0] : undefined;
    if (first) {
      const last = first.loc?.[first.loc.length - 1];
      field = typeof last === "string" ? last : null;
      message = typeof first.msg === "string" ? first.msg : message;
    }
  } catch {
    // Not JSON: keep the generic message.
  }
  return new StudioRequestError(response.status, field, message);
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(path, init);
  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

const change = (method: string, path: string, body?: unknown) => send<Studio>(method, `/api/studio${path}`, body);
const id = encodeURIComponent;

export const getStudio = () => change("GET", "");
export const createScene = (source: "builtin" | "template" | "scene", ref: string, name?: string) =>
  change("POST", "/scenes", name ? { source, ref, name } : { source, ref });
export const saveScene = (scene: Pick<Scene, "id" | "name" | "elements">) =>
  change("PUT", `/scenes/${id(scene.id)}`, { name: scene.name, elements: scene.elements });
export const deleteScene = (sceneId: string) => change("DELETE", `/scenes/${id(sceneId)}`);
export const activateScene = (sceneId: string) => change("POST", `/scenes/${id(sceneId)}/activate`);
export const saveTemplate = (sceneId: string, name?: string) =>
  change("POST", "/templates", name ? { scene_id: sceneId, name } : { scene_id: sceneId });
export const deleteTemplate = (templateId: string) => change("DELETE", `/templates/${id(templateId)}`);
export const saveSettings = (settings: StudioSettings) => change("PUT", "/settings", settings);
export const showBanner = (banner: { text: string; kind?: "custom" | "info" | "goal" | "card"; duration_s?: number; source_id?: string }) =>
  change("POST", "/banner", banner);
export const clearBanner = () => change("DELETE", "/banner");
export const saveTicker = (ticker: Ticker) => change("PUT", "/ticker", ticker);
export const startCountdown = (startsAt: number, label = "") =>
  change("POST", "/countdown", { kind: "start", starts_at: startsAt, label });
export const startBreak = (minutes: number, label = "") => change("POST", "/countdown", { kind: "break", minutes, label });
export const endCountdown = () => change("DELETE", "/countdown");
export const startReplay = (matchId: string, momentId: string) =>
  change("POST", "/replay", { match_id: matchId, moment_id: momentId });
export const stopReplay = () => change("DELETE", "/replay");

export async function uploadImage(file: Blob): Promise<string> {
  const response = await fetch("/api/studio/images", { method: "POST", body: file });
  if (!response.ok) throw await toError(response);
  return ((await response.json()) as { id: string }).id;
}

export const imageUrl = (imageId: string) => `/api/studio/images/${id(imageId)}`;

export const fetchReplay = (matchId: string, momentId: string) =>
  send<{ moment: KeyMoment; events: MatchEvent[] }>("GET", `/api/matches/${id(matchId)}/moments/${id(momentId)}/replay`);
