import { defineConfig } from "@playwright/test";

// No model endpoint is configured, so the whole run uses scripted narratives.
const NO_MODEL = { KICKSTREAM_LLM_BASE_URL: "", KICKSTREAM_LLM_MODEL: "", KICKSTREAM_LLM_API_KEY: "" };

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  use: { baseURL: "http://127.0.0.1:5173" },
  webServer: [
    {
      command: "uv run --project ../../services/pipeline uvicorn kickstream.app:create_app --factory --port 8000",
      url: "http://127.0.0.1:8000/api/teams",
      env: NO_MODEL,
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
