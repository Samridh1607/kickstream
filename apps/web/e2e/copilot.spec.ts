import { expect, test } from "@playwright/test";

test("Ask Copilot answers about the match, a player, the head to head and the play history", async ({ page }) => {
  await page.goto("/match?speed=600");
  await page.getByRole("button", { name: /^(Start|Restart) match$/ }).click();
  // Let the match run to the end, so every answer has something to stand on.
  await page.getByRole("navigation", { name: "Match intelligence" }).getByRole("button", { name: "Match", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Full-time", { timeout: 90_000 });
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Ask Copilot" }).click();
  const pane = page.getByRole("complementary", { name: "Ask Copilot" });
  await expect(pane.getByText("What would you like to know?")).toBeVisible();
  await expect(pane.getByRole("switch", { name: "Search the web" })).not.toBeChecked();

  // A starter question: the score, with the two sides compared.
  await pane.getByRole("button", { name: "What is the score?" }).click();
  await expect(pane.getByTestId("copilot-answer").last()).toContainText("It is Northbridge FC");
  await expect(pane.getByTestId("copilot-chart").last()).toContainText("Possession %");
  await expect(pane.getByText("From the match data").last()).toBeVisible();

  const ask = async (question: string) => {
    await pane.getByLabel("Ask a question").fill(question);
    await pane.getByLabel("Ask a question").press("Enter");
    await expect(pane.getByTestId("copilot-question").last()).toHaveText(question);
    await expect(pane.getByTestId("copilot-answer")).toHaveCount(await pane.getByTestId("copilot-question").count());
  };

  // A player's record, by the best rated so far.
  await ask("Who is the best player so far?");
  await expect(pane.getByTestId("copilot-answer").last()).toContainText("The best player so far is");
  await expect(pane.getByTestId("copilot-card").last()).toHaveAttribute("data-kind", "player");

  // The head to head, which counts this finished match.
  await ask("Show me the head to head");
  await expect(pane.getByTestId("copilot-answer").last()).toContainText(/In \d+ match(es)? on record/);
  await expect(pane.getByTestId("copilot-card").last()).toContainText("Wins on record");

  // A play card, and the play history, from a follow-up it suggests.
  await ask("Show the last goal's play card");
  await expect(pane.getByTestId("copilot-card").last()).toHaveAttribute("data-kind", "play");
  await pane.getByRole("button", { name: "Show the play history" }).last().click();
  await expect(pane.getByTestId("copilot-card").last()).toContainText("The match so far");

  // Something the match cannot answer, with web search off: it says what it can do.
  await ask("What is the offside rule?");
  await expect(pane.getByTestId("copilot-answer").last()).toContainText("Turn on web search");

  // A question put to one agent: typing @ offers the agents, and the one picked answers with a chart.
  await pane.getByLabel("Ask a question").fill("@tac");
  await pane.getByRole("listbox", { name: "Agents" }).getByRole("option", { name: /Tactical Analyst/ }).click();
  await expect(pane.getByRole("button", { name: "Remove Tactical Analyst" })).toBeVisible();
  await ask("Who has been pressing?");
  await expect(pane.getByTestId("copilot-asked-agent").last()).toHaveText("Asked @Tactical Analyst");
  await expect(pane.getByText("Answered by Tactical Analyst").last()).toBeVisible();
  await expect(pane.getByTestId("copilot-chart").last()).toContainText("Pressure");

  // The visualization agent, tagged with the button, says where the play has been.
  await pane.getByRole("button", { name: "Tag an agent" }).click();
  await pane.getByRole("listbox", { name: "Agents" }).getByRole("option", { name: /Visualization Agent/ }).click();
  await ask("Where is the play?");
  await expect(pane.getByTestId("copilot-chart").last()).toContainText("Share of plays by third");

  // The conversation is kept while the pane is closed.
  await pane.getByRole("button", { name: "Close" }).click();
  await expect(pane).toHaveCount(0);
  await page.getByRole("button", { name: "Ask Copilot" }).click();
  await expect(pane.getByTestId("copilot-question")).toHaveCount(8);
});
