import type { ViewerProfile } from "./contracts";
import { LANGUAGES, MODES } from "./i18n";

const KEY = "kickstream.profile";

export const DEFAULT_PROFILE: ViewerProfile = { mode: "fan", language: "en", club: null, player: null };

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Reads saved preferences. Anything missing, mistyped or unsupported falls back to its default. */
export function loadProfile(storage: Pick<Storage, "getItem"> = localStorage): ViewerProfile {
  try {
    const raw: unknown = JSON.parse(storage.getItem(KEY) ?? "null");
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_PROFILE;
    const saved = raw as Record<string, unknown>;
    return {
      mode: MODES.find((mode) => mode === saved.mode) ?? DEFAULT_PROFILE.mode,
      language: LANGUAGES.find((language) => language === saved.language) ?? DEFAULT_PROFILE.language,
      club: text(saved.club),
      player: text(saved.player),
    };
  } catch {
    return DEFAULT_PROFILE;
  }
}

export function saveProfile(profile: ViewerProfile, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(KEY, JSON.stringify(profile));
  } catch {
    // Preferences are a convenience; a full or blocked store must not break the app.
  }
}
