import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openStudio } from "../e2e/broadcasts";

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

test("a guest's camera reaches the program and their voice reaches the recording", async ({ page, browser, request }) => {
  test.skip(!test.info().config.metadata.acs, "put KICKSTREAM_ACS_CONNECTION_STRING in the .env file to run against Azure");
  await openStudio(page, request, `ACS test ${Date.now()}`);
  const people = page.getByRole("region", { name: "People" });
  await people.getByLabel("Name (optional)").fill("Riley");
  await people.getByRole("button", { name: "Invite", exact: true }).click();
  const path = new URL(await people.getByLabel("Invite link for Riley").inputValue()).pathname;

  const guestContext = await browser.newContext({ permissions: ["camera", "microphone"] });
  try {
    const guest = await guestContext.newPage();
    await guest.goto(path);
    await guest.getByRole("button", { name: "Join" }).click();
    await expect(guest.getByText("You're backstage")).toBeVisible({ timeout: 60_000 });
    await expect(people.getByText("Present")).toBeVisible();
    await people.getByRole("button", { name: "Add Riley to stage" }).click();
    await expect(guest.getByText("You're on stage")).toBeVisible();

    const program = await page.context().newPage();
    await program.goto("/studio?output");
    await expect(program.getByTestId("camera-tile").locator("video")).toBeVisible({ timeout: 60_000 });
    await program.close();

    await page.getByLabel("Platform").selectOption("file");
    await page.getByRole("button", { name: "Add destination" }).click();
    await page.getByRole("button", { name: "Go live", exact: true }).click();
    const stream = page.getByRole("region", { name: "Stream", exact: true });
    await expect(stream.getByText("Live", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(guest.getByText("You're on stage — you're live")).toBeVisible();
    await page.waitForTimeout(10_000);
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(stream.getByText("Off air")).toBeVisible({ timeout: 15_000 });

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
