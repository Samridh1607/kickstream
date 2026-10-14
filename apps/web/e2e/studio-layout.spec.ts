import { expect, type Locator, type Page, test } from "@playwright/test";
import { openStudio } from "./broadcasts";

const bottom = async (locator: Locator) => {
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  return box!.y + box!.height;
};
const pageScrolls = (page: Page) => page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 1);

test("at 1536×864 the stage, backstage, scenes and tools are in the first viewport", async ({ page, request }) => {
  await page.setViewportSize({ width: 1536, height: 864 });
  await openStudio(page, request, `Layout ${Date.now()}`);
  const regions = ["Stage", "Backstage", "Scenes"].map((name) => page.getByRole("region", { name, exact: true }));
  for (const box of [...regions, page.getByRole("navigation", { name: "Tools" })]) {
    await expect(box).toBeVisible();
    expect(await bottom(box)).toBeLessThanOrEqual(864);
  }
  expect(await pageScrolls(page)).toBe(false);

  // Edit layout takes the stage's place and still leaves the scenes in view.
  await page.getByRole("region", { name: "Studio top bar" }).getByRole("button", { name: "Edit layout" }).click();
  await expect(page.getByRole("region", { name: "Edit layout" })).toBeVisible();
  const scenes = page.getByRole("region", { name: "Scenes" });
  await expect(scenes).toBeInViewport();
  expect(await bottom(scenes)).toBeLessThanOrEqual(864);
  expect(await pageScrolls(page)).toBe(false);
});

test("in a narrower window the tool rail shows only icons, and each tool keeps its name", async ({ page, request }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await openStudio(page, request, `Narrow layout ${Date.now()}`);
  const rail = page.getByRole("navigation", { name: "Tools" });
  for (const name of ["Banners", "Comments", "Guests", "Replays", "Timer", "Stream", "Settings"]) {
    const tool = rail.getByRole("button", { name, exact: true });
    await expect(tool).toBeVisible();
    await expect(tool.getByText(name, { exact: true })).toBeHidden();
  }
});
