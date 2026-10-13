import { expect, test } from "@playwright/test";

test("the home page leads with creating a broadcast, lists the saved ones, and opens the studio", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");

  // Exact: the list of broadcasts is a region too.
  const broadcast = page.getByRole("region", { name: "Broadcast", exact: true });
  await expect(broadcast.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(broadcast.getByRole("button", { name: /Create a broadcast|New broadcast/ })).toBeVisible();
  await expect(broadcast.getByRole("link", { name: "Open studio" })).toHaveAttribute("href", "/studio");
  await expect(page.getByRole("region", { name: "Broadcasts" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Scenes" })).toHaveCount(0);
  await expect(page.locator('a[href="/program"]')).toHaveCount(0);

  await nav.getByRole("link", { name: "Studio" }).click();
  await expect(page).toHaveURL(/\/studio$/);
  await expect(page.getByRole("region", { name: "Output" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Program preview" }).getByTestId("scene-canvas")).toBeVisible();
  await expect(page.locator('a[href="/program"]')).toHaveCount(0);
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
