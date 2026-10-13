import { expect, test } from "@playwright/test";

test("a seeded match plays through every stage to the full-time recap", async ({ page }) => {
  // 600x plays ninety minutes in nine seconds.
  await page.goto("/match?speed=600");
  await page.getByRole("button", { name: /^(Start|Restart) match$/ }).click();

  // Ingest -> Interpret -> Explain: a goal becomes a Fan narrative in English.
  await expect(page.getByText(/^GOAL!/).first()).toBeVisible({ timeout: 30_000 });

  // Personalize: Analyst mode replays the same moments in the analyst variant.
  await page.getByRole("tab", { name: "Analyst" }).click();
  await expect(page.getByText(/The goal reflects the balance of play/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^GOAL!/)).toHaveCount(0);

  // Personalize: switching language changes narratives and interface text.
  await page.getByLabel("Language").selectOption("es");
  await expect(page.getByText(/El gol refleja el desarrollo del juego/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Reiniciar partido" })).toBeVisible();

  // Explain: the full-time recap arrives in the viewer's language.
  await expect(page.getByRole("dialog")).toContainText("Final:", { timeout: 60_000 });
  await page.getByRole("button", { name: "Cerrar" }).click();

  // Render: the overlay tab draws the latest overlay from its JSON.
  await page.getByRole("tab", { name: "Gráficos" }).click();
  await expect(page.getByTestId("overlay-graphic")).toBeVisible();
  const overlay = JSON.parse((await page.getByTestId("overlay-json").textContent()) ?? "{}");
  expect(overlay.match_id).toMatch(/^m[0-9a-f]*-\d+$/);
  expect(["lower_third", "stat_card", "pressure_map", "recap_card"]).toContain(overlay.kind);
});
