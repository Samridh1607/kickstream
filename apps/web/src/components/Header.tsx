import { Badge, Button, makeStyles, Select, Text, tokens } from "@fluentui/react-components";
import type { MatchStatus, ViewerProfile } from "../contracts";
import { LANGUAGE_NAMES, LANGUAGES, type Language, type StringKey, t } from "../i18n";
import type { Connection } from "../stream/store";

const useStyles = makeStyles({
  root: {
    display: "flex", alignItems: "center", flexWrap: "wrap", gap: tokens.spacingHorizontalL,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXL}`,
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  summary: { display: "flex", flexDirection: "column", alignItems: "center", gap: tokens.spacingVerticalXXS, flexGrow: 1 },
  scoreboard: { display: "flex", alignItems: "center", justifyContent: "center", gap: tokens.spacingHorizontalM },
  source: { display: "flex", gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground3 },
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
  onLanguageChange(language: Language): void;
  onOpenPreferences(): void;
  onStart(): void;
  onChoose(): void;
}

export function Header({ status, connection, profile, onLanguageChange, onOpenPreferences, onStart, onChoose }: HeaderProps) {
  const styles = useStyles();
  const language = profile.language;
  const state = CONNECTION[connection];
  const credited = status && (status.competition || status.credit);
  return (
    <header className={styles.root}>
      <Text as="h1" size={500} weight="semibold">
        {t(language, "matchData")}
      </Text>
      <div className={styles.summary}>
        <div className={styles.scoreboard}>
          {status ? (
            <>
              <Text weight="semibold">{status.home.name}</Text>
              <Text size={700} weight="bold" data-testid="score">
                {status.score_home} - {status.score_away}
              </Text>
              <Text weight="semibold">{status.away.name}</Text>
              <Badge appearance="outline">{status.state === "pre_match" ? t(language, "preMatch") : `${status.minute}'`}</Badge>
            </>
          ) : (
            <Text>{t(language, "noMatch")}</Text>
          )}
          <Badge color={state.color}>{t(language, state.label)}</Badge>
        </div>
        {credited && (
          <div className={styles.source} data-testid="match-source">
            {status.competition && <Text size={200}>{status.competition}</Text>}
            {status.credit && <Text size={200}>{status.credit}</Text>}
          </div>
        )}
      </div>
      <div className={styles.controls}>
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
        <Button onClick={onChoose}>{t(language, "chooseMatch")}</Button>
        <Button appearance="primary" onClick={onStart}>
          {t(language, status ? "restart" : "start")}
        </Button>
      </div>
    </header>
  );
}
