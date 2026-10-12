// @vitest-environment node
import { readFile } from "node:fs/promises";
import { render, target } from "../scripts/gen-contracts.mjs";
import type { Envelope, Narrative, Overlay } from "./contracts";

const normalized = (text: string) => text.replace(/\r\n/g, "\n");

test("generated contracts are current", async () => {
  expect(normalized(await readFile(target, "utf8"))).toBe(normalized(await render()));
});

test("generated types match what the gateway sends", () => {
  const narrative: Narrative = {
    id: "m-1-k1-fan-en", match_id: "m-1", minute: 10, moment_id: "m-1-k1", mode: "fan", language: "en",
    text: "GOAL!", source: "scripted", agent: "scripted", evidence: ["m-1-k1"], team: "home", player_id: null,
  };
  const overlay: Overlay = {
    id: "m-1-o1", match_id: "m-1", minute: 10, kind: "pressure_map", language: null, duration_ms: 8000,
    sources: [], data: { cols: 6, rows: 4, home: [], away: [] },
  };
  const envelope: Envelope = { id: 1, type: "narrative", match_id: "m-1", minute: 10, highlighted: false, payload: { ...narrative } };
  expect([narrative.mode, overlay.kind, envelope.type]).toEqual(["fan", "pressure_map", "narrative"]);
});
