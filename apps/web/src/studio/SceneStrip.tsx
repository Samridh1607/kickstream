import {
  Badge, Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, DialogTrigger, Field, Input,
  makeStyles, Menu, MenuDivider, MenuGroup, MenuGroupHeader, MenuItem, MenuItemRadio, MenuList, MenuPopover, MenuTrigger,
  mergeClasses, Text, tokens,
} from "@fluentui/react-components";
import { AddRegular, CopyRegular, DeleteRegular, EditRegular, MoreHorizontalRegular, RenameRegular, SaveRegular } from "@fluentui/react-icons";
import { type FormEvent, useState } from "react";
import type { Scene, Studio } from "../contracts";
import type { ProgramData } from "./elements";
import { CANVAS } from "./geometry";
import { ModeBadge, sceneIcon } from "./panels";
import { SceneCanvas } from "./SceneCanvas";

export const BUILTIN_TEMPLATES = ["Starting soon", "Live match", "Analyst desk", "Break", "Full-time", "Interview", "Match intelligence", "Fan zone"];

const THUMB_WIDTH = 168;
const THUMB_SCALE = THUMB_WIDTH / CANVAS.width;
const NAME_MAX = 60;
const DEFAULT_MODE = "default";

const useStyles = makeStyles({
  // The scenes sit in one row under the stage and scroll sideways when there are many.
  strip: {
    listStyleType: "none", margin: 0, padding: `0 0 ${tokens.spacingVerticalXS}`, display: "flex", flexWrap: "nowrap",
    gap: tokens.spacingHorizontalS, overflowX: "auto", scrollSnapType: "x proximity", maxHeight: "150px",
  },
  tile: {
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXXS, padding: tokens.spacingVerticalXXS,
    width: "176px", flexShrink: 0, boxSizing: "border-box", scrollSnapAlign: "start",
    borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground3,
    border: `${tokens.strokeWidthThick} solid transparent`,
    transitionProperty: "border-color, background-color, box-shadow", transitionDuration: "160ms",
    ":hover": { boxShadow: tokens.shadow4 },
  },
  editing: { border: `${tokens.strokeWidthThick} solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorNeutralBackground1 },
  onAir: { border: `${tokens.strokeWidthThick} solid #D92D20`, backgroundColor: tokens.colorNeutralBackground1 },
  thumb: { position: "relative", borderRadius: tokens.borderRadiusMedium, overflow: "hidden", width: `${THUMB_WIDTH}px` },
  // Laid over the picture rather than around it: a widget in the scene may draw buttons of its own,
  // and a button must not hold another.
  switch: {
    position: "absolute", top: 0, right: 0, bottom: 0, left: 0, padding: 0, margin: 0, border: "none",
    borderRadius: tokens.borderRadiusMedium, cursor: "pointer", backgroundColor: "transparent",
    ":focus-visible": { outline: `${tokens.strokeWidthThick} solid ${tokens.colorStrokeFocus2}`, outlineOffset: `-${tokens.strokeWidthThick}` },
  },
  live: { cursor: "default" },
  canvas: { pointerEvents: "none" },
  number: {
    position: "absolute", left: tokens.spacingHorizontalXS, top: tokens.spacingVerticalXS, minWidth: "18px", height: "18px",
    display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: tokens.borderRadiusCircular,
    fontSize: tokens.fontSizeBase100, fontWeight: tokens.fontWeightSemibold, color: "#FFFFFF", backgroundColor: "rgba(0, 0, 0, 0.6)",
  },
  onAirBadge: { position: "absolute", right: tokens.spacingHorizontalXS, top: tokens.spacingVerticalXS },
  mode: { position: "absolute", left: tokens.spacingHorizontalXS, bottom: tokens.spacingVerticalXS },
  row: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS, minWidth: 0 },
  name: { flexGrow: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  add: {
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: tokens.spacingVerticalXS,
    width: "120px", flexShrink: 0, height: "auto",
    borderTopStyle: "dashed", borderRightStyle: "dashed", borderBottomStyle: "dashed", borderLeftStyle: "dashed",
  },
  gallery: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: tokens.spacingHorizontalS },
  choice: { justifyContent: "flex-start" },
  saved: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS },
  section: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
});

interface SceneStripProps {
  studio: Studio;
  data: ProgramData;
  /** The scene open in Edit layout, if any. */
  editingId: string | null;
  onActivate(sceneId: string): void;
  onEdit(sceneId: string): void;
  onRename(sceneId: string, name: string): void;
  onMode(sceneId: string, mode: "fan" | "analyst" | null): void;
  onCreate(source: "builtin" | "template" | "scene", ref: string): void;
  onDelete(sceneId: string): void;
  onSaveTemplate(sceneId: string): void;
  onDeleteTemplate(templateId: string): void;
}

