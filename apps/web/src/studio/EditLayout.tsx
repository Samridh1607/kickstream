import { Badge, Button, makeStyles, Select, Text, tokens } from "@fluentui/react-components";
import { CheckmarkRegular, LiveRegular, PlayRegular, SlideLayoutRegular } from "@fluentui/react-icons";
import type { MatchStatus, Scene, SceneElement, Studio } from "../contracts";
import { ElementLibrary } from "./edit/ElementLibrary";
import { Inspector } from "./edit/Inspector";
import { Layers } from "./edit/Layers";
import type { ProgramData } from "./elements";
import { rectOf, snapToGuides } from "./geometry";
import { SceneCanvas } from "./SceneCanvas";
import { useStageScale } from "./Stage";

const useStyles = makeStyles({
  // Fills the height its parent gives it; the side columns scroll inside rather than growing the page.
  layout: {
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM, minWidth: 0, minHeight: 0, flexGrow: 1, padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke3}`,
  },
  header: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalS },
  headerIcon: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", borderRadius: tokens.borderRadiusMedium,
    fontSize: "18px", color: tokens.colorBrandForeground1, backgroundColor: tokens.colorBrandBackground2,
  },
  grow: { flexGrow: 1 },
  body: {
    display: "grid", gridTemplateColumns: "260px minmax(0, 1fr) 280px", gridTemplateRows: "minmax(0, 1fr)", gap: tokens.spacingHorizontalL,
    alignItems: "start", flexGrow: 1, minHeight: 0,
    "@media (max-width: 1100px)": { gridTemplateColumns: "minmax(0, 1fr)", gridTemplateRows: "none" },
  },
  side: {
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL, minWidth: 0, alignSelf: "stretch", minHeight: 0, overflowY: "auto",
    "@media (max-width: 1100px)": { overflowY: "visible" },
  },
  frame: { display: "flex", justifyContent: "center", overflow: "hidden", borderRadius: tokens.borderRadiusLarge, backgroundColor: "#05080F", minWidth: 0 },
});

/** A move of exactly one element is pulled onto nearby guides; resizes and anything else pass through unchanged. */
function snapMove(before: SceneElement[], after: SceneElement[]): SceneElement[] {
  const previous = new Map(before.map((element) => [element.id, element]));
  const moved = after.filter((element) => {
    const old = previous.get(element.id);
    return old !== undefined && (old.x !== element.x || old.y !== element.y);
  });
  if (moved.length !== 1) return after;
  const [element] = moved;
  const old = previous.get(element.id)!;
  if (old.width !== element.width || old.height !== element.height) return after;
  const others = after.filter((other) => other.id !== element.id && other.visible).map(rectOf);
  const rect = snapToGuides(rectOf(element), others);
  return after.map((other) => (other.id === element.id ? { ...other, ...rect } : other));
}

interface EditLayoutProps {
  /** The scene being edited, with any edit still waiting for the server applied. */
  scene: Scene;
  studio: Studio;
  data: ProgramData;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onChange(elements: SceneElement[]): void;
  onUpload(file: File): Promise<string | null>;
  onActivate(sceneId: string): void;
  onMode(sceneId: string, mode: "fan" | "analyst" | null): void;
  onRename(sceneId: string, name: string): void;
  onClose(): void;
  /** The team sheets, for choosing the player a player card follows. */
  status?: MatchStatus | null;
  /** Vertical room, in pixels, kept free around the canvas. */
  reserve?: number;
}

/** Arranges one scene: add widgets, restack them, move them on the canvas and change their settings. */
export function EditLayout({
  scene, studio, data, selectedId, onSelect, onChange, onUpload, onActivate, onMode, onRename, onClose, status = null, reserve,
}: EditLayoutProps) {
  const styles = useStyles();
  const [frame, scale] = useStageScale(reserve);
  const onAir = scene.id === studio.active_scene_id;
  const defaultMode = studio.settings.mode === "fan" ? "Fan" : "Analyst";

  return (
    <section className={styles.layout} aria-label="Edit layout">
      <div className={styles.header}>
        <span className={styles.headerIcon} aria-hidden><SlideLayoutRegular /></span>
        <Text as="h2" weight="semibold" size={400}>{`Editing: ${scene.name}`}</Text>
        <span className={styles.grow} />
        {onAir ? (
          <Badge color="danger" icon={<LiveRegular />}>On the program</Badge>
        ) : (
          <>
            <Badge appearance="outline">Not on the program</Badge>
            <Button size="small" appearance="primary" icon={<PlayRegular />} aria-label={`Put ${scene.name} on the program`}
              onClick={() => onActivate(scene.id)}>
              Put on the program
            </Button>
          </>
        )}
        <Select size="small" aria-label="Commentary" value={scene.mode ?? ""}
          onChange={(_, choice) => onMode(scene.id, choice.value === "" ? null : (choice.value as "fan" | "analyst"))}>
          <option value="">{`Studio default (${defaultMode})`}</option>
          <option value="fan">Fan commentary</option>
          <option value="analyst">Analyst commentary</option>
        </Select>
        <Button appearance="primary" icon={<CheckmarkRegular />} aria-label="Close edit layout" onClick={onClose}>Done</Button>
      </div>
      <div className={styles.body}>
        <div className={styles.side}>
          <ElementLibrary scene={scene} onSelect={onSelect} onChange={onChange} />
          <Layers scene={scene} selectedId={selectedId} onSelect={onSelect} onChange={onChange} />
        </div>
        <div ref={frame} className={styles.frame}>
          <SceneCanvas key={scene.id} scene={scene} data={data} scale={scale} editable selectedId={selectedId}
            onSelect={onSelect} onChange={(elements) => onChange(snapMove(scene.elements, elements))} />
        </div>
        <div className={styles.side}>
          <Inspector scene={scene} selectedId={selectedId} onChange={onChange} onUpload={onUpload} status={status} onRename={onRename} />
        </div>
      </div>
    </section>
  );
}
