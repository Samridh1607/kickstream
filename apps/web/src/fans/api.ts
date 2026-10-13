import type { FanSettings, FanZone } from "../contracts";
import { send } from "../studio/api";

export const FANS_STREAM = "/api/fans/stream";

export type WinnerPool = "commenters" | "voters" | "supporters";

const id = encodeURIComponent;
const call = (method: string, path = "", body?: unknown) => send<FanZone>(method, `/api/fans${path}`, body);

export const saveFanSettings = (settings: FanSettings) => call("PUT", "/settings", settings);
export const likeComment = (commentId: string, liked: boolean) => call("POST", `/comments/${id(commentId)}/like`, { liked });
export const spotlightComment = (commentId: string) => call("POST", `/comments/${id(commentId)}/spotlight`);
export const openPoll = (question: string, options: string[], minutes: number | null) =>
  call("POST", "/poll", minutes === null ? { question, options } : { question, options, minutes });
export const closePoll = () => call("POST", "/poll/close");
export const announcePoll = () => call("POST", "/poll/announce");
export const setPollOnAir = (onAir: boolean) => call("PUT", "/poll/air", { on_air: onAir });
export const removePoll = () => call("DELETE", "/poll");
export const addSuperchat = (superchat: { name: string; amount: number; currency: string; message: string }) => call("POST", "/superchats", superchat);
export const spotlightSuperchat = (superchatId: string) => call("POST", `/superchats/${id(superchatId)}/spotlight`);
export const showMessage = (message: { title: string; text: string; duration_s: number }) => call("POST", "/spotlight", message);
export const clearSpotlight = () => call("DELETE", "/spotlight");
export const pickWinner = (pool: WinnerPool) => call("POST", "/winner", { pool });
export const clearFans = () => call("DELETE");
