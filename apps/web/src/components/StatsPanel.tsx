import { makeStyles, Text, tokens } from "@fluentui/react-components";
import type { MatchStatus, StatsSnapshot, TeamStats } from "../contracts";
import { type Language, type StringKey, t } from "../i18n";

const ROWS: { field: keyof TeamStats; label: StringKey; id: string }[] = [
  { field: "possession", label: "possession", id: "possession" },
  { field: "shots", label: "shots", id: "shots" },
  { field: "shots_on_target", label: "shotsOnTarget", id: "shots-on-target" },
  { field: "xg", label: "xg", id: "xg" },
  { field: "pass_accuracy", label: "passAccuracy", id: "pass-accuracy" },
  { field: "pass_distance", label: "passDistance", id: "pass-distance" },
  { field: "pass_difficulty", label: "passDifficulty", id: "pass-difficulty" },
];
const PLACEHOLDER = "–";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  row: { display: "grid", gridTemplateColumns: "3rem 1fr 3rem", alignItems: "center", gap: tokens.spacingHorizontalS },
  away: { textAlign: "right" },
  middle: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXXS },
  label: { textAlign: "center", color: tokens.colorNeutralForeground2 },
  bar: { display: "flex", height: "6px", borderRadius: tokens.borderRadiusCircular, overflow: "hidden", backgroundColor: tokens.colorNeutralBackground4 },
  meter: { position: "relative", height: "8px", borderRadius: tokens.borderRadiusCircular, backgroundColor: tokens.colorNeutralBackground4 },
  needle: { position: "absolute", top: "-3px", width: "4px", height: "14px", borderRadius: tokens.borderRadiusSmall, backgroundColor: tokens.colorNeutralForeground1 },
});

interface StatsPanelProps {
  stats: StatsSnapshot | null;
  status: MatchStatus | null;
  language: Language;
}

export function StatsPanel({ stats, status, language }: StatsPanelProps) {
  const styles = useStyles();
  const homeColor = status?.home.color ?? tokens.colorBrandBackground;
  const awayColor = status?.away.color ?? tokens.colorPaletteRedBackground3;
  const momentum = stats?.momentum ?? 0;
  return (
    <section className={styles.root} aria-label={t(language, "stats")}>
      <Text as="h2" weight="semibold">
        {t(language, "stats")}
      </Text>
      {ROWS.map(({ field, label, id }) => {
        const home = stats?.home[field];
        const away = stats?.away[field];
        const total = (home ?? 0) + (away ?? 0);
        const share = total === 0 ? 50 : ((home ?? 0) / total) * 100;
        return (
          <div key={id} className={styles.row} data-testid={`stat-${id}`}>
            <Text weight="semibold">{home ?? PLACEHOLDER}</Text>
            <div className={styles.middle}>
              <Text size={200} className={styles.label}>
                {t(language, label)}
              </Text>
              <div className={styles.bar}>
                <div style={{ width: `${share}%`, backgroundColor: homeColor }} />
                <div style={{ width: `${100 - share}%`, backgroundColor: awayColor }} />
              </div>
            </div>
            <Text weight="semibold" className={styles.away}>
              {away ?? PLACEHOLDER}
            </Text>
          </div>
        );
      })}
      <Text size={200} className={styles.label}>
        {t(language, "momentum")}
      </Text>
      <div className={styles.meter} role="meter" aria-label={t(language, "momentum")} aria-valuemin={-1}
        aria-valuemax={1} aria-valuenow={momentum}>
        <div className={styles.needle} style={{ left: `calc(${((1 - momentum) / 2) * 100}% - 2px)` }} />
      </div>
    </section>
  );
}
