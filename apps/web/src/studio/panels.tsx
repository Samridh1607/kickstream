import { Badge } from "@fluentui/react-components";
import {
  BrainCircuitRegular, ClockRegular, DataTrendingRegular, HourglassRegular, PeopleCommunityRegular, PeopleRegular, SlideLayoutRegular,
  SportSoccerRegular, TrophyRegular, VideoPersonRegular,
} from "@fluentui/react-icons";
import type { ReactElement } from "react";
import type { Scene, Studio } from "../contracts";
import { sceneMode } from "./mode";

const TEMPLATE_ICONS: Record<string, ReactElement> = {
  "Starting soon": <ClockRegular />, "Live match": <SportSoccerRegular />, "Analyst desk": <DataTrendingRegular />,
  Break: <HourglassRegular />, "Full-time": <TrophyRegular />, Interview: <VideoPersonRegular />,
  "Match intelligence": <BrainCircuitRegular />, "Fan zone": <PeopleCommunityRegular />,
};

export const sceneIcon = (scene: Scene) => TEMPLATE_ICONS[scene.template ?? ""] ?? <SlideLayoutRegular />;

/** Whose commentary a scene carries: Fan or Analyst, marked when it only follows the studio's default. */
export function ModeBadge({ scene, studio }: { scene: Scene; studio: Studio }) {
  const mode = sceneMode(scene, studio);
  const label = mode === "fan" ? "Fan" : "Analyst";
  return (
    <Badge size="small" appearance={scene.mode ? "tint" : "outline"} color={mode === "fan" ? "brand" : "important"}
      icon={mode === "fan" ? <PeopleRegular /> : <DataTrendingRegular />}>
      {scene.mode ? label : `${label} (default)`}
    </Badge>
  );
}
