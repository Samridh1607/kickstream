import type { AgentId } from "../agents/api";
import type { CopilotAnswer, CopilotInfo } from "../contracts";
import { send } from "../studio/api";

export const fetchCopilotInfo = () => send<CopilotInfo>("GET", "/api/copilot");

/**
 * Asks about the match the server considers current, in the analyst's words. `agent` puts the question to
 * one agent; `web` also searches the web, which sends the question out.
 */
export async function askCopilot(question: string, options: { web: boolean; agent: AgentId | null }): Promise<CopilotAnswer> {
  const answer = await send<CopilotAnswer>("POST", "/api/copilot/ask", { question, mode: "analyst", web: options.web, agent: options.agent });
  if (typeof answer?.answer !== "string" || !Array.isArray(answer.cards)) throw new Error("The reply was not a Copilot answer.");
  return answer;
}
