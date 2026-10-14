import { element, status } from "../test/fixtures";
import { isKeyEvents, limitedByLiveData, needsPositions } from "./liveData";

test("a pitch, a 3D pitch and a momentum graph need positions; a scoreboard does not", () => {
  expect(needsPositions(element({ type: "pitch" }))).toBe(true);
  expect(needsPositions(element({ type: "pitch3d" }))).toBe(true);
  expect(needsPositions(element({ type: "replay" }))).toBe(true);
  expect(needsPositions(element({ type: "graph", props: { metric: "win_probability" } }))).toBe(false);
  expect(needsPositions(element({ type: "graph", props: { metric: "xg" } }))).toBe(true);
  expect(needsPositions(element({ type: "graph", props: {} }))).toBe(true);
  expect(needsPositions(element({ type: "scoreboard" }))).toBe(false);
});

test("only the next-action prediction and the tactics chart need positions", () => {
  expect(needsPositions(element({ type: "prediction", props: { view: "next_action" } }))).toBe(true);
  expect(needsPositions(element({ type: "prediction", props: {} }))).toBe(false);
  expect(needsPositions(element({ type: "chart", props: { metric: "tactics" } }))).toBe(true);
  expect(needsPositions(element({ type: "chart", props: { metric: "possession" } }))).toBe(false);
  expect(needsPositions(element({ type: "chart", props: {} }))).toBe(false);
});

test("only key-events matches are limited", () => {
  expect(limitedByLiveData(element({ type: "pitch" }), status({ detail: "full" }))).toBe(false);
  expect(limitedByLiveData(element({ type: "pitch" }), status())).toBe(false);
  expect(limitedByLiveData(element({ type: "pitch" }), null)).toBe(false);
  expect(limitedByLiveData(element({ type: "pitch" }), status({ detail: "key_events" }))).toBe(true);
  expect(limitedByLiveData(element({ type: "scoreboard" }), status({ detail: "key_events" }))).toBe(false);
  expect([isKeyEvents(status({ detail: "key_events" })), isKeyEvents(undefined)]).toEqual([true, false]);
});
