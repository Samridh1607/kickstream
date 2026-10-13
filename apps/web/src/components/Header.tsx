import { Badge, Button, makeStyles, Select, Tab, TabList, Text, tokens } from "@fluentui/react-components";
import type { MatchStatus, ViewerProfile } from "../contracts";
import { LANGUAGE_NAMES, LANGUAGES, type Language, type Mode, type StringKey, t } from "../i18n";
import type { Connection } from "../stream/store";

const useStyles = makeStyles({
  root: {
    display: "flex", alignItems: "center", flexWrap: "wrap", gap: tokens.spacingHorizontalL,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXL}`,
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  scoreboard: { display: "flex", alignItems: "center", justifyContent: "center", gap: tokens.spacingHorizontalM, flexGrow: 1 },
  controls: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
});

const CONNECTION: Record<Connection, { label: StringKey; color: "success" | "warning" | "informative" | "subtle" }> = {
  idle: { label: "idle", color: "subtle" },
  no_match: { label: "idle", color: "subtle" },
  connecting: { label: "connecting", color: "informative" },
  live: { label: "live", color: "success" },
  reconnecting: { label: "reconnecting", color: "warning" },
};

interface HeaderProps {
  status: MatchStatus | null;
  connection: Connection;
  profile: ViewerProfile;
  onModeChange(mode: Mode): void;
  onLanguageChange(language: Language): void;
  onOpenPreferences(): void;
  onStart(): void;
}

export function Header({ status, connection, profile, onModeChange, onLanguageChange, onOpenPreferences, onStart }: HeaderProps) {
  const styles = useStyles();
  const language = profile.language;
  const state = CONNECTION[connection];
  return (
    <header className={styles.root}>
      <Text as="h1" size={500} weight="semibold">
        {t(language, "matchData")}
      </Text>
      <div className={styles.scoreboard}>
        {status ? (
          <>
            <Text weight="semibold">{status.home.name}</Text>
            <Text size={700} weight="bold" data-testid="score">
              {status.score_home} - {status.score_away}
            </Text>
            <Text weight="semibold">{status.away.name}</Text>
            <Badge appearance="outline">{status.minute}'</Badge>
          </>
        ) : (
          <Text>{t(language, "noMatch")}</Text>
        )}
        <Badge color={state.color}>{t(language, state.label)}</Badge>
      </div>
      <div className={styles.controls}>
        <TabList
          size="small"
          aria-label={t(language, "mode")}
          selectedValue={profile.mode}
          onTabSelect={(_, data) => onModeChange(data.value as Mode)}
        >
          <Tab value="fan">{t(language, "fan")}</Tab>
          <Tab value="analyst">{t(language, "analyst")}</Tab>
        </TabList>
        <Select
          aria-label={t(language, "language")}
          value={language}
          onChange={(_, data) => onLanguageChange(data.value as Language)}
        >
          {LANGUAGES.map((option) => (
            <option key={option} value={option}>
              {LANGUAGE_NAMES[option]}
            </option>
          ))}
        </Select>
        <Button onClick={onOpenPreferences}>{t(language, "preferences")}</Button>
        <Button appearance="primary" onClick={onStart}>
          {t(language, status ? "restart" : "start")}
        </Button>
      </div>
    </header>
  );
}
