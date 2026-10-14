import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { openStudio, openTool } from "../e2e/broadcasts";

// The test pipeline; see playwright.config.ts.
const OUTPUT = "http://127.0.0.1:8010/api/studio/output";

/** The loudest the file's sound gets, in dB; null when ffmpeg is not installed. */
function loudest(path: string): number | null {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-i", path, "-vn", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  if ((run.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
  const found = /max_volume: (-?[\d.]+) dB/.exec(run.stderr ?? "");
  return found ? Number(found[1]) : -Infinity;
}

function find(file: string): string {
  const data = ".data-e2e";
  const found = readdirSync(data).map((run) => join(data, run, "recordings", file)).filter(existsSync);
  expect(found, `${file} should be in exactly one run's data directory`).toHaveLength(1);
  return found[0];
}

/** A camera tile whose video is playing: it has a size and its picture moves on. */
async function expectMovingVideo(tile: Locator) {
  const video = tile.locator("video");
  await expect(video).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.videoWidth), { timeout: 60_000 }).toBeGreaterThan(0);
  const before = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(before);
}

test("the host's camera and a guest speaker are on the program and the live stream carries their voices", async ({ page, browser, request }) => {
  test.skip(!test.info().config.metadata.acs, "put KICKSTREAM_ACS_CONNECTION_STRING in the .env file to run against Azure");
  await openStudio(page, request, `ACS test ${Date.now()}`);
  const backstage = page.getByRole("region", { name: "Backstage" });

  await backstage.getByRole("button", { name: "Join with camera" }).click();
  await expect(backstage.getByRole("button", { name: "Add me to stage" })).toBeEnabled({ timeout: 60_000 });
  await backstage.getByRole("button", { name: "Add me to stage" }).click();
  await expect(backstage.getByRole("button", { name: "Remove me from stage" })).toBeVisible();

  const guests = await openTool(page, "Guests");
  await guests.getByLabel("Name (optional)").fill("Riley");
  await guests.getByRole("button", { name: "Invite", exact: true }).click();
  const link = guests.getByLabel("Invite link for Riley");
  await expect(link).toBeVisible({ timeout: 15_000 });
  const path = new URL(await link.inputValue()).pathname;

  const guestContext = await browser.newContext({ permissions: ["camera", "microphone"] });
  try {
    const guest = await guestContext.newPage();
    await guest.goto(path);
    await guest.getByRole("button", { name: "Join" }).click();
    await expect(guest.getByText("You're backstage")).toBeVisible({ timeout: 60_000 });
    await backstage.getByRole("button", { name: "Add Riley to stage" }).click();
    await expect(guest.getByText("You're on stage")).toBeVisible();

    // The program is what the hidden browser records and streams: both people, named, with moving video.
    const program = await page.context().newPage();
    await program.goto("/studio?output");
    const tiles = program.getByTestId("camera-tile");
    await expect(tiles).toHaveCount(2, { timeout: 60_000 });
    await expect(tiles.filter({ hasText: "Riley" })).toHaveCount(1);
    for (const tile of await tiles.all()) await expectMovingVideo(tile);
    await program.close();

    const stream = await openTool(page, "Stream");
    await stream.getByLabel("Platform").selectOption("file");
    await stream.getByRole("button", { name: "Add destination" }).click();
    const bar = page.getByRole("region", { name: "Studio top bar" });
    await bar.getByRole("button", { name: "Go live", exact: true }).click();
    await expect(stream.getByRole("region", { name: "Stream", exact: true }).getByText("Live", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(guest.getByText("You're on stage — you're live")).toBeVisible();
    await page.waitForTimeout(10_000);
    await bar.getByRole("button", { name: "End broadcast" }).click();
    await expect((await openTool(page, "Stream")).getByRole("region", { name: "Stream", exact: true }).getByText("Off air")).toBeVisible({ timeout: 15_000 });

    const doc = await (await request.get(OUTPUT)).json();
    const level = loudest(find(doc.recordings[0].file));
    test.info().annotations.push({ type: "ffmpeg", description: level === null ? "not installed: the sound was not checked" : `loudest ${level} dB` });
    if (level !== null) expect(level).toBeGreaterThan(-50);
  } finally {
    await request.post(`${OUTPUT}/stop`);
    const doc = await (await request.get(OUTPUT)).json();
    for (const item of doc.destinations) await request.delete(`${OUTPUT}/destinations/${item.id}`);
    await guestContext.close();
  }
});
