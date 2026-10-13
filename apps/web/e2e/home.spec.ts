import { expect, test } from "@playwright/test";

test("Home leads to a broadcast, and the broadcast to its studio and scenes", async ({ page }) => {
  const title = `Hierarchy ${Date.now()}`;
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "Scenes" })).toHaveCount(0);
  await expect(page.locator('a[href="/program"]')).toHaveCount(0);

  // Home: create the broadcast. Exact: the list of broadcasts is a region too.
  const hero = page.getByRole("region", { name: "Broadcast", exact: true });
  await hero.getByRole("button", { name: /Create a broadcast|New broadcast/ }).click();
  const dialog = page.getByRole("dialog", { name: "Create a broadcast" });
  await dialog.getByRole("textbox", { name: /Title/ }).fill(title);
  await dialog.getByRole("switch", { name: "Record this broadcast" }).click();
  await dialog.getByRole("button", { name: "Create broadcast" }).click();
  await expect(hero.getByRole("heading", { level: 1 })).toHaveText(title);

  // Home → the broadcast.
  await page.getByRole("region", { name: "Broadcasts" }).getByRole("link", { name: `${title}, Ready` }).click();
  await expect(page).toHaveURL(/\/broadcasts\/[^/]+$/);
  const pageTrail = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(pageTrail.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
  await expect(pageTrail.getByText(title)).toHaveAttribute("aria-current", "page");

  // The broadcast → its studio, where the scenes are.
  await page.getByRole("link", { name: "Open studio" }).click();
  await expect(page).toHaveURL(/\/broadcasts\/[^/]+\/studio$/);
  const linked = page.getByRole("region", { name: "Studio broadcast" });
  await expect(linked.getByRole("link", { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Scenes" }).getByRole("button", { name: /^Edit / }).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Program preview" }).getByTestId("scene-canvas")).toBeVisible();
  await expect(page.getByRole("region", { name: "Output" })).toBeVisible();
  await expect(page.locator('a[href="/program"]')).toHaveCount(0);

  // And back up: the studio's trail leads to the broadcast, then Home.
  const studioTrail = linked.getByRole("navigation", { name: "Breadcrumb" });
  await expect(studioTrail.getByText("Studio")).toHaveAttribute("aria-current", "page");
  await studioTrail.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(/\/broadcasts\/[^/]+$/);
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Home" }).click();
  await expect(page).toHaveURL(/\/$/);

  // The Studio tab of the top bar opens the current broadcast's studio, never a studio of no broadcast.
  await nav.getByRole("link", { name: "Studio" }).click();
  await expect(page).toHaveURL(/\/broadcasts\/[^/]+\/studio$/);
  await expect(page.getByRole("region", { name: "Studio broadcast" }).getByRole("link", { name: title, exact: true })).toBeVisible();
});

test("the clean picture is at /studio?output, and /program is no longer a page", async ({ page }) => {
  await page.goto("/studio?output");
  await expect(page.getByTestId("program").getByTestId("scene-canvas")).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("navigation")).toHaveCount(0);

  await page.goto("/program");
  await expect(page.getByRole("region", { name: "Broadcast", exact: true })).toBeVisible();
  await expect(page.getByTestId("program")).toHaveCount(0);
});
