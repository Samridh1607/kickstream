/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "KICKSTREAM_");
  const publicHosts = (env.KICKSTREAM_PUBLIC_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean);
  return {
    plugins: [react()],
    // KICKSTREAM_API lets the browser tests point their own dev server at their own pipeline.
    // A tunnel's hostnames (KICKSTREAM_PUBLIC_HOSTS) are served too, so guests can open their links.
    // Through a tunnel anyone can ask for any allowed file, so only the app and its packages are
    // allowed, never the data directory with its invite secrets and stream keys.
    server: {
      port: 5173,
      allowedHosts: publicHosts,
      fs: {
        allow: [".", "../../node_modules"],
        deny: [".env", ".env.*", "*.{crt,pem,key,p12,pfx,cer,der}", ".npmrc", ".yarnrc.yml", "**/.git/**", "**/.data*/**"],
      },
      proxy: { "/api": { target: env.KICKSTREAM_API ?? "http://127.0.0.1:8000", ws: true } },
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
      // The first render of the whole dashboard is slow on a cold, busy machine.
      testTimeout: 20_000,
    },
  };
});
