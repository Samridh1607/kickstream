import {
  Button, DrawerBody, DrawerHeader, DrawerHeaderTitle, Field, makeStyles, OverlayDrawer, Select, tokens,
} from "@fluentui/react-components";
import type { Teams } from "../api";
import type { ViewerProfile } from "../contracts";
import { LANGUAGE_NAMES, LANGUAGES, type Language, t } from "../i18n";

const useStyles = makeStyles({
  body: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
});

interface PreferencesDrawerProps {
  open: boolean;
  profile: ViewerProfile;
  teams: Teams | null;
  onChange(profile: ViewerProfile): void;
  onClose(): void;
}

export function PreferencesDrawer({ open, profile, teams, onChange, onClose }: PreferencesDrawerProps) {
  const styles = useStyles();
  const language = profile.language;
  const clubs = teams ? [teams.home, teams.away] : [];
  const players = clubs.flatMap((club) => club.players);
  // A favorite saved for another match is not in these lists; show it as "None".
  const club = clubs.some((option) => option.id === profile.club) ? (profile.club ?? "") : "";
  const player = players.some((option) => option.id === profile.player) ? (profile.player ?? "") : "";

  return (
    <OverlayDrawer open={open} position="end" onOpenChange={(_, data) => !data.open && onClose()}>
      <DrawerHeader>
        <DrawerHeaderTitle action={<Button appearance="subtle" onClick={onClose}>{t(language, "close")}</Button>}>
          {t(language, "preferences")}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody className={styles.body}>
        <Field label={t(language, "favoriteClub")}>
          <Select value={club} onChange={(_, data) => onChange({ ...profile, club: data.value || null })}>
            <option value="">{t(language, "none")}</option>
            {clubs.map((option) => (
              <option key={option.id} value={option.id}>{option.name}</option>
            ))}
          </Select>
        </Field>
        <Field label={t(language, "favoritePlayer")}>
          <Select value={player} onChange={(_, data) => onChange({ ...profile, player: data.value || null })}>
            <option value="">{t(language, "none")}</option>
            {players.map((option) => (
              <option key={option.id} value={option.id}>{option.name}</option>
            ))}
          </Select>
        </Field>
        <Field label={t(language, "language")}>
          <Select value={language} onChange={(_, data) => onChange({ ...profile, language: data.value as Language })}>
            {LANGUAGES.map((option) => (
              <option key={option} value={option}>{LANGUAGE_NAMES[option]}</option>
            ))}
          </Select>
        </Field>
      </DrawerBody>
    </OverlayDrawer>
  );
}
