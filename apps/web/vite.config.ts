/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // KICKSTREAM_API lets the browser tests point their own dev server at their own pipeline.
  server: { port: 5173, proxy: { "/api": process.env.KICKSTREAM_API ?? "http://127.0.0.1:8000" } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // The first render of the whole dashboard is slow on a cold, busy machine.
    testTimeout: 20_000,
  },
});
