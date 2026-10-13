import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// The test pipeline; see playwright.config.ts.
const OUTPUT = "http://127.0.0.1:8010/api/studio/output";

/** The streams of a file, from ffprobe; null when ffprobe is not installed. */
function probe(path: string): { codec_name: string; codec_type: string; width?: number; height?: number }[] | null {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,codec_type,width,height", "-of", "json", path], { encoding: "utf8" });
    return JSON.parse(out).streams;
  } catch (problem) {
    if ((problem as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw problem;
  }
}

/** The recording the pipeline just listed. Its name is unique, so another run's files cannot be taken for it. */
function find(file: string): string {
  const data = ".data-e2e";
  const found = readdirSync(data).map((run) => join(data, run, "recordings", file)).filter(existsSync);
  expect(found, `${file} should be in exactly one run's data directory`).toHaveLength(1);
  return found[0];
}

test("the streamer records the program to a file, changes it while live, and stops", async ({ page, request }) => {
  await page.goto("/studio");
  await page.getByRole("tab", { name: "Output" }).click();
  await page.getByLabel("Platform").selectOption("file");
  await page.getByRole("button", { name: "Add destination" }).click();
  await expect(page.getByRole("switch", { name: "Send to Record to file" })).toBeVisible();

  try {
    await page.getByRole("button", { name: "Go live", exact: true }).click();
    // On a machine with no ffmpeg or no Chromium there is nothing to test.
    const missing = page.getByText(/was not found/);
    const stream = page.getByRole("region", { name: "Stream" });
    await expect(stream.getByText("Starting").or(stream.getByText("Live")).or(missing)).toBeVisible();
    test.skip(await missing.isVisible(), "ffmpeg or a Chromium-based browser is not installed");

    await expect(stream.getByText("Live")).toBeVisible({ timeout: 40_000 });
    const destination = page.getByRole("region", { name: "Destinations" });
    await expect(destination.getByText("Live")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Add destination" })).toBeDisabled();

    // What the streamer does while live reaches the stream: cutting to a scene that has a banner, and showing one.
    await page.getByRole("button", { name: "Go live with Live match" }).click();
    await page.getByRole("tab", { name: "Banner" }).click();
    await page.getByLabel("Banner text").fill("Recorded by the output test");
    await page.getByRole("button", { name: "Show banner" }).click();
    await page.waitForTimeout(4000);

    await page.getByRole("tab", { name: "Output" }).click();
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(stream.getByText("Off air")).toBeVisible({ timeout: 15_000 });

    const recordings = page.getByRole("region", { name: "Recordings" });
    await expect(recordings.getByText(/\.mp4$/)).toBeVisible();
    const doc = await (await request.get(OUTPUT)).json();
    expect(doc.state).toBe("idle");
    expect(doc.problem).toBeNull();
    expect(doc.recordings[0].size_bytes).toBeGreaterThan(20_000);

    // What the file holds, not only how big it is: the chosen size, with picture and sound.
    const streams = probe(find(doc.recordings[0].file));
    test.info().annotations.push({ type: "ffprobe", description: streams ? "recording inspected" : "not installed: the recording's streams were not checked" });
    if (streams) {
      expect(streams.find((one) => one.codec_type === "video")).toMatchObject({ codec_name: "h264", width: 1280, height: 720 });
      expect(streams.find((one) => one.codec_type === "audio")).toMatchObject({ codec_name: "aac" });
    }
  } finally {
    await request.post(`${OUTPUT}/stop`);
    const doc = await (await request.get(OUTPUT)).json();
    for (const item of doc.destinations) await request.delete(`${OUTPUT}/destinations/${item.id}`);
  }
});
