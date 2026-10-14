import { expect, test } from "@playwright/test";
import { DATA_DIR } from "../playwright.config";
import { openStudio } from "./broadcasts";

// The test pipeline and dev server; see playwright.config.ts.
const API = "http://127.0.0.1:8010/api";
const WEB = "http://127.0.0.1:5183";
const PUBLIC_HOST = "guests.example";

test("the streamer invites guests by link, puts a speaker on stage, and revokes the invite", async ({ page, browser, request }) => {
  await openStudio(page, request, `Guests test ${Date.now()}`);
  const backstage = page.getByRole("region", { name: "Backstage" });
  // Backstage's invite tile opens the Guests tool, where the invites are made.
  await backstage.getByRole("button", { name: "Invite a guest" }).click();
  const guests = page.getByRole("region", { name: "Guests tool" });
  await guests.getByLabel("Name (optional)").fill("Sam");
  await guests.getByRole("button", { name: "Invite", exact: true }).click();
  const link = guests.getByLabel("Invite link for Sam");
  await expect(link).toHaveValue(new RegExp(`^https://${PUBLIC_HOST}/guest/`), { timeout: 15_000 });
  // The link names the public address; the test opens the same path on the local one.
  const path = new URL(await link.inputValue()).pathname;
  await guests.getByLabel("Role").selectOption("member");
  await guests.getByLabel("Name (optional)").fill("Mia");
  await guests.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(guests.getByLabel("Invite link for Mia")).toBeVisible({ timeout: 15_000 });
  await expect(backstage.getByText("Mia", { exact: true })).toBeVisible();
  await expect(backstage.getByRole("button", { name: "Add Mia to stage" })).toHaveCount(0);

  const guestContext = await browser.newContext({ permissions: ["camera", "microphone"] });
  try {
    const guest = await guestContext.newPage();
    await guest.goto(path);
    await expect(guest.getByText(/Join “Guests test \d+” as Speaker/)).toBeVisible();
    await expect(guest.getByLabel("Your name")).toHaveValue("Sam");
    await guest.getByRole("button", { name: "Join" }).click();
    await expect(guest.getByText("You're backstage")).toBeVisible();
    await expect(backstage.getByText("Present")).toBeVisible();

    await backstage.getByRole("button", { name: "Add Sam to stage" }).click();
    await expect(guest.getByText("You're on stage")).toBeVisible();
    await expect(guests.getByText("On stage")).toBeVisible();
    // The program shows who is on stage: a picture-in-picture box, since the scene has no cameras.
    await expect(page.getByRole("region", { name: "Stage", exact: true }).getByTestId("camera-tile")).toHaveCount(1);

    await guests.getByRole("button", { name: "Revoke invite for Sam" }).click();
    await expect(guest.getByText("This invite is no longer valid")).toBeVisible();
  } finally {
    await guestContext.close();
  }
});

test("through the tunnel only a guest's routes answer", async ({ request }) => {
  const made = await (await request.post(`${API}/broadcasts`, { data: { title: `Gate test ${Date.now()}`, description: "", record: false } })).json();
  const doc = await (await request.post(`${API}/broadcasts/${made.current_id}/people/invites`, { data: { role: "speaker" } })).json();
  const secret = doc.invites[0].link.split("/").pop();
  const tunnel = { "x-forwarded-host": PUBLIC_HOST, "x-forwarded-for": "203.0.113.9" };
  expect((await request.get(`${WEB}/api/broadcasts`, { headers: tunnel })).status()).toBe(404);
  expect((await request.get(`${WEB}/api/studio`, { headers: tunnel })).status()).toBe(404);
  expect((await request.get(`${WEB}/api/guest/${secret}`, { headers: tunnel })).status()).toBe(200);
  expect((await request.get(`${WEB}/api/broadcasts`)).status()).toBe(200);
  const people = `${WEB}/@fs/${DATA_DIR.replaceAll("\\", "/")}/people.json`.replace("/@fs//", "/@fs/");
  expect(await (await request.get(people, { headers: tunnel })).text()).not.toContain('"secret"');
});
