import { type APIRequestContext, expect, test } from "@playwright/test";
import { FAKE_SOURCES } from "../playwright.config";
import { openStudio, openStudioAt, openTool } from "./broadcasts";

// The test pipeline; see playwright.config.ts. Its match sources are the stand-in in fake-sources.mjs.
const API = "http://127.0.0.1:8010";
const FINAL_SCORE = /\b4\s*[-–:]\s*2\b/;

/** Puts a new scene from a built-in template on air, and returns how to put the studio back. */
async function onAir(request: APIRequestContext, template: string, name: string): Promise<() => Promise<void>> {
  const before = await (await request.get(`${API}/api/studio`)).json();
  for (const leftover of before.scenes.filter((scene: { name: string }) => scene.name === name)) {
    await request.delete(`${API}/api/studio/scenes/${leftover.id}`);
  }
  const made = await (await request.post(`${API}/api/studio/scenes`, { data: { source: "builtin", ref: template, name } })).json();
  const sceneId: string = made.scenes.at(-1).id;
  await request.post(`${API}/api/studio/scenes/${sceneId}/activate`);
  return async () => {
    await request.post(`${API}/api/studio/scenes/${before.active_scene_id}/activate`);
    await request.delete(`${API}/api/studio/scenes/${sceneId}`);
  };
}

/** Moves a live fixture of the stand-in on to its next recorded state. */
const advance = (request: APIRequestContext, source: "api_football" | "openligadb") =>
  request.post(`${FAKE_SOURCES}/__advance`, { data: { source } });

