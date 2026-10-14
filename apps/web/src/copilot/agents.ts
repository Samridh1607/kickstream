import type { AgentId } from "../agents/api";

/** An agent a question can be put to, as the mention picker lists it. */
export interface AgentOption {
  id: AgentId;
  name: string;
  description: string;
}

/** The agents as the pipeline registers them, used until GET /api/agents answers, or when it cannot. */
export const AGENT_OPTIONS: AgentOption[] = [
  { id: "event_interpreter", name: "Event Interpreter", description: "Converts video detections into structured events." },
  { id: "tactical_analyst", name: "Tactical Analyst", description: "Detects pressure, rhythm, and tactical patterns." },
  { id: "prediction", name: "Prediction Agent", description: "Forecasts likely next moves or danger areas." },
  { id: "player_tracking", name: "Player Tracking Agent", description: "Follows favorite player and computes personal metrics." },
  { id: "visualization", name: "Visualization Agent", description: "Generates 3D pitch and overlay data." },
  { id: "highlights", name: "Highlights Agent", description: "Selects key moments and hidden events." },
  { id: "explainability", name: "Explainability Agent", description: 'Writes clear "why this matters" explanations.' },
];

// The short names the pipeline also accepts after an @, so filtering finds what a tag would reach.
const SHORT: Record<AgentId, string[]> = {
  event_interpreter: ["events", "plays"],
  tactical_analyst: ["tactics"],
  prediction: ["forecast", "odds"],
  explainability: ["explain", "why"],
  visualization: ["visual", "pitch"],
  player_tracking: ["player"],
  highlights: ["moments"],
};

const key = (text: string) => text.toLowerCase().replace(/[\s_-]+/g, "");

/** The agents with a word of their id, name or short names, or the whole of one, starting with what was typed after the @. */
export function matchAgents(agents: readonly AgentOption[], query: string): AgentOption[] {
  const wanted = key(query);
  return agents.filter((agent) =>
    [agent.id, agent.name, ...(SHORT[agent.id] ?? [])].some((name) => [name, ...name.split(/[\s_-]+/)].some((word) => key(word).startsWith(wanted))),
  );
}

export const agentName = (agents: readonly AgentOption[], id: AgentId) => agents.find((agent) => agent.id === id)?.name ?? id;
