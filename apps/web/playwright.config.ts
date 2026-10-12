import { defineConfig } from "@playwright/test";

// No model endpoint is configured, so the whole run uses scripted narratives.
const NO_MODEL = { KICKSTREAM_LLM_BASE_URL: "", KICKSTREAM_LLM_MODEL: "", KICKSTREAM_LLM_API_KEY: "" };
// The tests run their own pipeline and dev server, on their own ports and data directory, so they
// never touch the scenes, polls or match of a developer who has Kickstream running.
const API = "http://127.0.0.1:8010";
const WEB = "http://127.0.0.1:5183";
const TEST_SERVER = { ...NO_MODEL, KICKSTREAM_DATA_DIR: ".data-e2e" };

export default defineConfig({
  testDir: "e2e",
  // The server runs one match at a time, so tests that start matches must not overlap.
  workers: 1,
  timeout: 120_000,
  use: { baseURL: WEB },
  webServer: [
    {
      command: "uv run --project ../../services/pipeline uvicorn kickstream.app:create_app --factory --port 8010",
      url: `${API}/api/teams`,
      env: TEST_SERVER,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "pnpm dev --host 127.0.0.1 --port 5183 --strictPort",
      url: WEB,
      env: { KICKSTREAM_API: API },
      reuseExistingServer: false,
    },
  ],
});
