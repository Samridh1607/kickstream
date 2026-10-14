import { Field, Input, makeStyles, Select, Slider, Switch, Text, Textarea, tokens } from "@fluentui/react-components";
import { type ChangeEvent, type KeyboardEvent, useEffect, useState } from "react";
import { ZOOM_RANGE } from "../../agents/Pitch3D";
import type { MatchStatus, Scene, SceneElement } from "../../contracts";
import { heldView } from "../widgets";

const NAME_MAX = 60;

const useStyles = makeStyles({
  panel: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
});

function TextField({ label, value, onCommit }: { label: string; value: string; onCommit(value: string): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Field label={label}>
      <Textarea value={draft} maxLength={200} onChange={(_, data) => setDraft(data.value)} onBlur={() => draft !== value && onCommit(draft)} />
    </Field>
  );
}

/** A slider that saves once it is let go of, not at every step on the way. */
function ViewSlider({ label, value, min, max, step, format, onCommit }: {
  label: string; value: number; min: number; max: number; step: number; format(value: number): string; onCommit(value: number): void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  return (
    <Field label={label} hint={format(draft)}>
      <Slider min={min} max={max} step={step} value={draft} onChange={(_, data) => setDraft(data.value)}
        input={{ "aria-valuetext": format(draft), onPointerUp: commit, onKeyUp: commit, onBlur: commit }} />
    </Field>
  );
}

function SceneName({ scene, onRename }: { scene: Scene; onRename(sceneId: string, name: string): void }) {
  const [draft, setDraft] = useState(scene.name);
  useEffect(() => setDraft(scene.name), [scene.name]);
  const commit = () => {
    const name = draft.trim();
    if (name !== "" && name !== scene.name) onRename(scene.id, name);
    else setDraft(scene.name);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
  };
  return (
    <Field label="Scene name">
      <Input value={draft} maxLength={NAME_MAX} onChange={(_, data) => setDraft(data.value)} onBlur={commit} onKeyDown={onKeyDown} />
    </Field>
  );
}

interface InspectorProps {
  scene: Scene;
  selectedId: string | null;
  onChange(elements: SceneElement[]): void;
  onUpload(file: File): Promise<string | null>;
  /** The team sheets, for choosing the player a player card follows. */
  status?: MatchStatus | null;
  /** When given, the scene's name can be changed while no element is selected. */
  onRename?(sceneId: string, name: string): void;
}

/** The selected element's settings, or the scene's when nothing is selected. */
export function Inspector({ scene, selectedId, onChange, onUpload, status = null, onRename }: InspectorProps) {
  const styles = useStyles();
  const selected = scene.elements.find((element) => element.id === selectedId);

  const patch = (id: string, changes: Partial<SceneElement>) =>
    onChange(scene.elements.map((element) => (element.id === id ? { ...element, ...changes } : element)));
  const setProp = (element: SceneElement, key: string, value: unknown) => patch(element.id, { props: { ...element.props, [key]: value } });
  const players = status ? [...status.home.players, ...status.away.players] : [];
  const upload = async (element: SceneElement, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const imageId = await onUpload(file);
    if (imageId) setProp(element, "image_id", imageId);
  };

  if (!selected) {
    if (!onRename) return null;
    return (
      <div className={styles.panel}>
        <SceneName key={scene.id} scene={scene} onRename={onRename} />
        <Text size={200}>Select an element to change it.</Text>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      {selected.type === "text" && (
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
      {selected.type === "narration" && (
        <Field label="Lines">
          <Select value={String(selected.props.lines ?? 3)} onChange={(_, data) => setProp(selected, "lines", Number(data.value))}>
            {[1, 2, 3, 4, 5, 6].map((count) => (
              <option key={count} value={count}>{count}</option>
            ))}
          </Select>
        </Field>
      )}
      {selected.type === "pitch" && (
        <Switch label="Pressure map" checked={selected.props.pressure !== false} onChange={(_, data) => setProp(selected, "pressure", data.checked)} />
      )}
      {selected.type === "chart" && (
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
      {selected.type === "graph" && (
        <Field label="Over time">
          <Select value={String(selected.props.metric ?? "momentum")} onChange={(_, data) => setProp(selected, "metric", data.value)}>
            <option value="momentum">Momentum</option>
            <option value="xg">Expected goals</option>
            <option value="win_probability">Win probability</option>
          </Select>
        </Field>
      )}
      {selected.type === "prediction" && (
        <Field label="Forecast">
          <Select value={String(selected.props.view ?? "outcome")} onChange={(_, data) => setProp(selected, "view", data.value)}>
            <option value="outcome">Who wins</option>
            <option value="next_goal">Who scores in the next ten minutes</option>
            <option value="next_action">What the side on the ball does next</option>
          </Select>
        </Field>
      )}
      {selected.type === "pitch3d" && (
        <>
          <Field label="Camera">
            <Select value={String(selected.props.camera ?? "auto")} onChange={(_, data) => setProp(selected, "camera", data.value)}>
              <option value="auto">Follow the play</option>
              <option value="broadcast">Broadcast view</option>
              <option value="tactical">Tactical view</option>
              <option value="attack_home">Behind the home attack</option>
              <option value="attack_away">Behind the away attack</option>
            </Select>
          </Field>
          <ViewSlider label="Zoom" value={Math.round(heldView(selected.props).zoom * 100)} min={ZOOM_RANGE[0] * 100} max={ZOOM_RANGE[1] * 100} step={5}
            format={(value) => `${value}%`} onCommit={(value) => setProp(selected, "zoom", value / 100)} />
          <ViewSlider label="Rotate" value={Math.round(heldView(selected.props).turn)} min={-75} max={75} step={1}
            format={(value) => `${value}°`} onCommit={(value) => setProp(selected, "turn", value)} />
          <ViewSlider label="Tilt" value={Math.round(heldView(selected.props).tilt)} min={-50} max={50} step={1}
            format={(value) => `${value}°`} onCommit={(value) => setProp(selected, "tilt", value)} />
          <Switch label="Follow the ball" checked={selected.props.follow_ball === true} onChange={(_, data) => setProp(selected, "follow_ball", data.checked)} />
        </>
      )}
      {selected.type === "player" && (
        <Field label="Player" hint={players.length === 0 ? "Start a match to choose a player." : undefined}>
          <Select value={typeof selected.props.player_id === "string" ? selected.props.player_id : ""} onChange={(_, data) => setProp(selected, "player_id", data.value || null)}>
            <option value="">Best rated so far</option>
            {players.map((player) => (
              <option key={player.id} value={player.id}>{player.number}. {player.name}</option>
            ))}
          </Select>
        </Field>
      )}
      {selected.type === "comments" && (
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
      {selected.type === "superchat" && (
        <Field label="Superchats shown">
          <Select value={String(selected.props.lines ?? 3)} onChange={(_, data) => setProp(selected, "lines", Number(data.value))}>
            {[1, 2, 3, 4, 5, 6].map((count) => (
              <option key={count} value={count}>{count}</option>
            ))}
          </Select>
        </Field>
      )}
      {selected.type === "cameras" && (
        <Switch label="Name tags" checked={selected.props.names !== false} onChange={(_, data) => setProp(selected, "names", data.checked)} />
      )}
      {selected.type === "image" && (
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
