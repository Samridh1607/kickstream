import type { MatchStatus, SceneElement } from "../contracts";

export const isKeyEvents = (status: MatchStatus | null | undefined) => status?.detail === "key_events";

const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);

/** Elements that draw positions, pressure or momentum, which a live feed does not give. */
export function needsPositions(element: Pick<SceneElement, "type" | "props">): boolean {
  switch (element.type) {
    case "pitch":
    case "pitch3d":
    case "replay":
      return true;
    case "graph":
      return ["momentum", "xg"].includes(text(element.props.metric, "momentum"));
    case "prediction":
      return text(element.props.view, "outcome") === "next_action";
    case "chart":
      return text(element.props.metric, "overview") === "tactics";
    default:
      return false;
  }
}

export function limitedByLiveData(element: Pick<SceneElement, "type" | "props">, status: MatchStatus | null | undefined): boolean {
  return isKeyEvents(status) && needsPositions(element);
}
