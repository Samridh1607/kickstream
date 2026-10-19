import { Button, Field, Input, makeStyles, MessageBar, MessageBarBody, Select, Switch, Text, tokens } from "@fluentui/react-components";
import { useEffect, useState } from "react";
import { listDevices, type MediaDeps, type NamedDevice } from "../../calls/thisComputer";
import type { LocalCamera, StudioSettings } from "../../contracts";
import { LANGUAGE_NAMES, LANGUAGES, type Language, type Mode } from "../../i18n";

const useStyles = makeStyles({
  panel: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  section: {
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, paddingTop: tokens.spacingVerticalM,
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  muted: { color: tokens.colorNeutralForeground3 },
});

// --- this computer's camera ----------------------------------------------------------------------

const OFF: LocalCamera = { enabled: false, camera: null, microphone: null, name: "" };

/** Your own camera and microphone on the program, straight from this computer, with no call service. */
function ThisComputerSection({ settings, onSave, media }: { settings: StudioSettings; onSave(settings: StudioSettings): void; media?: MediaDeps }) {
  const styles = useStyles();
  const local = settings.local_camera ?? OFF;
  const [cameras, setCameras] = useState<NamedDevice[]>([]);
  const [microphones, setMicrophones] = useState<NamedDevice[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState(local.name);
  useEffect(() => setName(local.name), [local.name]);

  const save = (patch: Partial<LocalCamera>) => onSave({ ...settings, local_camera: { ...local, ...patch } });
  const find = async () => {
    try {
      const found = await listDevices(media);
      setCameras(found.cameras);
      setMicrophones(found.microphones);
      setProblem(found.cameras.length === 0 ? "No camera was found on this computer." : null);
    } catch (caught) {
      setProblem(`The camera and microphone could not be used (${caught instanceof Error ? caught.message : "unknown reason"}). Allow them for this page in the browser's address bar.`);
    }
  };
  useEffect(() => {
    if (local.enabled) void find();
    // Listed once when the section opens with the camera on; "Find devices" lists them again.
  }, []);

  // A saved device that is not plugged in still shows, so the choice is not lost.
  const options = (devices: NamedDevice[], saved: string | null | undefined) => {
    const listed = devices.map((device) => ({ value: device.name, label: device.name }));
    return saved && !devices.some((device) => device.name === saved) ? [...listed, { value: saved, label: `${saved} (not found)` }] : listed;
  };

  return (
    <section className={styles.section} aria-label="This computer's camera">
      <Text weight="semibold">This computer's camera and microphone</Text>
      <Text size={200} className={styles.muted}>
        Puts you on the program in a camera circle, with your voice on the stream, straight from this computer: no guest call
        is needed. It works where Kickstream itself runs, so on your own computer, not on a server.
      </Text>
      <Switch label="Show my camera and use my microphone" checked={local.enabled}
        onChange={(_, data) => {
          save({ enabled: data.checked });
          if (data.checked) void find();
        }} />
      <Field label="Camera">
        <Select value={local.camera ?? ""} onChange={(_, data) => save({ camera: data.value || null })}>
          <option value="">Default camera</option>
          {options(cameras, local.camera).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
      </Field>
      <Field label="Microphone">
        <Select value={local.microphone ?? ""} onChange={(_, data) => save({ microphone: data.value || null })}>
          <option value="">Default microphone</option>
          {options(microphones, local.microphone).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
      </Field>
      <Field label="Name tag">
        <Input value={name} maxLength={60} placeholder="Me" onChange={(_, data) => setName(data.value)}
          onBlur={() => name !== local.name && save({ name })} />
      </Field>
      <Button onClick={() => void find()}>Find devices</Button>
      {problem && <MessageBar intent="warning"><MessageBarBody>{problem}</MessageBarBody></MessageBar>}
    </section>
  );
}

// --- settings ----------------------------------------------------------------------------------

export function SettingsPanel({ settings, onSave, media }: { settings: StudioSettings; onSave(settings: StudioSettings): void; media?: MediaDeps }) {
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
      <ThisComputerSection settings={settings} onSave={onSave} media={media} />
    </div>
  );
}

export const SettingsTool = SettingsPanel;
