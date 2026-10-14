import { resolve } from "node:path";
import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";

// No model endpoint is configured, so the whole run uses scripted narratives.
const NO_MODEL = { KICKSTREAM_LLM_BASE_URL: "", KICKSTREAM_LLM_MODEL: "", KICKSTREAM_LLM_API_KEY: "" };
// The tests run their own pipeline and dev server, on their own ports and data directory, so they
// never touch the scenes or match of a developer who has Kickstream running.
export const API = "http://127.0.0.1:8010";
export const WEB = "http://127.0.0.1:5183";
/** The local stand-in for StatsBomb, API-Football and OpenLigaDB; see e2e/fake-sources.mjs. */
export const FAKE_SOURCES = "http://127.0.0.1:8020";
/** The tunnel the tests pretend guests come through. */
export const PUBLIC_HOST = "guests.example";
// A fresh data directory for every run, so one run's scenes and broadcasts never meet the next.
// The runner and each worker load this file, so the first one picks the directory and hands it down.
export const DATA_DIR = (process.env.E2E_DATA_DIR ??= resolve(import.meta.dirname, ".data-e2e", String(Date.now())));
// The hidden browser must open the program page on the tests' own dev server, not a developer's.
// Guests use in-memory rooms, so no test needs Azure.
const TEST_SERVER = {
  ...NO_MODEL, KICKSTREAM_DATA_DIR: DATA_DIR, KICKSTREAM_PROGRAM_URL: `${WEB}/studio?output`,
  KICKSTREAM_ROOMS: "fake", KICKSTREAM_PUBLIC_HOSTS: PUBLIC_HOST,
};
// Every match source answers from the stand-in, so no test reaches the internet or needs a real key.
const SOURCES = {
  KICKSTREAM_STATSBOMB_URL: `${FAKE_SOURCES}/statsbomb/`, KICKSTREAM_API_FOOTBALL_URL: `${FAKE_SOURCES}/api-football`,
  KICKSTREAM_API_FOOTBALL_KEY: "e2e-fake-key", KICKSTREAM_OPENLIGADB_URL: `${FAKE_SOURCES}/openligadb`,
  KICKSTREAM_OPENLIGADB_LEAGUES: "bl1", KICKSTREAM_LIVE_POLL_S: "1",
};

export function webServers(env: Record<string, string> = {}, { fakeSources = true } = {}): PlaywrightTestConfig["webServer"] {
  return [
    {
      command: "uv run --project ../../services/pipeline uvicorn kickstream.app:create_app --factory --port 8010",
      url: `${API}/api/teams`,
      env: { ...TEST_SERVER, ...(fakeSources ? SOURCES : {}), ...env },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "pnpm dev --host 127.0.0.1 --port 5183 --strictPort",
      url: WEB,
      env: { KICKSTREAM_API: API, KICKSTREAM_PUBLIC_HOSTS: PUBLIC_HOST },
      reuseExistingServer: false,
    },
    ...(fakeSources ? [{ command: "node e2e/fake-sources.mjs", url: `${FAKE_SOURCES}/health`, reuseExistingServer: false }] : []),
  ];
}

export default defineConfig({
  testDir: "e2e",
  // The server runs one match at a time, so tests that start matches must not overlap.
  workers: 1,
  timeout: 120_000,
  use: {
    baseURL: WEB,
    // A test pattern and a beep stand in for a guest's camera and microphone.
    permissions: ["camera", "microphone"],
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  },
  webServer: webServers(),
});
