import { expect, type Page, test } from "@playwright/test";

// The test pipeline; see playwright.config.ts.
const AUTOLIVE = "http://127.0.0.1:8010/api/autolive";

/** Counts the page's screen wake lock requests and how each one went, around the browser's own API. */
async function watchWakeLock(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __wake: string[] }).__wake = seen;
    const lock = (navigator as Navigator & { wakeLock?: { request(type: string): Promise<unknown> } }).wakeLock;
    if (!lock) return;
    const request = lock.request.bind(lock);
    lock.request = (type: string) => {
      seen.push(`asked:${type}`);
      return request(type).then(
        (sentinel) => { seen.push("held"); return sentinel; },
        (problem: Error) => { seen.push(`refused:${problem.name}`); throw problem; },
      );
    };
  });
}

test("auto live rotates its screens with an animation and commentary, on the minutes set on its page", async ({ page, browser, request }) => {
  const before = (await (await request.get(AUTOLIVE)).json()).settings;
  // Off, on the defaults, with no match or stream of its own: the page turns it on.
  await request.put(`${AUTOLIVE}/settings`, {
    data: { ...before, enabled: false, rotate: true, min_minutes: 5, max_minutes: 10, commentary: true, narration: false, keep_match: false, stream: false },
  });
  try {
    await watchWakeLock(page);
    await page.goto("/live");
    const stage = page.getByTestId("autolive-stage");
    await expect(stage).toBeVisible();

    const screens = page.getByRole("region", { name: "Screens" }).getByRole("checkbox");
    const count = await screens.count();
    expect(count).toBeGreaterThanOrEqual(15);
    expect(count).toBeLessThanOrEqual(25);
    // One for each of the seven agents, and one of all seven at work.
    expect(await page.getByRole("region", { name: "Screens" }).getByText("agent", { exact: true }).count()).toBeGreaterThanOrEqual(7);

    // Turned on, every 30 seconds: shortest first, since the longest may not go below it.
    await page.getByRole("switch", { name: "Auto live" }).click();
    await expect(page.getByText("Auto live on")).toBeVisible();
    const shortest = page.getByLabel("Shortest time on a screen (minutes)");
    await shortest.fill("0.5");
    await shortest.press("Enter");
    await expect.poll(async () => (await (await request.get(AUTOLIVE)).json()).settings.min_minutes).toBe(0.5);
    const longest = page.getByLabel("Longest time on a screen (minutes)");
    await longest.fill("0.5");
    await longest.press("Enter");
    await expect.poll(async () => (await (await request.get(AUTOLIVE)).json()).settings.max_minutes).toBe(0.5);
    await expect(page.getByTestId("autolive-progress")).toBeVisible();

    // The screen changes by itself, and the new one comes in with its transition's animation.
    const first = await stage.getAttribute("data-scene");
    await expect(stage).not.toHaveAttribute("data-scene", first ?? "", { timeout: 60_000 });
    const transition = await stage.getAttribute("data-transition");
    const entering = await page.getByTestId("autolive-screen").evaluate((node) => getComputedStyle(node).animationName);
    expect(entering).toBe(`al-${transition}-in`);
    // A new screen is introduced; with the sound off here, the line is shown as a caption.
    await expect(page.getByTestId("autolive-caption")).toBeVisible({ timeout: 20_000 });

    // An agent's screen, shown by hand.
    await page.getByRole("button", { name: "Show Tactical Analyst now" }).click();
    await expect(page.getByTestId("autolive-title")).toHaveText("Tactical Analyst");
    await expect(page.getByTestId("autolive-header")).toContainText("AI agent");
    await page.getByRole("button", { name: "Say something now" }).click();
    await expect(page.getByTestId("autolive-caption")).toBeVisible({ timeout: 20_000 });

    // The page asked the real browser to keep the screen awake.
    const wake = await page.evaluate(() => (window as unknown as { __wake: string[] }).__wake);
    test.info().annotations.push({ type: "wake lock", description: wake.join(", ") || "not offered by this browser" });
    if (await page.evaluate(() => "wakeLock" in navigator)) expect(wake).toContain("asked:screen");

    // The clean feed the stream captures: the same picture, no controls.
    const feed = await browser.newPage({ baseURL: test.info().project.use.baseURL });
    await feed.goto("/live?output");
    await expect(feed.getByTestId("autolive-output")).toBeVisible();
    await expect(feed.getByTestId("autolive-title")).toHaveText("Tactical Analyst");
    await expect(feed.getByRole("switch")).toHaveCount(0);
    await feed.close();

    // Off: the rotation stops.
    await page.getByRole("switch", { name: "Auto live" }).click();
    await expect(page.getByText("Auto live off")).toBeVisible();
    await expect(page.getByTestId("autolive-progress")).toHaveCount(0);
  } finally {
    await request.put(`${AUTOLIVE}/settings`, { data: before });
  }
});
