import type { CopilotAnswer, CopilotInfo } from "../contracts";
import type { Mode } from "../i18n";
import { send } from "../studio/api";

export const fetchCopilotInfo = () => send<CopilotInfo>("GET", "/api/copilot");

/** Asks about the match the server considers current. `web` also searches the web, which sends the question out. */
export const askCopilot = (question: string, options: { mode: Mode; web: boolean }) =>
  send<CopilotAnswer>("POST", "/api/copilot/ask", { question, mode: options.mode, web: options.web });
