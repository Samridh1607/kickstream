import { screen } from "@testing-library/react";
import type { FanZone, SceneElement } from "../contracts";
import { EMPTY, type MatchData } from "../stream/store";
import {
  element, explanation, fanComment, fanPoll, fanZone, moment, pitchScene, playerLine, playerReport, prediction, scene, stats, status, studio,
  superchat, tactics,
} from "../test/fixtures";
import { renderUi } from "../test/render";
import { ElementView, type ProgramData } from "./elements";
import { withFanFallbacks } from "./ProgramPage";
import { trackedPlayer } from "./widgets";

const live: MatchData = {
  ...EMPTY, minute: 37, status: status({ score_home: 2, score_away: 1, minute: 30 }),
  stats: stats({ shots: 7, possession: 60, xg: 1.25 }, { shots: 2, possession: 40, xg: 0.3 }),
  moments: [{ ...moment({ minute: 23 }), highlighted: false }],
  tactics: tactics(), prediction: prediction(), explanations: [explanation()], pitch: pitchScene(), players: playerReport(),
  series: [
    { minute: 1, momentum: 0.2, xgHome: 0.1, xgAway: 0, winHome: 0.4, draw: 0.3, winAway: 0.3 },
    { minute: 2, momentum: -0.4, xgHome: 0.3, xgAway: 0.2, winHome: 0.5, draw: 0.3, winAway: 0.2 },
  ],
};

function show(type: SceneElement["type"], props: Record<string, unknown> = {}, over: Partial<ProgramData> = {}) {
  const data: ProgramData = { match: live, studio: studio(), now: 1000, language: "en", fans: fanZone(), ...over };
  return renderUi(<ElementView element={element({ type, props })} data={data} />);
}

const fans = (over: Partial<FanZone>) => ({ fans: fanZone(over) });

test("the score card shows both sides, the score, the clock and who scored", () => {
  show("scorecard");
  expect(screen.getByTestId("scorecard-score").textContent).toBe("2:1");
  expect(screen.getByText("Northbridge FC")).toBeTruthy();
  expect(screen.getByText("37'")).toBeTruthy();
  expect(screen.getByText("23' Marrowby")).toBeTruthy();
});

test("the score card waits for a match", () => {
  show("scorecard", {}, { match: EMPTY });
  expect(screen.getByTestId("scorecard-score").textContent).toBe("–:–");
});

test("before kick-off the score card says so instead of a minute", () => {
  show("scorecard", {}, { match: { ...EMPTY, status: status({ state: "pre_match" }) } });
  expect(screen.getByText("Before kick-off")).toBeTruthy();
  expect(screen.queryByText("0'")).toBeNull();
});

test("on a key-events match the 3D pitch and momentum say they are not available; win probability still draws", () => {
  const keyEvents = { match: { ...live, status: status({ detail: "key_events" }) } };
  const { unmount: pitch } = show("pitch3d", { camera: "auto" }, keyEvents);
  expect(screen.getByTestId("live-data-only").textContent).toBe("Not available with live data");
  expect(screen.queryByTestId("pitch3d")).toBeNull();
  pitch();
  const { unmount: momentum } = show("graph", { metric: "momentum" }, keyEvents);
  expect(screen.getByTestId("live-data-only")).toBeTruthy();
  momentum();
  show("graph", { metric: "win_probability" }, keyEvents);
  expect(screen.queryByTestId("live-data-only")).toBeNull();
  expect(screen.getByTestId("program-graph")).toBeTruthy();
});

test("a chart compares the two sides, with each value written out", () => {
  show("chart", { metric: "overview" });
  const possession = screen.getByTestId("compare-possession");
  expect(possession.textContent).toContain("60");
  expect(possession.textContent).toContain("40");
  expect(screen.getByTestId("compare-xg").textContent).toContain("1.25");
  expect(screen.getByRole("table", { name: "NBR compared with HBC" })).toBeTruthy();
});

test("a chart of possession is a ring, and one of tactics uses the Tactical Analyst's numbers", () => {
  const { unmount } = show("chart", { metric: "possession" });
  expect(screen.getByRole("img", { name: "Possession %: NBR 60%, HBC 40%" })).toBeTruthy();
  unmount();
  show("chart", { metric: "tactics" });
  expect(screen.getByTestId("compare-tilt").textContent).toContain("64");
});

