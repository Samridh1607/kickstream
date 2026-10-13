import { broadcast, endedBroadcast, reel } from "../test/fixtures";
import { bytes, clock, duration, intoBroadcast, onAir, plural, post, reach, teamName, votes } from "./format";

test("times read as a clock and as a duration", () => {
  expect([clock(65), clock(3723), clock(-3)]).toEqual(["1:05", "1:02:03", "0:00"]);
  expect([duration(45), duration(125), duration(3900)]).toEqual(["45 s", "2 min", "1 h 5 min"]);
  expect([bytes(2048), bytes(5 * 1024 * 1024), bytes(3 * 1024 ** 3)]).toEqual(["2 KB", "5.0 MB", "3.0 GB"]);
  expect([plural(1, "reel"), plural(2, "reel"), plural(0, "poll")]).toEqual(["1 reel", "2 reels", "0 polls"]);
});

test("time on air counts every session, the open one up to now", () => {
  const live = broadcast({
    state: "live",
    sessions: [
      { started_at: 100, ended_at: 160, destinations: [], problem: null },
      { started_at: 200, ended_at: null, destinations: [], problem: null },
    ],
  });
  expect(onAir(live, 230)).toBe(90);
  expect(onAir(endedBroadcast(), 99999)).toBe(120);
});

test("the stats a broadcast page shows", () => {
  const done = endedBroadcast();
  expect(reach(done)).toEqual({ reached: 2, total: 3 });
  expect(votes(done)).toBe(7);
  expect(teamName(done, "away")).toBe("Harbour City");
  expect(teamName(broadcast(), "home")).toBeNull();
  expect(intoBroadcast(done, 1042)).toBe(42);
});

test("the post to paste is the title, caption and hashtags", () => {
  expect(post(reel())).toBe("GOAL! Northbridge FC score in the 23'\n\nTop corner!\n\n#Kickstream #Goal");
  expect(post(reel({ caption: "", hashtags: [] }))).toBe("GOAL! Northbridge FC score in the 23'");
});
