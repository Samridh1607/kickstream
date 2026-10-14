import { Badge, Button, makeStyles, mergeClasses, Select, Text, tokens, Tooltip } from "@fluentui/react-components";
import {
  AddRegular, BrainCircuitRegular, ClockRegular, CopyRegular, DataTrendingRegular, DeleteRegular, HourglassRegular, PeopleCommunityRegular,
  PeopleRegular, PlayRegular, SaveRegular, SlideLayoutRegular, SportSoccerRegular, TrophyRegular, VideoPersonRegular,
} from "@fluentui/react-icons";
import { type ReactElement, useState } from "react";
import type { MatchStatus, Scene, SceneElement, Studio } from "../contracts";
import { ElementLibrary } from "./edit/ElementLibrary";
import { Inspector } from "./edit/Inspector";
import { Layers } from "./edit/Layers";
import { sceneMode } from "./mode";

export { WIDGETS } from "./edit/ElementLibrary";
export { BannerPanel, TickerPanel } from "./tools/BannersTool";
export { HighlightsPanel } from "./tools/ReplaysTool";
export { CountdownPanel } from "./tools/TimerTool";
export { SettingsPanel } from "./tools/SettingsTool";

const BUILTIN = ["Starting soon", "Live match", "Analyst desk", "Break", "Full-time", "Interview", "Match intelligence", "Fan zone"];
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

const useStyles = makeStyles({
  panel: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  // The scenes sit in one row under the stage and scroll sideways when there are many.
  strip: {
    listStyleType: "none", margin: 0, padding: `0 0 ${tokens.spacingVerticalXS}`, display: "flex", gap: tokens.spacingHorizontalS,
    overflowX: "auto", scrollSnapType: "x proximity",
  },
  sceneItem: {
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS,
    width: "236px", flexShrink: 0, scrollSnapAlign: "start",
    borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground3,
    border: `${tokens.strokeWidthThick} solid transparent`,
    transitionProperty: "border-color, background-color, box-shadow", transitionDuration: "160ms",
    ":hover": { boxShadow: tokens.shadow4 },
  },
  sceneEditing: { border: `${tokens.strokeWidthThick} solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorNeutralBackground1 },
  sceneOnAir: { border: `${tokens.strokeWidthThick} solid #D92D20`, backgroundColor: tokens.colorNeutralBackground1 },
  add: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS, flexWrap: "wrap" },
  templates: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalM },
  sceneIcon: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", width: "32px", height: "32px", flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium, fontSize: "18px", color: tokens.colorBrandForeground1, backgroundColor: tokens.colorBrandBackground2,
  },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalXS },
  grow: { flexGrow: 1 },
  pick: { flexGrow: 1, justifyContent: "flex-start", minWidth: 0 },
  title: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
});

// --- scenes ------------------------------------------------------------------------------------

interface SceneListProps {
  studio: Studio;
  editingId: string;
  onEdit(sceneId: string): void;
  onActivate(sceneId: string): void;
  onCreate(source: "builtin" | "template" | "scene", ref: string): void;
  onDelete(sceneId: string): void;
  onSaveTemplate(sceneId: string): void;
  onDeleteTemplate(templateId: string): void;
}

export function SceneList({ studio, editingId, onEdit, onActivate, onCreate, onDelete, onSaveTemplate, onDeleteTemplate }: SceneListProps) {
  const styles = useStyles();
  const [origin, setOrigin] = useState("builtin:Live match");
  const create = () => {
    const [source, ...rest] = origin.split(":");
    onCreate(source as "builtin" | "template", rest.join(":"));
  };
  return (
    <section className={styles.panel} aria-label="Scenes">
      <div className={styles.title}>
        <span className={styles.sceneIcon} aria-hidden><SlideLayoutRegular /></span>
        <Text as="h2" weight="semibold" size={400}>Scenes</Text>
        <span className={styles.grow} />
        <div className={styles.add}>
          <Select aria-label="New scene from" value={origin} onChange={(_, data) => setOrigin(data.value)}>
            {BUILTIN.map((name) => (
              <option key={name} value={`builtin:${name}`}>{name}</option>
            ))}
            {studio.templates.map((template) => (
              <option key={template.id} value={`template:${template.id}`}>{template.name} (saved)</option>
            ))}
          </Select>
          <Button icon={<AddRegular />} onClick={create}>Add scene</Button>
        </div>
      </div>
      <ul className={styles.strip}>
        {studio.scenes.map((scene) => {
          const onAir = scene.id === studio.active_scene_id;
          return (
            <li key={scene.id} className={mergeClasses(styles.sceneItem, scene.id === editingId && styles.sceneEditing, onAir && styles.sceneOnAir)}>
              <div className={styles.row}>
                <span className={styles.sceneIcon} aria-hidden>{sceneIcon(scene)}</span>
                <Button className={styles.pick} appearance={scene.id === editingId ? "primary" : "secondary"}
                  aria-label={`Edit ${scene.name}`} onClick={() => onEdit(scene.id)}>
                  {scene.name}
                </Button>
                {onAir ? (
                  <Badge color="danger">On air</Badge>
                ) : (
                  <Button size="small" icon={<PlayRegular />} aria-label={`Switch to ${scene.name}`} onClick={() => onActivate(scene.id)}>Switch</Button>
                )}
              </div>
              <div className={styles.row}>
                <ModeBadge scene={scene} studio={studio} />
                <span className={styles.grow} />
                <Tooltip content="Duplicate" relationship="description">
                  <Button size="small" appearance="subtle" icon={<CopyRegular />} aria-label={`Duplicate ${scene.name}`} onClick={() => onCreate("scene", scene.id)} />
                </Tooltip>
                <Tooltip content="Save as template" relationship="description">
                  <Button size="small" appearance="subtle" icon={<SaveRegular />} aria-label={`Save ${scene.name} as template`} onClick={() => onSaveTemplate(scene.id)} />
                </Tooltip>
                <Tooltip content="Delete" relationship="description">
                  <Button size="small" appearance="subtle" icon={<DeleteRegular />} aria-label={`Delete ${scene.name}`} disabled={onAir || studio.scenes.length === 1} onClick={() => onDelete(scene.id)} />
                </Tooltip>
              </div>
            </li>
          );
        })}
      </ul>
      {studio.templates.length > 0 && (
        <ul className={styles.templates} aria-label="Saved templates">
          {studio.templates.map((template) => (
            <li key={template.id} className={styles.row}>
              <Text className={styles.grow}>{template.name}</Text>
              <Button size="small" appearance="subtle" aria-label={`Delete template ${template.name}`} onClick={() => onDeleteTemplate(template.id)}>Delete</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --- elements ----------------------------------------------------------------------------------

interface ElementPanelProps {
  scene: Scene;
  selectedId: string | null;
  onSelect(elementId: string | null): void;
  onChange(elements: SceneElement[]): void;
  onUpload(file: File): Promise<string | null>;
  /** The team sheets, for choosing the player a player card follows. */
  status?: MatchStatus | null;
}

export function ElementPanel({ scene, selectedId, onSelect, onChange, onUpload, status = null }: ElementPanelProps) {
  const styles = useStyles();
  return (
    <div className={styles.panel}>
      <ElementLibrary scene={scene} onSelect={onSelect} onChange={onChange} />
      <Layers scene={scene} selectedId={selectedId} onSelect={onSelect} onChange={onChange} />
      <Inspector scene={scene} selectedId={selectedId} onChange={onChange} onUpload={onUpload} status={status} />
    </div>
  );
}