test("a graph draws one line for momentum and one for each side's expected goals", () => {
  const { unmount } = show("graph", { metric: "momentum" });
  expect(screen.getByRole("img", { name: "Momentum · ▲ NBR ▼ HBC: Momentum -0.40" })).toBeTruthy();
  unmount();
  show("graph", { metric: "xg" });
  expect(screen.getByTestId("end-home").textContent).toBe("0.30");
  expect(screen.getByTestId("end-away").textContent).toBe("0.20");
});

test("a graph of win probability has a line for the draw, and says so in words", () => {
  show("graph", { metric: "win_probability" });
  expect(screen.getByRole("img", { name: "Win probability: NBR 50%, Draw 30%, HBC 20%" })).toBeTruthy();
});

test("a graph with nothing to draw says so", () => {
  show("graph", { metric: "xg" }, { match: EMPTY });
  expect(screen.getByText("The graph fills in as the match is played.")).toBeTruthy();
});

test("a prediction shows who wins, who scores next, or what happens next", () => {
  const { unmount } = show("prediction", { view: "outcome" });
  expect(screen.getByTestId("share-home").textContent).toContain("50%");
  expect(screen.getByTestId("share-draw").textContent).toContain("30%");
  unmount();
  const next = show("prediction", { view: "next_goal" });
  expect(screen.getAllByTestId("meter").map((meter) => meter.textContent)).toEqual(["Northbridge FC24%", "Harbour City10%"]);
  next.unmount();
  show("prediction", { view: "next_action" });
  expect(screen.getByText("What happens next · Northbridge FC on the ball")).toBeTruthy();
  expect(screen.getAllByTestId("meter").map((meter) => meter.textContent)).toEqual(["Pass70%", "Shot10%", "Loses the ball20%"]);
});

test("the insight shows the latest explanation", () => {
  show("insight");
  expect(screen.getByText("Why this matters · 12'")).toBeTruthy();
  expect(screen.getByText("They are not letting Harbour City settle.")).toBeTruthy();
});

test("the 3D pitch draws the scene, follows its camera, and says positions are estimated", () => {
  const { unmount } = show("pitch3d", { camera: "auto" });
  expect(screen.getByTestId("pitch3d").getAttribute("data-camera")).toBe("attack_home");
  expect(screen.getAllByTestId("pitch-player").map((player) => player.getAttribute("data-estimated"))).toEqual(["false", "true"]);
  expect(screen.getAllByTestId("danger-column")).toHaveLength(1);
  expect(screen.getAllByTestId("pass-lane")).toHaveLength(1);
  expect(screen.getByText("Player positions are estimated")).toBeTruthy();
  unmount();
  show("pitch3d", { camera: "tactical" });
  expect(screen.getByTestId("pitch3d").getAttribute("data-camera")).toBe("tactical");
});

test("the 3D pitch holds the view saved with the element, with no controls on the program", () => {
  const camera = () => screen.getByTestId("pitch-camera").style.transform;
  const scale = () => Number(/scale\(([\d.]+)\)/.exec(camera())![1]);
  const { unmount: fitted } = show("pitch3d", { camera: "broadcast", zoom: "a lot", turn: null });
  expect(screen.getByTestId("pitch-stage").style.transform).toBe("rotateX(56deg) rotateZ(0deg)");
  const level = scale();
  fitted();

  const { unmount: held } = show("pitch3d", { camera: "broadcast", zoom: 2, turn: 20, tilt: -8, pan_x: 0, pan_y: 0, player_id: "nbr-9" });
  expect(screen.getByTestId("pitch-stage").style.transform).toBe("rotateX(48deg) rotateZ(20deg)");
  expect(scale()).toBeGreaterThan(level * 1.5);
  expect(screen.getAllByTestId("pitch-player")[0].getAttribute("data-followed")).toBe("true");
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("slider")).toBeNull();
  const still = camera();
  held();

  show("pitch3d", { camera: "broadcast", zoom: 2, turn: 20, tilt: -8, follow_ball: true });
  expect(scale()).toBeGreaterThan(level * 1.5);
  expect(camera()).not.toBe(still);
});

test("the player card follows the chosen player, or else the best rated", () => {
  expect(trackedPlayer(live, null)?.name).toBe("Luca Marrowby");
  expect(trackedPlayer(live, "nobody")?.name).toBe("Luca Marrowby");
  expect(trackedPlayer(EMPTY, null)).toBeNull();
  show("player", { player_id: "hbc-1" }, { match: { ...live, players: playerReport({ players: [playerLine(), playerLine({ player_id: "hbc-1", name: "Osric Pendlebury", on_pitch: false })] }) } });
  expect(screen.getByTestId("player-name").textContent).toBe("Osric Pendlebury");
  expect(screen.getByText("FW · off the pitch")).toBeTruthy();
});

