const ID_KEY = "kickstream.voter";
export const CHOICES_KEY = "kickstream.choices";
const VALID_ID = /^[A-Za-z0-9-]{16,64}$/;
const REMEMBERED_POLLS = 40;

type Store = Pick<Storage, "getItem" | "setItem">;

export interface Voter {
  id: string;
  /** False when the browser would not store the ID, so it lasts only for this visit. */
  remembered: boolean;
}

/** What this browser has done, so the page can show it again after a reload. */
export interface Choices {
  polls: Record<string, string>;
  upvoted: string[];
  asked: string[];
}

const EMPTY: Choices = { polls: {}, upvoted: [], asked: [] };
let visitId: string | null = null;

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

/** This browser's ID for votes and questions. Created on first use; replaced if the stored one is malformed. */
export function getVoter(storage?: Store): Voter {
  try {
    const store = storage ?? localStorage;
    const stored = store.getItem(ID_KEY);
    if (stored && VALID_ID.test(stored)) return { id: stored, remembered: true };
    const created = newId();
    store.setItem(ID_KEY, created);
    return { id: created, remembered: true };
  } catch {
    visitId ??= newId();
    return { id: visitId, remembered: false };
  }
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

export function loadChoices(storage?: Store): Choices {
  try {
    const raw: unknown = JSON.parse((storage ?? localStorage).getItem(CHOICES_KEY) ?? "null");
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return EMPTY;
    const saved = raw as Record<string, unknown>;
    const polls: Record<string, string> = {};
    if (saved.polls !== null && typeof saved.polls === "object" && !Array.isArray(saved.polls)) {
      for (const [pollId, optionId] of Object.entries(saved.polls)) if (typeof optionId === "string") polls[pollId] = optionId;
    }
    return { polls, upvoted: strings(saved.upvoted), asked: strings(saved.asked) };
  } catch {
    return EMPTY;
  }
}

export function saveChoices(choices: Choices, storage?: Store): void {
  try {
    (storage ?? localStorage).setItem(CHOICES_KEY, JSON.stringify(choices));
  } catch {
    // Remembering choices is a convenience; a blocked store must not break voting.
  }
}

export function withPollVote(choices: Choices, pollId: string, optionId: string): Choices {
  const others = Object.entries(choices.polls).filter(([id]) => id !== pollId);
  const kept = [...others, [pollId, optionId] as [string, string]].slice(-REMEMBERED_POLLS);
  return { ...choices, polls: Object.fromEntries(kept) };
}

export function withUpvote(choices: Choices, questionId: string, on: boolean): Choices {
  const others = choices.upvoted.filter((id) => id !== questionId);
  return { ...choices, upvoted: on ? [...others, questionId] : others };
}

export function withAsked(choices: Choices, questionId: string): Choices {
  return choices.asked.includes(questionId) ? choices : { ...choices, asked: [...choices.asked, questionId] };
}
