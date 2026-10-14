import { Field, makeStyles, Select, Switch, tokens } from "@fluentui/react-components";
import type { StudioSettings } from "../../contracts";
import { LANGUAGE_NAMES, LANGUAGES, type Language, type Mode } from "../../i18n";

const useStyles = makeStyles({
  panel: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
});

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

export const SettingsTool = SettingsPanel;
