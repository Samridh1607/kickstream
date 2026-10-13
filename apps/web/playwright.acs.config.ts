import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { defineConfig } from "@playwright/test";
import base, { webServers } from "./playwright.config";

// The connection string stays in the .env file at the top of the project, never printed. It reaches the
// test pipeline through this process's environment, which Playwright hands to its servers, rather than
// through the config, which reporters may write out.
const file = resolve(import.meta.dirname, "../../.env");
const fromFile = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
const connection = process.env.KICKSTREAM_ACS_CONNECTION_STRING ?? fromFile.KICKSTREAM_ACS_CONNECTION_STRING ?? "";
if (connection !== "") process.env.KICKSTREAM_ACS_CONNECTION_STRING = connection;

export default defineConfig({
  ...base,
  testDir: "e2e-acs",
  timeout: 240_000,
  metadata: { acs: connection !== "" },
  webServer: webServers({ KICKSTREAM_ROOMS: "" }),
});
