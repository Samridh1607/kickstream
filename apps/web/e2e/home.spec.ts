import { expect, test } from "@playwright/test";

test("the home page shows the broadcast, its scenes, and the way into the studio", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");

  const broadcast = page.getByRole("region", { name: "Broadcast" });
  await expect(broadcast.getByRole("heading", { level: 1 })).toHaveText(/Ready to go live|You're live|Going live|Ending the stream/);
  await expect(broadcast.getByRole("link", { name: "Open studio" })).toHaveAttribute("href", "/studio");

  const scenes = page.getByRole("region", { name: "Scenes" });
  await expect(scenes.getByText("Live match")).toBeVisible();
  await expect(scenes.getByText("Analyst desk")).toBeVisible();
  await expect(scenes.getByText("On air")).toHaveCount(1);

  await nav.getByRole("link", { name: "Studio" }).click();
  await expect(page).toHaveURL(/\/studio$/);
  await expect(page.getByRole("region", { name: "Output" })).toBeVisible();
});