export function SceneStrip(props: SceneStripProps) {
  const { studio, data, editingId, onActivate } = props;
  const styles = useStyles();
  const [renaming, setRenaming] = useState<Scene | null>(null);
  return (
    <section aria-label="Scenes">
      <ul className={styles.strip}>
        {studio.scenes.map((scene, index) => {
          const onAir = scene.id === studio.active_scene_id;
          return (
            <li key={scene.id} className={mergeClasses(styles.tile, scene.id === editingId && styles.editing, onAir && styles.onAir)}>
              <div className={styles.thumb}>
                <div className={styles.canvas} aria-hidden inert>
                  <SceneCanvas scene={scene} data={data} scale={THUMB_SCALE} />
                </div>
                <button type="button" className={mergeClasses(styles.switch, onAir && styles.live)} aria-label={`Switch to ${scene.name}`}
                  aria-pressed={onAir} onClick={() => !onAir && onActivate(scene.id)}>
                  {index < 9 && <span className={styles.number} data-testid="scene-number">{index + 1}</span>}
                  {onAir && <Badge className={styles.onAirBadge} size="small" color="danger">On air</Badge>}
                  <span className={styles.mode}><ModeBadge scene={scene} studio={studio} /></span>
                </button>
              </div>
              <div className={styles.row}>
                <Text size={200} weight="semibold" className={styles.name} title={scene.name}>{scene.name}</Text>
                <SceneMenu {...props} scene={scene} onAir={onAir} onRenaming={() => setRenaming(scene)} />
              </div>
            </li>
          );
        })}
        <li>
          <AddSceneDialog {...props} />
        </li>
      </ul>
      {renaming && (
        <RenameDialog key={renaming.id} scene={renaming} onClose={() => setRenaming(null)}
          onSave={(name) => { props.onRename(renaming.id, name); setRenaming(null); }} />
      )}
    </section>
  );
}

function SceneMenu({ studio, scene, onAir, onEdit, onMode, onCreate, onDelete, onSaveTemplate, onRenaming }: SceneStripProps & {
  scene: Scene; onAir: boolean; onRenaming(): void;
}) {
  return (
    <Menu checkedValues={{ commentary: [scene.mode ?? DEFAULT_MODE] }}
      onCheckedValueChange={(_, { checkedItems }) => {
        const mode = checkedItems[0];
        onMode(scene.id, mode === "fan" || mode === "analyst" ? mode : null);
      }}>
      <MenuTrigger disableButtonEnhancement>
        <Button size="small" appearance="subtle" icon={<MoreHorizontalRegular />} aria-label={`Scene menu for ${scene.name}`} />
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem icon={<EditRegular />} aria-label={`Edit ${scene.name}`} onClick={() => onEdit(scene.id)}>Edit layout</MenuItem>
          <MenuItem icon={<RenameRegular />} aria-label={`Rename ${scene.name}`} onClick={onRenaming}>Rename</MenuItem>
          <MenuItem icon={<CopyRegular />} aria-label={`Duplicate ${scene.name}`} onClick={() => onCreate("scene", scene.id)}>Duplicate</MenuItem>
          <MenuItem icon={<SaveRegular />} aria-label={`Save ${scene.name} as template`} onClick={() => onSaveTemplate(scene.id)}>Save as template</MenuItem>
          <MenuItem icon={<DeleteRegular />} aria-label={`Delete ${scene.name}`} disabled={onAir || studio.scenes.length === 1}
            onClick={() => onDelete(scene.id)}>Delete</MenuItem>
          <MenuDivider />
          <MenuGroup>
            <MenuGroupHeader>Commentary</MenuGroupHeader>
            <MenuItemRadio name="commentary" value={DEFAULT_MODE}>Studio default commentary</MenuItemRadio>
            <MenuItemRadio name="commentary" value="fan">Fan commentary</MenuItemRadio>
            <MenuItemRadio name="commentary" value="analyst">Analyst commentary</MenuItemRadio>
          </MenuGroup>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

function RenameDialog({ scene, onSave, onClose }: { scene: Scene; onSave(name: string): void; onClose(): void }) {
  const [draft, setDraft] = useState(scene.name);
  const name = draft.trim();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name !== "" && name !== scene.name) onSave(name);
  };
  return (
    <Dialog open onOpenChange={(_, data) => !data.open && onClose()}>
      <DialogSurface aria-label={`Rename ${scene.name}`}>
        <form onSubmit={submit}>
          <DialogBody>
            <DialogTitle>Rename scene</DialogTitle>
            <DialogContent>
              <Field label="Scene name">
                <Input value={draft} maxLength={NAME_MAX} autoFocus onChange={(_, data) => setDraft(data.value)} />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onClose}>Cancel</Button>
              <Button type="submit" appearance="primary" disabled={name === "" || name === scene.name}>Save</Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}

function AddSceneDialog({ studio, onCreate, onDeleteTemplate }: SceneStripProps) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const create = (source: "builtin" | "template", ref: string) => {
    onCreate(source, ref);
    setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={(_, data) => setOpen(data.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button className={styles.add} icon={<AddRegular />} aria-label="Add scene">Scene</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Add a scene</DialogTitle>
          <DialogContent className={styles.section}>
            <div className={styles.gallery}>
              {BUILTIN_TEMPLATES.map((name) => (
                <Button key={name} className={styles.choice} icon={sceneIcon({ id: name, name, template: name, elements: [] })}
                  aria-label={`Add scene from ${name}`} onClick={() => create("builtin", name)}>
                  {name}
                </Button>
              ))}
            </div>
            {studio.templates.length > 0 && (
              <>
                <Text weight="semibold">Saved templates</Text>
                <ul className={styles.saved} aria-label="Saved templates">
                  {studio.templates.map((template) => (
                    <li key={template.id} className={styles.row}>
                      <Button className={mergeClasses(styles.choice, styles.name)} aria-label={`Add scene from ${template.name} (saved)`}
                        onClick={() => create("template", template.id)}>
                        {template.name}
                      </Button>
                      <Button appearance="subtle" icon={<DeleteRegular />} aria-label={`Delete template ${template.name}`}
                        onClick={() => onDeleteTemplate(template.id)} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Close</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
