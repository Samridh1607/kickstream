import { Button, Field, makeStyles, Select, Text, tokens, Tooltip } from "@fluentui/react-components";
import {
  AddRegular, ChartMultipleRegular, ChatRegular, CubeRegular, DataLineRegular, DataTrendingRegular, LightbulbRegular, MegaphoneRegular,
  MoneyRegular, NumberSymbolRegular, PersonRunningRegular, PollRegular,
} from "@fluentui/react-icons";
import { type ReactElement, useState } from "react";
import type { Scene, SceneElement } from "../../contracts";
import { CANVAS, nextLayer } from "../geometry";
import type { WidgetType } from "../widgets";

const ELEMENT_TYPES: SceneElement["type"][] = [
  "scoreboard", "pitch", "narration", "stats", "banner", "ticker", "timeline", "recap", "replay", "countdown", "text", "image", "cameras",
  "scorecard", "chart", "graph", "prediction", "insight", "pitch3d", "player", "comments", "poll", "superchat", "spotlight",
];
const MAX_ELEMENTS = 40;

/** The widgets one click adds to a scene, with the size and settings each starts with. */
export const WIDGETS: { type: WidgetType; label: string; hint: string; icon: ReactElement; width: number; height: number; props: Record<string, unknown> }[] = [
  { type: "scorecard", label: "Score card", hint: "Both sides, the score, the minute and the scorers", icon: <NumberSymbolRegular />, width: 900, height: 200, props: {} },
  { type: "chart", label: "Chart", hint: "The two sides compared", icon: <ChartMultipleRegular />, width: 560, height: 420, props: { metric: "overview" } },
  { type: "graph", label: "Graph", hint: "Momentum, expected goals or win probability over time", icon: <DataLineRegular />, width: 760, height: 300, props: { metric: "momentum" } },
  { type: "prediction", label: "Prediction", hint: "The Prediction Agent's forecast", icon: <DataTrendingRegular />, width: 760, height: 260, props: { view: "outcome" } },
  { type: "insight", label: "Why it matters", hint: "The Explainability Agent's latest explanation", icon: <LightbulbRegular />, width: 800, height: 280, props: {} },
  { type: "pitch3d", label: "3D pitch", hint: "The Visualization Agent's pitch and overlays", icon: <CubeRegular />, width: 900, height: 560, props: { camera: "auto" } },
  { type: "player", label: "Player card", hint: "One player's numbers from the Player Tracking Agent", icon: <PersonRunningRegular />, width: 520, height: 440, props: { player_id: null } },
  { type: "comments", label: "Comments", hint: "What fans are saying", icon: <ChatRegular />, width: 640, height: 520, props: { lines: 4, liked_only: false } },
  { type: "poll", label: "Poll", hint: "The poll, while it is on screen", icon: <PollRegular />, width: 640, height: 440, props: {} },
  { type: "superchat", label: "Superchats", hint: "The latest supporters by name", icon: <MoneyRegular />, width: 760, height: 240, props: { lines: 3 } },
  { type: "spotlight", label: "Spotlight", hint: "A comment, superchat, message or winner put on screen", icon: <MegaphoneRegular />, width: 1000, height: 220, props: {} },
];
export const WIDGET_BY_TYPE = new Map(WIDGETS.map((widget) => [widget.type as SceneElement["type"], widget]));

const useStyles = makeStyles({
  panel: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalXS },
  grow: { flexGrow: 1 },
  gallery: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))", gap: tokens.spacingHorizontalS },
  tile: {
    display: "flex", flexDirection: "column", alignItems: "center", gap: tokens.spacingVerticalXXS, minWidth: 0, height: "auto",
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXS}`, borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1, cursor: "pointer", fontFamily: "inherit", fontSize: tokens.fontSizeBase200,
    transitionProperty: "transform, box-shadow, border-color", transitionDuration: "160ms",
    ":hover": { transform: "translateY(-2px)", boxShadow: tokens.shadow8, border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke1}` },
    ":active": { transform: "translateY(0) scale(0.97)" },
    ":disabled": { opacity: 0.5, cursor: "not-allowed", transform: "none", boxShadow: "none" },
    ":focus-visible": { outline: `${tokens.strokeWidthThick} solid ${tokens.colorStrokeFocus2}` },
  },
  tileIcon: { fontSize: "24px", color: tokens.colorBrandForeground1, display: "inline-flex" },
});

export function newElementId(): string {
  return Math.random().toString(16).slice(2, 10);
}

/** A widget as one click adds it: at its own size, in the middle of the canvas, moved along by `step` so several in a row do not hide one another. */
export function widgetElement(widget: (typeof WIDGETS)[number], elements: SceneElement[], step = 0, props: Record<string, unknown> = widget.props): SceneElement {
  return {
    id: newElementId(), type: widget.type, width: widget.width, height: widget.height, layer: nextLayer(elements), visible: true,
    x: Math.min(CANVAS.width - widget.width, Math.round((CANVAS.width - widget.width) / 2 / 20) * 20 + step),
    y: Math.min(CANVAS.height - widget.height, Math.round((CANVAS.height - widget.height) / 2 / 20) * 20 + step),
    props,
  };
}

interface ElementLibraryProps {
  scene: Scene;
  onSelect(elementId: string | null): void;
  onChange(elements: SceneElement[]): void;
}

/** Adds widgets, or any element by its type, to the scene. */
export function ElementLibrary({ scene, onSelect, onChange }: ElementLibraryProps) {
  const styles = useStyles();
  const [type, setType] = useState<SceneElement["type"]>("text");
  const full = scene.elements.length >= MAX_ELEMENTS;

  const add = () => {
    const added: SceneElement = { id: newElementId(), type, x: 760, y: 440, width: 400, height: 200, layer: nextLayer(scene.elements), visible: true, props: {} };
    onChange([...scene.elements, added]);
    onSelect(added.id);
  };
  const addWidget = (widget: (typeof WIDGETS)[number]) => {
    const added = widgetElement(widget, scene.elements, (scene.elements.length % 6) * 40);
    onChange([...scene.elements, added]);
    onSelect(added.id);
  };

  return (
    <div className={styles.panel}>
      <Text weight="semibold">Add to this scene</Text>
      <div className={styles.gallery} role="group" aria-label="Widgets">
        {WIDGETS.map((widget) => (
          <Tooltip key={widget.type} content={widget.hint} relationship="description">
            <button type="button" className={styles.tile} disabled={full} aria-label={`Add ${widget.label}`} onClick={() => addWidget(widget)}>
              <span className={styles.tileIcon} aria-hidden>{widget.icon}</span>
              {widget.label}
            </button>
          </Tooltip>
        ))}
      </div>
      <Text size={200}>A widget added to the scene on air appears on the program at once.</Text>
      <div className={styles.row}>
        <Field label="Element type" className={styles.grow}>
          <Select value={type} onChange={(_, data) => setType(data.value as SceneElement["type"])}>
            {ELEMENT_TYPES.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </Select>
        </Field>
        <Button icon={<AddRegular />} onClick={add} disabled={full}>Add element</Button>
      </div>
    </div>
  );
}