test("comments show the newest lines as plain text, and mark made-up ones", () => {
  const comments = [
    fanComment({ id: "c1", text: "First" }), fanComment({ id: "c2", text: "<b>Second</b>", demo: true }), fanComment({ id: "c3", text: "Third", liked: true }),
  ];
  const { unmount } = show("comments", { lines: 2 }, fans({ comments }));
  expect(screen.getAllByTestId("fan-comment").map((row) => row.textContent)).toEqual(["XPriya KDemo<b>Second</b>", "XPriya K★Third"]); // the X is the platform's mark
  unmount();
  show("comments", { lines: 4, liked_only: true }, fans({ comments }));
  expect(screen.getAllByTestId("fan-comment")).toHaveLength(1);
});

test("the poll shows while it is on screen, with each option's share", () => {
  const { unmount } = show("poll", {}, fans({ poll: fanPoll(), poll_on_air: false }));
  expect(screen.queryByTestId("program-poll")).toBeNull();
  unmount();
  show("poll", {}, fans({ poll: fanPoll(), poll_on_air: true }));
  expect(screen.getByText("Poll · 4 votes")).toBeTruthy();
  expect(screen.getAllByTestId("poll-option").map((option) => option.textContent)).toEqual(["1Home75%", "2Away25%"]);
  expect(screen.getByText("Vote by commenting the number")).toBeTruthy();
});

test("superchats show the supporter's name and amount, newest first", () => {
  show("superchat", { lines: 2 }, fans({ superchats: [superchat(), superchat({ id: "s2", name: "Ben", amount: 5, tier: 2 }), superchat({ id: "s3", name: "Cy", amount: 50, tier: 5 })] }));
  const chips = screen.getAllByTestId("superchat");
  expect(chips.map((chip) => chip.textContent)).toEqual(["CyUSD 50.00Go on!", "BenUSD 5.00Go on!"]);
  expect(chips[0].getAttribute("data-tier")).toBe("5");
});

test("the spotlight shows what is on screen: a superchat by name, or a winner", () => {
  const thanks = { id: "sp1", kind: "superchat" as const, title: "Superchat", text: "Go on!", name: "Asha", detail: "USD 20.00", tier: 4, duration_s: 18, ends_at: 1009 };
  const { unmount } = show("spotlight", {}, fans({ spotlight: thanks }));
  expect(screen.getByTestId("spotlight-name").textContent).toBe("Asha");
  expect(screen.getByText("USD 20.00")).toBeTruthy();
  expect(screen.getByText("Thank you")).toBeTruthy();
  unmount();
  const none = show("spotlight", {}, fans({ spotlight: null }));
  expect(screen.queryByTestId("program-spotlight")).toBeNull();
  none.unmount();
  show("spotlight", {}, fans({ spotlight: { id: "sp2", kind: "winner", title: "Winner", text: "Picked from 12 commenters.", name: "Priya K", duration_s: 15, ends_at: 1010 } }));
  expect(screen.getByTestId("program-spotlight").getAttribute("data-kind")).toBe("winner");
  expect(screen.getByTestId("spotlight-name").textContent).toBe("🏆 Priya K");
});

test("a spotlight or a poll on air gets a box in a scene that has none for it", () => {
  const plain = scene({ elements: [] });
  expect(withFanFallbacks(plain, fanZone())).toBe(plain);
  expect(withFanFallbacks(plain, null)).toBe(plain);
  const message = { id: "sp1", kind: "message" as const, title: "", text: "Hello", duration_s: 10, ends_at: 1010 };
  const both = withFanFallbacks(plain, fanZone({ spotlight: message, poll: fanPoll(), poll_on_air: true }));
  expect(both.elements.map((added) => [added.type, added.layer])).toEqual([["poll", 1], ["spotlight", 2]]);
  const own = scene({ elements: [element({ id: "sp", type: "spotlight", props: {} })] });
  expect(withFanFallbacks(own, fanZone({ spotlight: message }))).toBe(own);
  expect(withFanFallbacks(plain, fanZone({ poll: fanPoll(), poll_on_air: false }))).toBe(plain);
});
