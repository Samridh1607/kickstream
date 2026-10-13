import {
  Badge, Button, Checkbox, Field, Input, makeStyles, mergeClasses, Select, Switch, Text, Textarea, tokens, Tooltip,
} from "@fluentui/react-components";
import {
  AddRegular, ArrowDownRegular, ArrowUpRegular, BrainCircuitRegular, ChartMultipleRegular, ChatRegular, ClockRegular, CopyRegular,
  CubeRegular, DataLineRegular, DataTrendingRegular, DeleteRegular, DismissRegular, HourglassRegular, LightbulbRegular, MegaphoneRegular,
  MoneyRegular, NumberSymbolRegular, PeopleCommunityRegular, PeopleRegular, PersonRunningRegular, PlayRegular, PollRegular, SaveRegular,
  SlideLayoutRegular, SportSoccerRegular, TrophyRegular, VideoPersonRegular,
} from "@fluentui/react-icons";
import { type ChangeEvent, type ReactElement, useEffect, useState } from "react";
import type { MatchStatus, Scene, SceneElement, Studio, StudioSettings, Ticker } from "../contracts";
import { LANGUAGE_NAMES, LANGUAGES, type Language, type Mode, type StringKey, t } from "../i18n";
import type { FeedMoment, FeedNarrative, MatchData } from "../stream/store";
import { formatRemaining } from "./format";
import { lower, nextLayer, raise } from "./geometry";
import { sceneMode } from "./mode";
import type { WidgetType } from "./widgets";

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
const ELEMENT_TYPES: SceneElement["type"][] = [
  "scoreboard", "pitch", "narration", "stats", "banner", "ticker", "timeline", "recap", "replay", "countdown", "text", "image", "cameras",
  "scorecard", "chart", "graph", "prediction", "insight", "pitch3d", "player", "comments", "poll", "superchat", "spotlight",
];

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
const WIDGET_BY_TYPE = new Map(WIDGETS.map((widget) => [widget.type as SceneElement["type"], widget]));
const CANVAS_W = 1920;
const CANVAS_H = 1080;

