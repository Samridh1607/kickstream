import { expect, test } from "@playwright/test";

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
    await control.goto("/studio");
    await program.goto("/program");

    // Scenes: going live cuts the program.
    await control.getByRole("button", { name: "Switch to E2E scene" }).click();
    await expect(control.getByText("On air: E2E scene")).toBeVisible();
    await expect(program.getByTestId("element-scoreboard")).toBeVisible();
    await expect(program.getByRole("button")).toHaveCount(0);

    // Canvas: dragging an element moves it on the program when the drag ends.
    await control.getByRole("button", { name: "Edit E2E scene" }).click();
    const leftBefore = await program.getByTestId("element-scoreboard").evaluate((node) => (node as HTMLElement).style.left);
    const handle = control.getByRole("region", { name: "Editor" }).getByRole("button", { name: "scoreboard element" });
    // The page bar stays at the top, so the handle must be in view and not beneath it.
    await handle.scrollIntoViewIfNeeded();
    const box = (await handle.boundingBox())!;
    await control.mouse.move(box.x + 30, box.y + 20);
    await control.mouse.down();
    await control.mouse.move(box.x + 120, box.y + 20, { steps: 5 });
    await control.mouse.up();
    await expect
      .poll(() => program.getByTestId("element-scoreboard").evaluate((node) => (node as HTMLElement).style.left))
      .not.toBe(leftBefore);

    // Banner: a custom banner reaches the program.
    await control.getByRole("tab", { name: "Banner" }).click();
    await control.getByLabel("Banner text").fill("Welcome to matchday");
    await control.getByRole("button", { name: "Show banner" }).click();
    await expect(program.getByTestId("program-banner")).toHaveText("Welcome to matchday");

    // Match: the program follows it, and a goal can be replayed.
    await request.post(`${API}/api/matches`, { data: { speed: 600 } });
    await expect(program.getByTestId("program-score")).not.toHaveText("–", { timeout: 30_000 });
    await control.getByRole("tab", { name: "Highlights" }).click();
    await control.getByRole("button", { name: /^Replay \d+' Goal$/ }).first().click({ timeout: 30_000 });
    await expect(program.getByTestId("program-replay")).toBeVisible();
    await expect(program.getByTestId("program-replay")).toContainText("Replay");
    await expect(program.getByTestId("program-replay")).toHaveCount(0, { timeout: 15_000 });

    // Break: the program cuts away, counts down, and returns when the break is ended.
    await control.getByRole("tab", { name: "Countdown" }).click();
    await control.getByLabel("Break length (minutes)").fill("2");
    await control.getByRole("button", { name: "Take a break" }).click();
    await expect(program.getByTestId("program-countdown")).toContainText(/1:5\d/);
    await expect(program.getByTestId("element-scoreboard")).toHaveCount(0);
    await control.getByRole("button", { name: "End break" }).click();
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
