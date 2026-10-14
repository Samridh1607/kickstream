import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { defineConfig } from "@playwright/test";
import base, { webServers } from "./playwright.config";

// The API-Football key stays in the .env file at the top of the project, never printed. It reaches the
// test pipeline through this process's environment, which Playwright hands to its servers, rather than
// through the config, which reporters may write out.
const file = resolve(import.meta.dirname, "../../.env");
const fromFile = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
const key = process.env.KICKSTREAM_API_FOOTBALL_KEY ?? fromFile.KICKSTREAM_API_FOOTBALL_KEY ?? "";
if (key !== "") process.env.KICKSTREAM_API_FOOTBALL_KEY = key;

// Empty addresses mean each source's real one, and the source's own polling schedule.
export default defineConfig({
  ...base,
  testDir: "e2e-network",
  timeout: 300_000,
  metadata: { apiFootball: key !== "" },
  webServer: webServers(
    { KICKSTREAM_STATSBOMB_URL: "", KICKSTREAM_API_FOOTBALL_URL: "", KICKSTREAM_OPENLIGADB_URL: "", KICKSTREAM_LIVE_POLL_S: "" },
    { fakeSources: false },
  ),
});
