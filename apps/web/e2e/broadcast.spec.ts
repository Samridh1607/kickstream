import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { type APIRequestContext, expect, test } from "@playwright/test";

// The test pipeline; see playwright.config.ts.
const API = "http://127.0.0.1:8010/api";

/** The video stream of a file, from ffprobe; null when ffprobe is not installed. */
function video(path: string): { codec_name: string; width: number; height: number } | null {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=codec_name,width,height", "-of", "json", path], { encoding: "utf8" });
    return JSON.parse(out).streams[0];
  } catch (problem) {
    if ((problem as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw problem;
  }
}

/** Nothing on air and no destinations, whatever an earlier test left behind. */
async function offAir(request: APIRequestContext) {
  const { broadcasts } = await (await request.get(`${API}/broadcasts`)).json();
  for (const item of broadcasts) if (item.state === "live") await request.post(`${API}/broadcasts/${item.id}/end`);
  await request.post(`${API}/studio/output/stop`);
  const doc = await (await request.get(`${API}/studio/output`)).json();
  for (const item of doc.destinations) await request.delete(`${API}/studio/output/destinations/${item.id}`);
}

test("a broadcast is created on Home, goes live with a recording, is saved with its stats, and becomes a reel", async ({ page, request }) => {
  // Starting the hidden browser and ffmpeg, recording, and cutting the reel all take real time.
  test.setTimeout(240_000);
  await offAir(request);
  const title = `Cup final ${Date.now()}`;
  await page.goto("/");
  // Exact: the list of broadcasts is a region too.
  const hero = page.getByRole("region", { name: "Broadcast", exact: true });
  await hero.getByRole("button", { name: /Create a broadcast|New broadcast/ }).click();
  const dialog = page.getByRole("dialog", { name: "Create a broadcast" });
  await dialog.getByRole("textbox", { name: /Title/ }).fill(title);
  await dialog.getByRole("textbox", { name: /Description/ }).fill("Recorded by the broadcast test");
  await expect(dialog.getByRole("switch", { name: "Record this broadcast" })).toBeChecked();
  await dialog.getByRole("button", { name: "Create broadcast" }).click();
  await expect(hero.getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(hero.getByText("Recording on")).toBeVisible();

  try {
    // Recording is the only destination: the broadcast turns it on by itself.
    await hero.getByRole("button", { name: "Go live" }).click();
    const missing = page.getByText(/was not found/);
    const liveNow = hero.getByText(/Live now/);
    await expect(hero.getByText("Going live…").or(liveNow).or(missing)).toBeVisible({ timeout: 20_000 });
    test.skip(await missing.isVisible(), "ffmpeg or a Chromium-based browser is not installed");
    await expect(liveNow).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("region", { name: "Stream status" }).getByText("Recording")).toBeVisible();
    await page.waitForTimeout(6000);

    await hero.getByRole("button", { name: "End broadcast" }).click();
    await expect(hero.getByRole("heading", { level: 1 })).toHaveText("Create a broadcast", { timeout: 20_000 });

    // Saved: it is listed on Home with what it kept, and its page has the recording and the stats.
    const saved = page.getByRole("region", { name: "Broadcasts" }).getByRole("link", { name: `${title}, Ended` });
    await expect(saved.getByText("1 recording")).toBeVisible();
    await saved.click();
    await expect(page).toHaveURL(/\/broadcasts\/[^/]+$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(page.getByRole("group", { name: "Time on air" }).getByText(/^\d+ s$/)).toBeVisible();
    await expect(page.getByRole("group", { name: "Destinations reached" }).getByText("1 of 1")).toBeVisible();
    const sessions = page.getByRole("region", { name: "Sessions" });
    await expect(sessions.getByText("Session 1", { exact: false })).toBeVisible();
    await expect(sessions.getByText("Reached")).toBeVisible();

    const recording = page.getByRole("region", { name: "Recording", exact: true });
    const player = recording.getByLabel("Recording player");
    await expect(player).toBeVisible();
    const recordingUrl = await player.getAttribute("src");
    expect(recordingUrl).toMatch(/^\/api\/broadcasts\/[^/]+\/recordings\/.+\.mp4$/);
    const file = await request.get(recordingUrl!, { headers: { Range: "bytes=0-1023" } });
    expect(file.status()).toBe(206);
    expect(file.headers()["content-type"]).toBe("video/mp4");

    // Reels: with no model set, the template writes the post; ffmpeg cuts the vertical clip.
    const reels = page.getByRole("region", { name: "Reels" });
    await reels.getByRole("button", { name: /^Generate reels/ }).click();
    const reel = reels.getByRole("article", { name: /^Reel: / }).first();
    await expect(reel.locator("video")).toBeVisible({ timeout: 90_000 });
    await expect(reel.getByText("Template")).toBeVisible();
    const reelUrl = await reel.getByRole("link", { name: /Download/ }).getAttribute("href");
    const clip = await request.get(reelUrl!);
    expect(clip.status()).toBe(200);
    const body = await clip.body();
    expect(body.length).toBeGreaterThan(10_000);
    const saveAs = test.info().outputPath("reel.mp4");
    writeFileSync(saveAs, body);
    const stream = video(saveAs);
    test.info().annotations.push({ type: "ffprobe", description: stream ? "reel inspected" : "not installed: the reel was not checked" });
    if (stream) expect(stream).toMatchObject({ codec_name: "h264", width: 1080, height: 1920 });
  } finally {
    await offAir(request);
  }
});
