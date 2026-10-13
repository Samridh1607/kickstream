import { type APIRequestContext, expect, type Page } from "@playwright/test";

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
