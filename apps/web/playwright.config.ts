import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";

// No model endpoint is configured, so the whole run uses scripted narratives.
const NO_MODEL = { KICKSTREAM_LLM_BASE_URL: "", KICKSTREAM_LLM_MODEL: "", KICKSTREAM_LLM_API_KEY: "" };
// The tests run their own pipeline and dev server, on their own ports and data directory, so they
// never touch the scenes or match of a developer who has Kickstream running.
export const API = "http://127.0.0.1:8010";
export const WEB = "http://127.0.0.1:5183";
/** The tunnel the tests pretend guests come through. */
export const PUBLIC_HOST = "guests.example";
// A fresh data directory for every run, so one run's scenes and broadcasts never meet the next.
// The hidden browser must open the program page on the tests' own dev server, not a developer's.
// Guests use in-memory rooms, so no test needs Azure.
const TEST_SERVER = {
  ...NO_MODEL, KICKSTREAM_DATA_DIR: `.data-e2e/${Date.now()}`, KICKSTREAM_PROGRAM_URL: `${WEB}/studio?output`,
  KICKSTREAM_ROOMS: "fake", KICKSTREAM_PUBLIC_HOSTS: PUBLIC_HOST,
};

export function webServers(env: Record<string, string> = {}): PlaywrightTestConfig["webServer"] {
  return [
    {
      command: "uv run --project ../../services/pipeline uvicorn kickstream.app:create_app --factory --port 8010",
      url: `${API}/api/teams`,
      env: { ...TEST_SERVER, ...env },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "pnpm dev --host 127.0.0.1 --port 5183 --strictPort",
      url: WEB,
      env: { KICKSTREAM_API: API, KICKSTREAM_PUBLIC_HOSTS: PUBLIC_HOST },
      reuseExistingServer: false,
    },
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
