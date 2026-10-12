import { defineConfig } from "@playwright/test";

// No model endpoint is configured, so the whole run uses scripted narratives.
const NO_MODEL = { KICKSTREAM_LLM_BASE_URL: "", KICKSTREAM_LLM_MODEL: "", KICKSTREAM_LLM_API_KEY: "" };
// A server Playwright starts itself keeps its studio apart from a developer's own.
const TEST_SERVER = { ...NO_MODEL, KICKSTREAM_DATA_DIR: ".data-e2e" };

export default defineConfig({
  testDir: "e2e",
  // The server runs one match at a time, so tests that start matches must not overlap.
  workers: 1,
  timeout: 120_000,
  use: { baseURL: "http://127.0.0.1:5173" },
  webServer: [
    {
      command: "uv run --project ../../services/pipeline uvicorn kickstream.app:create_app --factory --port 8000",
      url: "http://127.0.0.1:8000/api/teams",
      env: TEST_SERVER,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "pnpm dev --host 127.0.0.1",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
