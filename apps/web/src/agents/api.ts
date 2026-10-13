import type { AgentCatalog, AgentRun, AgentSpec } from "../contracts";
import { send } from "../studio/api";
import type { MatchData } from "../stream/store";

export type AgentId = AgentSpec["id"];
export type AgentState = "off" | "working" | "idle";

export const fetchAgents = () => send<AgentCatalog>("GET", "/api/agents");
export const setAgentEnabled = (agentId: AgentId, enabled: boolean) =>
  send<AgentCatalog>("PUT", `/api/agents/${encodeURIComponent(agentId)}`, { enabled });

/** The agents that listen to this one. */
export function downstream(catalog: AgentCatalog, agentId: AgentId): AgentSpec[] {
  return catalog.agents.filter((agent) => agent.upstream.includes(agentId));
}

export const runsOf = (runs: readonly AgentRun[], agentId: AgentId) => runs.filter((run) => run.agent === agentId);

/** Working when it has reported within the last match minute of a match still being played. */
export function agentState(agent: AgentSpec, match: MatchData): AgentState {
  if (!agent.enabled) return "off";
  const playing = match.status?.state === "live";
  const latest = match.runs.find((run) => run.agent === agent.id);
  return playing && latest !== undefined && latest.minute >= match.minute - 1 ? "working" : "idle";
}
