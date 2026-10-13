import { expect, test } from "@playwright/test";

// The test pipeline; see playwright.config.ts.
const API = "http://127.0.0.1:8010";
const STUDIO = `${API}/api/studio/audience`;

test("fans vote and ask, and the streamer puts the result and an answer on the program", async ({ browser, request }) => {
  const tag = Date.now().toString(36);
  const question = `Why press so high? ${tag}`;
  const pollQuestion = `Who was best? ${tag}`;

  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const control = await context.newPage();
  const program = await context.newPage();
  // A fan is a different browser, with its own storage and so its own voter ID.
  const fanContext = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const fan = await fanContext.newPage();

  try {
    await control.goto("/studio");
    await program.goto("/studio?output");
    await fan.goto("/join");
    await control.getByRole("tab", { name: "Audience" }).click();

    // The streamer starts a poll; the fan sees it and votes.
    await control.getByLabel("Poll question").fill(pollQuestion);
    await control.getByLabel("Options, one per line").fill("Marrowby\nBellweather");
    await control.getByRole("button", { name: "Start poll" }).click();
    await expect(fan.getByText(pollQuestion)).toBeVisible();
    await expect(fan.getByText("Vote to see the results.")).toBeVisible();
    await fan.getByRole("button", { name: "Bellweather" }).click();
    await expect(fan.getByText("1 votes · 100%")).toBeVisible();
    await expect(fan.getByText("Your vote")).toBeVisible();

    // A second click on the same option, and a reload, do not add a vote.
    await fan.getByRole("button", { name: "Bellweather" }).click();
    await fan.reload();
    await expect(fan.getByText("Your vote")).toBeVisible();
    await expect(control.getByRole("region", { name: "Current poll" })).toContainText("Bellweather: 1");

    // The result is not on the program until the streamer puts it there.
    await expect(program.getByTestId("program-poll")).toHaveCount(0);
    await control.getByRole("switch", { name: "Show poll on the program" }).click();
    await expect(program.getByTestId("program-poll")).toContainText(pollQuestion);
    await expect(program.getByTestId("program-poll")).toContainText("1 · 100%");

    // The fan asks; the streamer sees it, writes the answer, and puts it on air.
    await fan.getByLabel("Your question").fill(question);
    await fan.getByLabel("Nickname (optional)").fill("E2E fan");
    await fan.getByRole("button", { name: "Send" }).click();
    await expect(fan.getByText("Yours")).toBeVisible();
    await control.getByRole("button", { name: `Ask the expert: ${question}` }).click();
    const draft = control.getByRole("region", { name: "Answer draft" });
    await expect(draft).toContainText(question);
    await expect(program.getByTestId("program-qa")).toHaveCount(0);
    await draft.getByLabel("Answer").fill("To win the ball nearer the goal.");
    await draft.getByRole("button", { name: "Put on air" }).click();

    await expect(program.getByTestId("program-qa")).toContainText("E2E fan asks");
    await expect(program.getByTestId("program-qa")).toContainText("To win the ball nearer the goal.");
    await expect(fan.getByText("To win the ball nearer the goal.")).toBeVisible();
    await expect(program.getByRole("button")).toHaveCount(0);

    await control.getByRole("button", { name: "Take off air" }).click();
    await expect(program.getByTestId("program-qa")).toHaveCount(0);
  } finally {
    await request.delete(`${STUDIO}/qa`);
    await request.delete(`${STUDIO}/draft`);
    await request.put(`${STUDIO}/poll/on-air`, { data: { on: false } });
    await request.post(`${STUDIO}/poll/close`, { data: {} });
    await context.close();
    await fanContext.close();
  }
});
