import { expect, test } from "@playwright/test";
import { editScene, openStudio, openTool } from "./broadcasts";

// The test pipeline; see playwright.config.ts.
const API = "http://127.0.0.1:8010";

test("a streamer builds a scene, goes live, and drives the program", async ({ browser, request }) => {
  // Work on a scene of our own, and put the studio back afterwards.
  const before = await (await request.get(`${API}/api/studio`)).json();
  // A run that was cut short may have left its scene behind; a second one would make names ambiguous.
  for (const leftover of before.scenes.filter((scene: { name: string }) => scene.name === "E2E scene")) {
    await request.delete(`${API}/api/studio/scenes/${leftover.id}`);
  }
  // An earlier match may have left goal banners queued; ours would wait behind them. Each clear shows the next.
  for (let waiting = 0; waiting <= 10; waiting += 1) await request.delete(`${API}/api/studio/banner`);
  const made = await (await request.post(`${API}/api/studio/scenes`, { data: { source: "builtin", ref: "Live match", name: "E2E scene" } })).json();
  const sceneId = made.scenes.at(-1).id;

  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const control = await context.newPage();
  const program = await context.newPage();
  await program.setViewportSize({ width: 960, height: 540 });

  try {
    await openStudio(control, request, `Studio test ${Date.now()}`);
    await program.goto("/studio?output");

    // Scenes: clicking a scene's thumbnail cuts the program to it.
    await control.getByRole("region", { name: "Scenes" }).getByRole("button", { name: "Switch to E2E scene" }).click();
    await expect(control.getByText("On air: E2E scene")).toBeVisible();
    // The scene cut from may have a scoreboard too, drawn until it has faded out.
    await expect(program.getByTestId("element-scoreboard")).toHaveCount(1);
    await expect(program.getByTestId("element-scoreboard")).toBeVisible();
    await expect(program.getByRole("button")).toHaveCount(0);

    // Edit layout: dragging an element of the scene on air moves it on the program when the drag ends.
    const layout = await editScene(control, "E2E scene");
    await expect(layout.getByText("On the program", { exact: true })).toBeVisible();
    const leftBefore = await program.getByTestId("element-scoreboard").evaluate((node) => (node as HTMLElement).style.left);
    const handle = layout.getByRole("button", { name: "scoreboard element" });
    const box = (await handle.boundingBox())!;
    await control.mouse.move(box.x + 30, box.y + 20);
    await control.mouse.down();
    await control.mouse.move(box.x + 120, box.y + 20, { steps: 5 });
    await control.mouse.up();
    await expect
      .poll(() => program.getByTestId("element-scoreboard").evaluate((node) => (node as HTMLElement).style.left))
      .not.toBe(leftBefore);
    await layout.getByRole("button", { name: "Close edit layout" }).click();
    await expect(control.getByRole("region", { name: "Stage", exact: true }).getByTestId("element-scoreboard")).toBeVisible();

    // Banner: a custom banner reaches the program.
    const banners = await openTool(control, "Banners");
    await banners.getByLabel("Banner text").fill("Welcome to matchday");
    await banners.getByRole("button", { name: "Show banner" }).click();
    await expect(program.getByTestId("program-banner")).toHaveText("Welcome to matchday");

    // Match: the program follows it, and a goal can be replayed.
    await request.post(`${API}/api/matches`, { data: { speed: 600 } });
    await expect(program.getByTestId("program-score")).not.toHaveText("–", { timeout: 30_000 });
    const replays = await openTool(control, "Replays");
    await replays.getByRole("button", { name: /^Replay \d+' Goal$/ }).first().click({ timeout: 30_000 });
    await expect(program.getByTestId("program-replay")).toBeVisible();
    await expect(program.getByTestId("program-replay")).toContainText("Replay");
    await expect(program.getByTestId("program-replay")).toHaveCount(0, { timeout: 15_000 });

    // Break: the program cuts away, counts down, and returns when the break is ended.
    const timer = await openTool(control, "Timer");
    await timer.getByLabel("Break length (minutes)").fill("2");
    await timer.getByRole("button", { name: "Take a break" }).click();
    await expect(program.getByTestId("program-countdown")).toContainText(/1:5\d/);
    await expect(program.getByTestId("element-scoreboard")).toHaveCount(0);
    await timer.getByRole("button", { name: "End break" }).click();
    await expect(program.getByTestId("element-scoreboard")).toBeVisible();
    await expect(control.getByText("On air: E2E scene")).toBeVisible();
  } finally {
    await request.delete(`${API}/api/studio/countdown`);
    await request.delete(`${API}/api/studio/replay`);
    await request.delete(`${API}/api/studio/banner`);
    await request.post(`${API}/api/studio/scenes/${before.active_scene_id}/activate`);
    await request.delete(`${API}/api/studio/scenes/${sceneId}`);
    await context.close();
  }
});