test.use({ viewport: { width: 1536, height: 864 } });

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE_SOURCES}/__reset`);
});

test.afterEach(async ({ request }) => {
  await request.post(`${API}/api/matches/stop`);
  await request.put(`${API}/api/studio/queued-match`, { headers: { "content-type": "application/json" }, data: "null" });
});

test("a StatsBomb replay chosen in the studio plays to the program with the credit", async ({ page, request }) => {
  const restore = await onAir(request, "Analyst desk", "E2E replay desk");
  const program = await page.context().newPage();
  try {
    await openStudioAt(page, request, `Replay ${Date.now()}`, "?speed=600");
    await program.goto("/studio?output");
    const tool = await openTool(page, "Match");
    await tool.getByRole("radio", { name: "StatsBomb replay" }).check();
    await tool.getByLabel("Competition").selectOption({ label: "FIFA World Cup · 2018" });
    const final = tool.getByRole("button", { name: "France vs Croatia" });
    await expect(final).toBeVisible();
    await expect(tool).not.toContainText(FINAL_SCORE);
    await final.click();
    await tool.getByLabel("Speed").selectOption({ label: "600×" });
    await tool.getByRole("button", { name: "Start match" }).click();

    const onStage = page.getByRole("region", { name: "Stage", exact: true }).getByTestId("element-scoreboard");
    await expect(onStage).toContainText("France", { timeout: 30_000 });
    await expect(onStage).toContainText("Croatia");
    await expect(program.getByTestId("program-credit")).toHaveText("Data: StatsBomb");
    await expect(program.getByTestId("program-score")).toHaveText("4 - 2", { timeout: 60_000 });
    await expect(program.getByTestId("element-narration")).toContainText("France", { timeout: 30_000 });

    // The match data page follows the replay, and Ask Copilot answers from it.
    await page.goto("/match");
    const scoreboard = page.getByTestId("score").locator("..");
    await expect(scoreboard).toContainText("France");
    await expect(scoreboard).toContainText("Croatia");
    await expect(page.getByTestId("match-source")).toContainText("Data: StatsBomb");
    await expect(page.getByRole("dialog")).toContainText("Full-time", { timeout: 30_000 });
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("navigation", { name: "Match intelligence" }).getByRole("button", { name: "Match", exact: true }).click();
    await page.getByRole("button", { name: "Ask Copilot" }).click();
    const pane = page.getByRole("complementary", { name: "Ask Copilot" });
    await pane.getByRole("button", { name: "What is the score?" }).click();
    await expect(pane.getByTestId("copilot-answer").last()).toContainText("France");
  } finally {
    await program.close();
    await restore();
  }
});

// Runs before the live test: once read, the day's API-Football fixtures are kept for ten minutes and not asked for again.
test("a refused API-Football key is explained where the source is chosen", async ({ page, request }) => {
  await request.post(`${FAKE_SOURCES}/__mode`, { data: { api_football: "token-error" } });
  await openStudio(page, request, `Refused key ${Date.now()}`);
  const tool = await openTool(page, "Match");
  await tool.getByRole("radio", { name: "API-Football live" }).check();
  await expect(tool.getByText(/^API-Football refused the request: .*Check KICKSTREAM_API_FOOTBALL_KEY/)).toBeVisible();
});

test("an API-Football live match updates, and elements that need positions say they are not available", async ({ page, request }) => {
  const restore = await onAir(request, "Match intelligence", "E2E live intelligence");
  const program = await page.context().newPage();
  try {
    await openStudio(page, request, `Live ${Date.now()}`);
    await program.goto("/studio?output");
    const tool = await openTool(page, "Match");
    await tool.getByRole("radio", { name: "API-Football live" }).check();
    const fixture = tool.getByRole("button", { name: "Liverpool vs Everton" });
    await expect(fixture).toContainText("Live 12'");
    await fixture.click();
    await tool.getByRole("button", { name: "Start match" }).click();
    await expect(tool.getByRole("region", { name: "Now playing" })).toContainText("Liverpool vs Everton");

    await expect(program.getByTestId("program-credit")).toHaveText("Data: API-Football");
    await expect(program.getByTestId("element-pitch3d").getByTestId("live-data-only")).toHaveText("Not available with live data");
    await expect(program.getByTestId("element-graph").getByTestId("live-data-only")).toBeVisible();
    const score = program.getByTestId("scorecard-score");
    await expect(score).toHaveText("0:0");
    await advance(request, "api_football");
    await expect(score).toHaveText("1:0");
    await advance(request, "api_football");
    await advance(request, "api_football");
    await expect(score).toHaveText("2:1");
    await expect(tool.getByText(/^[1-9]\d* of 100 requests used today$/)).toBeVisible({ timeout: 15_000 });
  } finally {
    await program.close();
    await restore();
  }
});

test("an OpenLigaDB match names its scorers in the commentary", async ({ page, request }) => {
  await openStudio(page, request, `OpenLigaDB ${Date.now()}`);
  const tool = await openTool(page, "Match");
  await tool.getByRole("radio", { name: "OpenLigaDB live" }).check();
  await tool.getByRole("button", { name: "TSG Hoffenheim vs Hamburger SV" }).click();
  await tool.getByRole("button", { name: "Start match" }).click();
  await expect(tool.getByRole("region", { name: "Now playing" })).toContainText("TSG Hoffenheim vs Hamburger SV");

  await page.goto("/match");
  await page.getByRole("navigation", { name: "Match intelligence" }).getByRole("button", { name: "Match", exact: true }).click();
  await expect(page.getByText(/Yussuf Poulsen/).first()).toBeVisible({ timeout: 30_000 });
  await advance(request, "openligadb");
  await advance(request, "openligadb");
  await expect(page.getByTestId("score")).toHaveText("2 - 3", { timeout: 30_000 });
  await expect(page.getByTestId("match-source")).toContainText("Data: OpenLigaDB");
});

test("the match data page's Choose match starts a replay", async ({ page, request }) => {
  // A match still playing, so no full-time recap of an earlier one opens over the picker.
  await request.post(`${API}/api/matches`, { data: { speed: 1 } });
  await page.goto("/match?speed=600");
  await expect(page.getByTestId("score").locator("..")).toContainText("Northbridge FC");
  await page.getByRole("button", { name: "Choose match" }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a match" });
  await dialog.getByRole("radio", { name: "StatsBomb replay" }).check();
  await dialog.getByLabel("Competition").selectOption({ label: "FIFA World Cup · 2018" });
  await dialog.getByRole("button", { name: "France vs Croatia" }).click();
  await dialog.getByLabel("Speed").selectOption({ label: "600×" });
  await dialog.getByRole("button", { name: "Start match" }).click();
  await expect(dialog).toHaveCount(0);
  const scoreboard = page.getByTestId("score").locator("..");
  await expect(scoreboard).toContainText("France", { timeout: 30_000 });
  await expect(scoreboard).toContainText("Croatia");
  await expect(page.getByTestId("match-source")).toContainText("Data: StatsBomb");
});

test("Stop match in the Match tool ends the running match", async ({ page, request }) => {
  await openStudio(page, request, `Stop ${Date.now()}`);
  const tool = await openTool(page, "Match");
  await tool.getByRole("button", { name: "Start match" }).click();
  const playing = tool.getByRole("region", { name: "Now playing" });
  await expect(playing).toBeVisible();
  await playing.getByRole("button", { name: "Stop match" }).click();
  await expect(playing).toHaveCount(0);
});
