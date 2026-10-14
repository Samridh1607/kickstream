import { expect, test } from "@playwright/test";
import { editScene, openStudio, openTool } from "./broadcasts";

// The test pipeline; see playwright.config.ts.
const API = "http://127.0.0.1:8010";

test("the seven agents work on a match and each can be opened", async ({ page, request }) => {
  await page.goto("/match?speed=600");
  const rail = page.getByRole("navigation", { name: "Match intelligence" });
  for (const name of ["Event Interpreter", "Tactical Analyst", "Prediction Agent", "Player Tracking Agent", "Visualization Agent", "Highlights Agent", "Explainability Agent"]) {
    await expect(rail.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: /^(Start|Restart) match$/ }).click();

  // The overview fills in from every agent as the match is played.
  await expect(page.getByTestId("agent-flow")).toBeVisible();
  await expect(page.getByTestId("card-prediction").getByTestId("share-home")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("tactics-summary")).toContainText("rhythm", { timeout: 30_000 });
  // A player is a point on the pitch with a figure standing on it; the point itself has no size.
  await expect(page.getByTestId("pitch3d").getByTestId("pitch-player")).not.toHaveCount(0);
  await expect(page.getByTestId("pitch-ball")).toHaveCount(1);
  await expect(page.getByTestId("tracked-name")).not.toBeEmpty();
  await expect(page.getByTestId("card-highlights").getByText(/^Hidden · /).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("card-explanations").getByTestId("explanation").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("agent-run").first()).toBeVisible();

  // One agent's page: what it is told to do, and its own work.
  await rail.getByRole("button", { name: "Event Interpreter", exact: true }).click();
  await expect(page.getByText("Converts video detections into structured events.")).toBeVisible();
  await expect(page.getByTestId("play").first()).toBeVisible();

  // The endpoint behind the page gives every agent's latest output in one document.
  const { match_id: matchId } = await (await request.get(`${API}/api/matches/current`)).json();
  await expect.poll(async () => (await (await request.get(`${API}/api/matches/${matchId}/intelligence`)).json()).minute, { timeout: 30_000 }).toBe(90);
  const intelligence = await (await request.get(`${API}/api/matches/${matchId}/intelligence?mode=analyst`)).json();
  expect(intelligence.prediction.win_home + intelligence.prediction.draw + intelligence.prediction.win_away).toBeCloseTo(1, 1);
  expect(intelligence.tactics.summary).toContain("rhythm");
  expect(intelligence.highlights.length).toBeGreaterThan(5);
  expect(new Set(intelligence.explanations.map((item: { mode: string }) => item.mode))).toEqual(new Set(["analyst"]));

  // Switching an agent off is kept by the server; switch it back on for the tests that follow.
  await rail.getByRole("button", { name: "Highlights Agent", exact: true }).click();
  await page.getByRole("switch", { name: "Highlights Agent on" }).click();
  await expect(page.getByTestId("agent-state")).toHaveText("Off");
  const catalog = await (await request.get(`${API}/api/agents`)).json();
  expect(catalog.agents.find((agent: { id: string }) => agent.id === "highlights").enabled).toBe(false);
  await page.getByRole("switch", { name: "Highlights Agent on" }).click();
  await expect(page.getByTestId("agent-state")).not.toHaveText("Off");
});

