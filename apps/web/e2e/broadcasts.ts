import { type APIRequestContext, expect, type Locator, type Page } from "@playwright/test";

// The test pipeline; see playwright.config.ts.
const API = "http://127.0.0.1:8010/api";

/**
 * Opens the studio the way a streamer reaches it: on a broadcast. A new broadcast becomes the current one,
 * and the plain `/studio` address takes the page to that broadcast's studio.
 */
export async function openStudio(page: Page, request: APIRequestContext, title: string): Promise<string> {
  const doc = await (await request.post(`${API}/broadcasts`, { data: { title, description: "", record: false } })).json();
  const id: string = doc.current_id;
  await page.goto("/studio");
  await expect(page).toHaveURL(new RegExp(`/broadcasts/${id}/studio$`));
  await expect(page.getByRole("region", { name: "Studio broadcast" }).getByRole("link", { name: title, exact: true })).toHaveAttribute("href", `/broadcasts/${id}`, { timeout: 15_000 });
  return id;
}

/** Opens a broadcast's studio with a query such as `?speed=600`, which the plain `/studio` redirect drops. */
export async function openStudioAt(page: Page, request: APIRequestContext, title: string, search: string): Promise<string> {
  const id = await openStudio(page, request, title);
  await page.goto(`/broadcasts/${id}/studio${search}`);
  await expect(page.getByRole("region", { name: "Studio broadcast" }).getByRole("link", { name: title, exact: true })).toBeVisible({ timeout: 15_000 });
  return id;
}

/** Opens one of the studio's tools from the rail, leaving it open if it already is, and returns its panel. */
export async function openTool(page: Page, name: string): Promise<Locator> {
  const button = page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name, exact: true });
  if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
  const panel = page.getByRole("region", { name: `${name} tool` });
  await expect(panel).toBeVisible();
  return panel;
}

/** Opens a scene in Edit layout from its menu in the scene strip, and returns the edit layout. */
export async function editScene(page: Page, name: string): Promise<Locator> {
  await page.getByRole("region", { name: "Scenes" }).getByRole("button", { name: `Scene menu for ${name}` }).click();
  await page.getByRole("menuitem", { name: `Edit ${name}` }).click();
  const layout = page.getByRole("region", { name: "Edit layout" });
  await expect(layout.getByText(`Editing: ${name}`)).toBeVisible();
  return layout;
}
