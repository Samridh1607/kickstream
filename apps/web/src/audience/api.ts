import type { Audience } from "../contracts";
import { send } from "../studio/api";

export const AUDIENCE_STREAM = "/api/audience/stream";
export const STUDIO_AUDIENCE_STREAM = "/api/studio/audience/stream";

const id = encodeURIComponent;
const asFan = (voterId: string) => ({ "x-voter": voterId });
const fan = (voterId: string, path: string, body?: unknown) => send<Audience>("POST", `/api/audience${path}`, body, asFan(voterId));
const studio = (method: string, path: string, body?: unknown) => send<Audience>(method, `/api/studio/audience${path}`, body);

// --- fans ----------------------------------------------------------------------------------------

export const votePoll = (voterId: string, optionId: string) => fan(voterId, "/poll/vote", { option_id: optionId });
export const upvoteQuestion = (voterId: string, questionId: string) => fan(voterId, `/questions/${id(questionId)}/vote`, {});
export const askQuestion = (voterId: string, text: string, nickname: string) =>
  send<{ id: string; audience: Audience }>("POST", "/api/audience/questions", { text, nickname }, asFan(voterId));

// --- the streamer --------------------------------------------------------------------------------

export const createPoll = (poll: { question: string; options: string[]; duration_s?: number }) => studio("POST", "/poll", poll);
export const presetPoll = (preset: "winner" | "next_goal", duration_s?: number) =>
  studio("POST", "/poll", duration_s === undefined ? { preset } : { preset, duration_s });
export const closePoll = () => studio("POST", "/poll/close", {});
export const setPollOnAir = (on: boolean) => studio("PUT", "/poll/on-air", { on });
export const restorePoll = (pollId: string) => studio("POST", `/history/${id(pollId)}/restore`, {});
export const hideQuestion = (questionId: string) => studio("POST", `/questions/${id(questionId)}/hide`, {});
export const unhideQuestion = (questionId: string) => studio("POST", `/questions/${id(questionId)}/unhide`, {});
export const askExpert = (questionId: string) => studio("POST", `/questions/${id(questionId)}/ask`, {});
export const saveDraft = (text: string) => studio("PUT", "/draft", { text });
export const discardDraft = () => studio("DELETE", "/draft");
export const airDraft = (duration_s?: number) => studio("POST", "/draft/air", duration_s === undefined ? {} : { duration_s });
export const clearQa = () => studio("DELETE", "/qa");
