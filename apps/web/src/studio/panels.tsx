import {
  Badge, Button, Checkbox, Field, Input, makeStyles, Select, Switch, Text, Textarea, tokens,
} from "@fluentui/react-components";
import { type ChangeEvent, useEffect, useState } from "react";
import type { Scene, SceneElement, Studio, StudioSettings, Ticker } from "../contracts";
import { LANGUAGE_NAMES, LANGUAGES, type Language, type Mode, type StringKey, t } from "../i18n";
import type { FeedMoment, FeedNarrative, MatchData } from "../stream/store";
import { formatRemaining } from "./format";
import { lower, nextLayer, raise } from "./geometry";

const BUILTIN = ["Starting soon", "Live match", "Analyst desk", "Break", "Full-time"];
const ELEMENT_TYPES: SceneElement["type"][] = [
  "scoreboard", "pitch", "narration", "stats", "banner", "ticker", "timeline", "recap", "replay", "countdown", "text", "image",
];

const useStyles = makeStyles({
  panel: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  item: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalXS },
  grow: { flexGrow: 1 },
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
      <Text as="h2" weight="semibold">Scenes</Text>
      <ul className={styles.list}>
        {studio.scenes.map((scene) => {
          const onAir = scene.id === studio.active_scene_id;
          return (
            <li key={scene.id} className={styles.item}>
              <div className={styles.row}>
                <Button className={styles.grow} appearance={scene.id === editingId ? "primary" : "secondary"}
                  aria-label={`Edit ${scene.name}`} onClick={() => onEdit(scene.id)}>
                  {scene.name}
                </Button>
                {onAir ? (
                  <Badge color="danger">On air</Badge>
                ) : (
                  <Button size="small" aria-label={`Go live with ${scene.name}`} onClick={() => onActivate(scene.id)}>Go live</Button>
                )}
              </div>
              <div className={styles.row}>
                <Button size="small" appearance="subtle" aria-label={`Duplicate ${scene.name}`} onClick={() => onCreate("scene", scene.id)}>Duplicate</Button>
                <Button size="small" appearance="subtle" aria-label={`Save ${scene.name} as template`} onClick={() => onSaveTemplate(scene.id)}>Save as template</Button>
                <Button size="small" appearance="subtle" aria-label={`Delete ${scene.name}`} disabled={onAir || studio.scenes.length === 1} onClick={() => onDelete(scene.id)}>Delete</Button>
              </div>
            </li>
          );
        })}
      </ul>
      <Field label="New scene from">
        <Select value={origin} onChange={(_, data) => setOrigin(data.value)}>
          {BUILTIN.map((name) => (
            <option key={name} value={`builtin:${name}`}>{name}</option>
          ))}
          {studio.templates.map((template) => (
            <option key={template.id} value={`template:${template.id}`}>{template.name} (saved)</option>
          ))}
        </Select>
      </Field>
      <Button onClick={create}>Add scene</Button>
      {studio.templates.length > 0 && (
        <ul className={styles.list} aria-label="Saved templates">
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

export function ElementPanel({ scene, selectedId, onSelect, onChange, onUpload }: ElementPanelProps) {
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
  const upload = async (element: SceneElement, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const imageId = await onUpload(file);
    if (imageId) setProp(element, "image_id", imageId);
  };

  return (
    <div className={styles.panel}>
      <ul className={styles.list}>
        {stacked.map((element) => (
          <li key={element.id} className={styles.row}>
            <Checkbox aria-label={`Show ${element.type}`} checked={element.visible} onChange={(_, data) => patch(element.id, { visible: data.checked === true })} />
            <Button className={styles.grow} size="small" appearance={element.id === selectedId ? "primary" : "subtle"}
              aria-label={`Select ${element.type}`} onClick={() => onSelect(element.id)}>
              {element.type}
            </Button>
            <Button size="small" appearance="subtle" aria-label={`Bring ${element.type} forward`} onClick={() => onChange(raise(scene.elements, element.id))}>↑</Button>
            <Button size="small" appearance="subtle" aria-label={`Send ${element.type} back`} onClick={() => onChange(lower(scene.elements, element.id))}>↓</Button>
            <Button size="small" appearance="subtle" aria-label={`Remove ${element.type}`} onClick={() => onChange(scene.elements.filter((other) => other.id !== element.id))}>✕</Button>
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
        <Button onClick={add} disabled={scene.elements.length >= 40}>Add element</Button>
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
      <Field label="Program mode">
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
