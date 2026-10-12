import { makeStyles, mergeClasses, Text, tokens } from "@fluentui/react-components";
import type { Recap } from "../contracts";
import { type Language, type StringKey, t } from "../i18n";
import type { FeedMoment } from "../stream/store";

const MATCH_MINUTES = 90;

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  track: { position: "relative", height: "32px", borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  marker: {
    position: "absolute", top: "6px", width: "20px", height: "20px", marginLeft: "-10px", padding: 0, cursor: "pointer",
    borderRadius: tokens.borderRadiusCircular, border: `${tokens.strokeWidthThick} solid ${tokens.colorNeutralBackground1}`,
    backgroundColor: tokens.colorBrandBackground,
  },
  goal: { backgroundColor: tokens.colorPaletteGreenBackground3 },
  card: { backgroundColor: tokens.colorPaletteRedBackground3 },
  highlighted: { outline: `${tokens.strokeWidthThick} solid ${tokens.colorPaletteYellowBorderActive}` },
  selected: { boxShadow: tokens.shadow8, transform: "scale(1.25)" },
  recap: {
    position: "absolute", top: "4px", height: "24px", marginLeft: "-12px", padding: `0 ${tokens.spacingHorizontalXS}`,
    cursor: "pointer", borderRadius: tokens.borderRadiusSmall, border: "none", fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForegroundOnBrand, backgroundColor: tokens.colorNeutralForeground2,
  },
});

interface TimelineProps {
  moments: FeedMoment[];
  recaps: Recap[];
  selectedId: string | null;
  language: Language;
  onSelect(momentId: string): void;
  onOpenRecap(recap: Recap): void;
}

const position = (minute: number) => `${(Math.min(minute, MATCH_MINUTES) / MATCH_MINUTES) * 100}%`;

export function Timeline({ moments, recaps, selectedId, language, onSelect, onOpenRecap }: TimelineProps) {
  const styles = useStyles();
  return (
    <section className={styles.root} aria-label={t(language, "timeline")}>
      <Text as="h2" weight="semibold">
        {t(language, "timeline")}
      </Text>
      <div className={styles.track}>
        {moments.map((moment) => {
          const label = `${moment.minute}' ${t(language, `kind_${moment.kind}` as StringKey)}`;
          return (
            <button key={moment.id} type="button" aria-label={label} title={label}
              aria-pressed={moment.id === selectedId} data-highlighted={moment.highlighted}
              className={mergeClasses(styles.marker, moment.kind === "goal" && styles.goal,
                moment.kind === "red_card" && styles.card, moment.highlighted && styles.highlighted,
                moment.id === selectedId && styles.selected)}
              style={{ left: position(moment.minute) }} onClick={() => onSelect(moment.id)} />
          );
        })}
        {recaps.map((recap) => {
          const label = t(language, recap.period === "half_time" ? "halfTime" : "fullTime");
          return (
            <button key={recap.id} type="button" aria-label={label} title={label} className={styles.recap}
              style={{ left: position(recap.minute) }} onClick={() => onOpenRecap(recap)}>
              {recap.period === "half_time" ? "HT" : "FT"}
            </button>
          );
        })}
      </div>
    </section>
  );
}
