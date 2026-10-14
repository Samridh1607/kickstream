import { expect, test } from "@playwright/test";

// The test pipeline; see playwright.config.ts. Here its match sources are the real services.
const API = "http://127.0.0.1:8010/api";
const SLOW = { timeout: 180_000 };

const pad = (value: number) => String(value).padStart(2, "0");
const at = new Date();
const today = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

test("a StatsBomb replay is downloaded and plays to full time", async ({ page, request }) => {
  const competitions = await (await request.get(`${API}/sources/statsbomb/competitions`, SLOW)).json();
  expect(competitions).toContainEqual(expect.objectContaining({ competition_id: 43, season_id: 3, competition_name: "FIFA World Cup", season_name: "2018" }));
  const started = await request.post(`${API}/matches`, { data: { source: "statsbomb", ref: "43/3/8658", speed: 600 }, ...SLOW });
  expect(started.status()).toBe(201);

  await page.goto("/match");
  await expect(page.getByRole("dialog")).toContainText("Full-time", { timeout: 120_000 });
  await expect(page.getByTestId("score")).toHaveText("4 - 2");
  await expect(page.getByTestId("match-source")).toContainText("Data: StatsBomb");
});

test("OpenLigaDB lists today's fixtures", async ({ request }) => {
  const response = await request.get(`${API}/sources/openligadb/fixtures?date=${today}`, SLOW);
  expect(response.status()).toBe(200);
  expect(Array.isArray(await response.json())).toBe(true);
});

test("API-Football lists today's fixtures, or says in its own words why the plan does not", async ({ request }) => {
  test.skip(!test.info().config.metadata.apiFootball, "No KICKSTREAM_API_FOOTBALL_KEY in the environment or the .env file.");
  const response = await request.get(`${API}/sources/api_football/fixtures?date=${today}`, SLOW);
  if (response.status() === 502) {
    const message: string = (await response.json()).detail[0].msg;
    expect(message).toMatch(/^API-Football refused the request: /);
    test.info().annotations.push({ type: "API-Football refused", description: message });
    return;
  }
  expect(response.status()).toBe(200);
  expect(Array.isArray(await response.json())).toBe(true);
});