const useStyles = makeStyles({
  panel: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  item: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
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

function newElementId(): string {
  return Math.random().toString(16).slice(2, 10);
}

function TextField({ label, value, onCommit }: { label: string; value: string; onCommit(value: string): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Field label={label}>
      <Textarea value={draft} maxLength={200} onChange={(_, data) => setDraft(data.value)} onBlur={() => draft !== value && onCommit(draft)} />
    </Field>
  );
}

export function ElementPanel({ scene, selectedId, onSelect, onChange, onUpload, status = null }: ElementPanelProps) {
  const styles = useStyles();
  const [type, setType] = useState<SceneElement["type"]>("text");
  const stacked = [...scene.elements].sort((a, b) => b.layer - a.layer);
  const selected = scene.elements.find((element) => element.id === selectedId);

  const patch = (id: string, changes: Partial<SceneElement>) =>
    onChange(scene.elements.map((element) => (element.id === id ? { ...element, ...changes } : element)));
  const setProp = (element: SceneElement, key: string, value: unknown) => patch(element.id, { props: { ...element.props, [key]: value } });
  const add = () => {
    const added: SceneElement = { id: newElementId(), type, x: 760, y: 440, width: 400, height: 200, layer: nextLayer(scene.elements), visible: true, props: {} };
    onChange([...scene.elements, added]);
    onSelect(added.id);
  };
  const full = scene.elements.length >= 40;
  const addWidget = (widget: (typeof WIDGETS)[number]) => {
    // Each new widget lands a little further along, so several added in a row do not hide one another.
    const step = (scene.elements.length % 6) * 40;
    const added: SceneElement = {
      id: newElementId(), type: widget.type, width: widget.width, height: widget.height, layer: nextLayer(scene.elements), visible: true,
      x: Math.min(CANVAS_W - widget.width, Math.round((CANVAS_W - widget.width) / 2 / 20) * 20 + step),
      y: Math.min(CANVAS_H - widget.height, Math.round((CANVAS_H - widget.height) / 2 / 20) * 20 + step),
      props: widget.props,
    };
    onChange([...scene.elements, added]);
    onSelect(added.id);
  };
  const players = status ? [...status.home.players, ...status.away.players] : [];
  const upload = async (element: SceneElement, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const imageId = await onUpload(file);
    if (imageId) setProp(element, "image_id", imageId);
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
      <ul className={styles.list}>
        {stacked.map((element) => (
          <li key={element.id} className={styles.row}>
            <Checkbox aria-label={`Show ${element.type}`} checked={element.visible} onChange={(_, data) => patch(element.id, { visible: data.checked === true })} />
            <Button className={styles.pick} size="small" appearance={element.id === selectedId ? "primary" : "subtle"}
              aria-label={`Select ${element.type}`} onClick={() => onSelect(element.id)}>
              {WIDGET_BY_TYPE.get(element.type)?.label ?? element.type}
            </Button>
            <Button size="small" appearance="subtle" icon={<ArrowUpRegular />} aria-label={`Bring ${element.type} forward`} onClick={() => onChange(raise(scene.elements, element.id))} />
            <Button size="small" appearance="subtle" icon={<ArrowDownRegular />} aria-label={`Send ${element.type} back`} onClick={() => onChange(lower(scene.elements, element.id))} />
            <Button size="small" appearance="subtle" icon={<DismissRegular />} aria-label={`Remove ${element.type}`} onClick={() => onChange(scene.elements.filter((other) => other.id !== element.id))} />
          </li>
        ))}
      </ul>
      <div className={styles.row}>
        <Field label="Element type" className={styles.grow}>
          <Select value={type} onChange={(_, data) => setType(data.value as SceneElement["type"])}>
            {ELEMENT_TYPES.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </Select>
        </Field>
        <Button icon={<AddRegular />} onClick={add} disabled={scene.elements.length >= 40}>Add element</Button>
      </div>
      {selected?.type === "text" && (
        <>
          <TextField label="Text" value={String(selected.props.text ?? "")} onCommit={(value) => setProp(selected, "text", value)} />
          <Field label="Size">
            <Input type="number" min={12} max={200} value={String(selected.props.size ?? 48)} onChange={(_, data) => Number(data.value) >= 12 && setProp(selected, "size", Number(data.value))} />
          </Field>
          <Field label="Alignment">
            <Select value={String(selected.props.align ?? "center")} onChange={(_, data) => setProp(selected, "align", data.value)}>
              <option value="left">Left</option>
              <option value="center">Centre</option>
              <option value="right">Right</option>
            </Select>
          </Field>
        </>
      )}
      {selected?.type === "narration" && (
        <Field label="Lines">
          <Select value={String(selected.props.lines ?? 3)} onChange={(_, data) => setProp(selected, "lines", Number(data.value))}>
            {[1, 2, 3, 4, 5, 6].map((count) => (
              <option key={count} value={count}>{count}</option>
            ))}
          </Select>
        </Field>
      )}
      {selected?.type === "pitch" && (
        <Switch label="Pressure map" checked={selected.props.pressure !== false} onChange={(_, data) => setProp(selected, "pressure", data.checked)} />
      )}
      {selected?.type === "chart" && (
        <Field label="Compare">
          <Select value={String(selected.props.metric ?? "overview")} onChange={(_, data) => setProp(selected, "metric", data.value)}>
            <option value="overview">Possession, shots and expected goals</option>
            <option value="possession">Possession</option>
            <option value="shots">Shots</option>
            <option value="xg">Expected goals</option>
            <option value="tactics">Tactics: pressure, tempo and field tilt</option>
          </Select>
        </Field>
      )}
      {selected?.type === "graph" && (
        <Field label="Over time">
          <Select value={String(selected.props.metric ?? "momentum")} onChange={(_, data) => setProp(selected, "metric", data.value)}>
            <option value="momentum">Momentum</option>
            <option value="xg">Expected goals</option>
            <option value="win_probability">Win probability</option>
          </Select>
        </Field>
      )}
      {selected?.type === "prediction" && (
        <Field label="Forecast">
          <Select value={String(selected.props.view ?? "outcome")} onChange={(_, data) => setProp(selected, "view", data.value)}>
            <option value="outcome">Who wins</option>
            <option value="next_goal">Who scores in the next ten minutes</option>
            <option value="next_action">What the side on the ball does next</option>
          </Select>
        </Field>
      )}
      {selected?.type === "pitch3d" && (
        <Field label="Camera">
          <Select value={String(selected.props.camera ?? "auto")} onChange={(_, data) => setProp(selected, "camera", data.value)}>
            <option value="auto">Follow the play</option>
            <option value="broadcast">Broadcast view</option>
            <option value="tactical">Tactical view</option>
          </Select>
        </Field>
      )}
      {selected?.type === "player" && (
        <Field label="Player" hint={players.length === 0 ? "Start a match to choose a player." : undefined}>
          <Select value={typeof selected.props.player_id === "string" ? selected.props.player_id : ""} onChange={(_, data) => setProp(selected, "player_id", data.value || null)}>
            <option value="">Best rated so far</option>
            {players.map((player) => (
              <option key={player.id} value={player.id}>{player.number}. {player.name}</option>
            ))}
          </Select>
        </Field>
      )}
      {selected?.type === "comments" && (
        <>
          <Field label="Comments shown">
            <Select value={String(selected.props.lines ?? 4)} onChange={(_, data) => setProp(selected, "lines", Number(data.value))}>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((count) => (
                <option key={count} value={count}>{count}</option>
              ))}
            </Select>
          </Field>
          <Switch label="Only comments I have liked" checked={selected.props.liked_only === true} onChange={(_, data) => setProp(selected, "liked_only", data.checked)} />
        </>
      )}
      {selected?.type === "superchat" && (
        <Field label="Superchats shown">
          <Select value={String(selected.props.lines ?? 3)} onChange={(_, data) => setProp(selected, "lines", Number(data.value))}>
            {[1, 2, 3, 4, 5, 6].map((count) => (
              <option key={count} value={count}>{count}</option>
            ))}
          </Select>
        </Field>
      )}
      {selected?.type === "cameras" && (
        <Switch label="Name tags" checked={selected.props.names !== false} onChange={(_, data) => setProp(selected, "names", data.checked)} />
      )}
      {selected?.type === "image" && (
        <>
          <Field label="Image file" hint="PNG, JPEG or WebP, up to 2 MB">
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void upload(selected, event)} />
          </Field>
          <Field label="Fit">
            <Select value={String(selected.props.fit ?? "contain")} onChange={(_, data) => setProp(selected, "fit", data.value)}>
              <option value="contain">Show all of it</option>
              <option value="cover">Fill the box</option>
            </Select>
          </Field>
        </>
      )}
    </div>
  );
}

// --- banner ------------------------------------------------------------------------------------

interface BannerPanelProps {
  studio: Studio;
  onShow(text: string): Promise<boolean>;
  onClear(): void;
  onAuto(enabled: boolean): void;
}

export function BannerPanel({ studio, onShow, onClear, onAuto }: BannerPanelProps) {
  const styles = useStyles();
  const [text, setText] = useState("");
  const show = async () => {
    if (await onShow(text)) setText("");
  };
  return (
    <div className={styles.panel}>
      <Field label="Banner text">
        <Input value={text} maxLength={200} onChange={(_, data) => setText(data.value)} />
      </Field>
      <Button appearance="primary" disabled={text.trim() === ""} onClick={() => void show()}>Show banner</Button>
      {studio.banner ? (
        <div className={styles.item}>
          <Text size={200}>On screen</Text>
          <Text>{studio.banner.text}</Text>
          <Button size="small" onClick={onClear}>Clear banner</Button>
        </div>
      ) : (
        <Text size={200}>No banner on screen.</Text>
      )}
      {studio.banner_queue.length > 0 && <Text size={200}>{studio.banner_queue.length} waiting</Text>}
      <Switch label="Automatic banners for goals and red cards" checked={studio.settings.auto_banner} onChange={(_, data) => onAuto(data.checked)} />
    </div>
  );
}

// --- ticker ------------------------------------------------------------------------------------

export function TickerPanel({ ticker, onSave }: { ticker: Ticker; onSave(ticker: Ticker): void }) {
  const styles = useStyles();
  const [draft, setDraft] = useState(ticker);
  const [lines, setLines] = useState(ticker.messages.join("\n"));
  const saved = JSON.stringify(ticker);
  useEffect(() => {
    const current = JSON.parse(saved) as Ticker;
    setDraft(current);
    setLines(current.messages.join("\n"));
  }, [saved]);
  const messages = lines.split("\n").map((line) => line.trim()).filter(Boolean);
  return (
    <div className={styles.panel}>
      <Switch label="Ticker on" checked={draft.enabled} onChange={(_, data) => setDraft({ ...draft, enabled: data.checked })} />
      <Field label="Messages, one per line" hint="Up to 20 messages of 120 characters">
        <Textarea rows={5} value={lines} onChange={(_, data) => setLines(data.value)} />
      </Field>
      <Field label="Speed" hint="40 (slow) to 400 (fast)">
        <Input type="number" min={40} max={400} value={String(draft.speed)} onChange={(_, data) => setDraft({ ...draft, speed: Number(data.value) })} />
      </Field>
      <Switch label="Show the score" checked={draft.show_score} onChange={(_, data) => setDraft({ ...draft, show_score: data.checked })} />
      <Switch label="Show match stats" checked={draft.show_stats} onChange={(_, data) => setDraft({ ...draft, show_stats: data.checked })} />
      <Button appearance="primary" onClick={() => onSave({ ...draft, messages })}>Save ticker</Button>
    </div>
  );
}

// --- highlights --------------------------------------------------------------------------------

interface HighlightsPanelProps {
  match: MatchData;
  replaying: boolean;
  onReplay(moment: FeedMoment): void;
  onStopReplay(): void;
  onBanner(narrative: FeedNarrative): void;
}

export function HighlightsPanel({ match, replaying, onReplay, onStopReplay, onBanner }: HighlightsPanelProps) {
  const styles = useStyles();
  const newestFirst = [...match.moments].reverse();
  return (
    <div className={styles.panel}>
      {replaying && <Button onClick={onStopReplay}>Stop replay</Button>}
      {newestFirst.length === 0 && <Text size={200}>Key moments appear here as the match is played.</Text>}
      <ul className={styles.list}>
        {newestFirst.map((moment) => {
          const label = `${moment.minute}' ${t("en", `kind_${moment.kind}` as StringKey)}`;
          const narrative = match.narratives.find((line) => line.moment_id === moment.id);
          return (
            <li key={moment.id} className={styles.item}>
              <Text weight="semibold">{label}</Text>
              {narrative && <Text size={200}>{narrative.text}</Text>}
              <div className={styles.row}>
                <Button size="small" aria-label={`Replay ${label}`} onClick={() => onReplay(moment)}>Replay</Button>
                {narrative && (
                  <Button size="small" aria-label={`Show ${label} on banner`} onClick={() => onBanner(narrative)}>Show on banner</Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// --- countdown ---------------------------------------------------------------------------------

interface CountdownPanelProps {
  studio: Studio;
  /** The server's clock, Unix seconds. */
  now: number;
  onStart(startsAt: number): void;
  onBreak(minutes: number): void;
  onEnd(): void;
}

export function CountdownPanel({ studio, now, onStart, onBreak, onEnd }: CountdownPanelProps) {
  const styles = useStyles();
  const [startIn, setStartIn] = useState("10");
  const [breakFor, setBreakFor] = useState("5");
  const countdown = studio.countdown;
  const onBreakNow = countdown?.kind === "break";
  return (
    <div className={styles.panel}>
      {countdown && (
        <div className={styles.item}>
          <Text>{`${onBreakNow ? "Break" : "Kick-off"}: ${formatRemaining(countdown.ends_at - now)} left`}</Text>
          <Button size="small" onClick={onEnd}>{onBreakNow ? "End break" : "End countdown"}</Button>
        </div>
      )}
      <Field label="Start in (minutes)" hint="1 to 1440. The match starts and the program cuts to Live when it reaches zero.">
        <Input type="number" min={1} max={1440} value={startIn} onChange={(_, data) => setStartIn(data.value)} />
      </Field>
      <Button onClick={() => onStart(now + Number(startIn) * 60)} disabled={!(Number(startIn) >= 1)}>Start countdown</Button>
      <Field label="Break length (minutes)" hint="1 to 60. The program returns to the scene it left.">
        <Input type="number" min={1} max={60} value={breakFor} onChange={(_, data) => setBreakFor(data.value)} />
      </Field>
      <Button onClick={() => onBreak(Number(breakFor))} disabled={!(Number(breakFor) >= 1)}>Take a break</Button>
    </div>
  );
}

// --- settings ----------------------------------------------------------------------------------

export function SettingsPanel({ settings, onSave }: { settings: StudioSettings; onSave(settings: StudioSettings): void }) {
  const styles = useStyles();
  return (
    <div className={styles.panel}>
      <Field label="Default commentary" hint="Used by scenes that do not choose Fan or Analyst themselves.">
        <Select value={settings.mode} onChange={(_, data) => onSave({ ...settings, mode: data.value as Mode })}>
          <option value="fan">Fan</option>
          <option value="analyst">Analyst</option>
        </Select>
      </Field>
      <Field label="Program language">
        <Select value={settings.language} onChange={(_, data) => onSave({ ...settings, language: data.value as Language })}>
          {LANGUAGES.map((language) => (
            <option key={language} value={language}>{LANGUAGE_NAMES[language]}</option>
          ))}
        </Select>
      </Field>
      <Switch label="Start the match when the start countdown ends" checked={settings.auto_start} onChange={(_, data) => onSave({ ...settings, auto_start: data.checked })} />
      <Switch label="Take a break automatically at half-time" checked={settings.auto_half_time_break} onChange={(_, data) => onSave({ ...settings, auto_half_time_break: data.checked })} />
    </div>
  );
}
