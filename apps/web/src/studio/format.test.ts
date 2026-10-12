import { stats, status, studio } from "../test/fixtures";
import { countdownLabel, formatRemaining, tickerItems } from "./format";

test.each([
  [0, "0:00"], [-5, "0:00"], [9.2, "0:10"], [59, "0:59"], [60, "1:00"], [754, "12:34"], [3600, "1:00:00"], [3725, "1:02:05"],
])("formatRemaining(%d) is %s", (seconds, expected) => {
  expect(formatRemaining(seconds)).toBe(expected);
});

test("a countdown uses its own label, or a localized default for its kind", () => {
  expect(countdownLabel({ kind: "start", ends_at: 0, label: "Doors open" }, "en")).toBe("Doors open");
  expect(countdownLabel({ kind: "start", ends_at: 0, label: "" }, "en")).toBe("Kick-off in");
  expect(countdownLabel({ kind: "break", ends_at: 0, label: "" }, "es")).toBe("Volvemos en");
  expect(countdownLabel({ kind: "break", ends_at: 0, label: "  " }, "hi")).toBe("वापसी में");
});

test("the ticker carries the streamer's messages, then the score and stats lines", () => {
  const ticker = { ...studio().ticker, messages: ["Welcome", "Subscribe"] };
  const live = status({ score_home: 2, score_away: 1 });
  const numbers = stats({ shots: 7, possession: 61.5 }, { shots: 2, possession: 38.5 });
  expect(tickerItems(ticker, live, numbers, "en")).toEqual([
    "Welcome", "Subscribe", "Northbridge FC 2-1 Harbour City", "Shots 7-2 · Possession % 61.5-38.5",
  ]);
  expect(tickerItems(ticker, live, numbers, "es")[3]).toBe("Remates 7-2 · Posesión % 61.5-38.5");
});

test("automatic ticker lines can be switched off and need match data", () => {
  const base = studio().ticker;
  expect(tickerItems({ ...base, show_score: false, show_stats: false }, status(), stats(), "en")).toEqual([]);
  expect(tickerItems(base, null, null, "en")).toEqual([]);
  expect(tickerItems({ ...base, enabled: false, messages: ["Hi"] }, status(), stats(), "en")).toEqual([]);
});