test("a streamer adds widgets live and runs the fan zone", async ({ browser, request }) => {
  const before = await (await request.get(`${API}/api/studio`)).json();
  for (const leftover of before.scenes.filter((scene: { name: string }) => scene.name === "E2E fans")) {
    await request.delete(`${API}/api/studio/scenes/${leftover.id}`);
  }
  const made = await (await request.post(`${API}/api/studio/scenes`, { data: { source: "builtin", ref: "Live match", name: "E2E fans" } })).json();
  const sceneId = made.scenes.at(-1).id;
  // Comments come only from this test, so what is on screen is known.
  await request.delete(`${API}/api/fans`);
  await request.put(`${API}/api/fans/settings`, { data: { source: "off", auto_superchat: false } });

  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const control = await context.newPage();
  const program = await context.newPage();
  await program.setViewportSize({ width: 960, height: 540 });

  try {
    await openStudio(control, request, `Fan zone test ${Date.now()}`);
    await program.goto("/studio?output");
    await control.getByRole("region", { name: "Scenes" }).getByRole("button", { name: "Switch to E2E fans" }).click();
    await expect(control.getByText("On air: E2E fans")).toBeVisible();
    const layout = await editScene(control, "E2E fans");
    await expect(program.getByTestId("element-scoreboard")).toBeVisible();

    // One click puts a widget on the scene that is on air.
    const widgets = layout.getByRole("group", { name: "Widgets" });
    await widgets.getByRole("button", { name: "Add Prediction" }).click();
    await expect(program.getByTestId("element-prediction")).toBeVisible();
    await widgets.getByRole("button", { name: "Add Comments" }).click();
    await expect(program.getByTestId("program-comments")).toBeVisible();
    // Taking it off again removes it from the program.
    await layout.getByRole("button", { name: "Remove prediction" }).click();
    await expect(program.getByTestId("element-prediction")).toHaveCount(0);
    await layout.getByRole("button", { name: "Close edit layout" }).click();

    // Comments arrive from a platform bridge and appear on the program as plain text.
    await request.post(`${API}/api/fans/ingest`, {
      data: { comments: [{ id: "e2e-1", platform: "youtube", author: "Mei", text: "<i>Hello</i> from Osaka" }, { id: "e2e-2", platform: "x", author: "Rafa", text: "Great stream" }] },
    });
    await expect(program.getByTestId("fan-comment").filter({ hasText: "<i>Hello</i> from Osaka" })).toBeVisible();

    // The Comments tool: the summary, a poll that fans vote in by commenting, and quick actions.
    const comments = await openTool(control, "Comments");
    await expect(comments.getByTestId("fan-summary")).toContainText("The chat is");
    const poll = comments.getByRole("region", { name: "Poll" });
    await poll.getByRole("button", { name: "Next goal" }).click();
    await poll.getByRole("button", { name: "Start poll" }).click();
    await request.post(`${API}/api/fans/ingest`, {
      data: { comments: [{ id: "e2e-v1", author: "Mei", text: "1" }, { id: "e2e-v2", author: "Rafa", text: "1" }, { id: "e2e-v3", author: "Kofi", text: "2" }] },
    });
    await expect(comments.getByTestId("fan-poll")).toContainText("2 · 67%");
    await comments.getByTestId("fan-poll").getByRole("switch", { name: "On screen" }).click();
    // The scene has no poll element, so the program gives the poll a box of its own.
    await expect(program.getByTestId("program-poll")).toContainText("Will there be another goal?");
    await expect(program.getByTestId("poll-option").first()).toContainText("67%");

    // A superchat typed in by the streamer is thanked on screen by name.
    const chats = comments.getByRole("region", { name: "Superchats" });
    await chats.getByLabel("Supporter's name").fill("Asha Patel");
    await chats.getByLabel("Amount").fill("20");
    await chats.getByLabel("Their message").fill("Love the stream");
    await chats.getByRole("button", { name: "Add superchat" }).click();
    await chats.getByRole("button", { name: "Thank Asha Patel on screen" }).click();
    await expect(program.getByTestId("spotlight-name")).toHaveText("Asha Patel");
    await expect(program.getByTestId("program-spotlight")).toContainText("USD 20.00");

    // Quick actions: clear the screen, a custom message, then a winner.
    const quick = comments.getByRole("region", { name: "Quick actions" });
    await quick.getByRole("button", { name: "Clear screen" }).click();
    await expect(program.getByTestId("program-spotlight")).toHaveCount(0);
    await quick.getByLabel("Custom message").fill("Welcome to everyone watching!");
    await quick.getByRole("button", { name: "Show message" }).click();
    await expect(program.getByTestId("program-spotlight")).toContainText("Welcome to everyone watching!");
    await quick.getByRole("button", { name: "Clear screen" }).click();
    await quick.getByLabel("Pick the winner from").selectOption("voters");
    await quick.getByRole("button", { name: "Pick a winner" }).click();
    await expect(program.getByTestId("program-spotlight")).toHaveAttribute("data-kind", "winner");
    await expect(program.getByTestId("spotlight-name")).toContainText(/Mei|Rafa|Kofi/);
    await expect(program.getByRole("button")).toHaveCount(0);
  } finally {
    // The server closes a connection left idle, and a request sent as it does is reset: ask again once.
    const twice = async <T>(send: () => Promise<T>): Promise<T> => send().catch(send);
    await twice(() => request.delete(`${API}/api/fans`));
    await twice(() => request.put(`${API}/api/fans/settings`, { data: { source: "demo", auto_superchat: false } }));
    const now = await (await twice(() => request.get(`${API}/api/studio`))).json();
    const other = now.scenes.find((scene: { id: string }) => scene.id !== sceneId);
    if (other) await twice(() => request.post(`${API}/api/studio/scenes/${other.id}/activate`));
    await twice(() => request.delete(`${API}/api/studio/scenes/${sceneId}`));
    await context.close();
  }
});
