import { Badge, makeStyles, mergeClasses, Text, tokens } from "@fluentui/react-components";
import { useEffect, useRef } from "react";
import { type Language, t } from "../i18n";
import type { FeedNarrative } from "../stream/store";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, minHeight: 0 },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, overflowY: "auto" },
  card: {
    display: "flex", flexDirection: "column", alignItems: "flex-start", gap: tokens.spacingVerticalXS, width: "100%",
    padding: tokens.spacingVerticalM, textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit",
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground1,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderLeft: `${tokens.strokeWidthThickest} solid ${tokens.colorNeutralStroke2}`,
  },
  highlighted: { borderLeftColor: tokens.colorPaletteYellowBorderActive, backgroundColor: tokens.colorPaletteYellowBackground1 },
  selected: { border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke1}`, boxShadow: tokens.shadow4 },
  badges: { display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalXS },
});

interface NarrativeFeedProps {
  narratives: FeedNarrative[];
  selectedId: string | null;
  language: Language;
  onSelect(momentId: string): void;
}

export function NarrativeFeed({ narratives, selectedId, language, onSelect }: NarrativeFeedProps) {
  const styles = useStyles();
  const selected = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    selected.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  return (
    <section className={styles.root} aria-label={t(language, "feed")}>
      <Text as="h2" weight="semibold">
        {t(language, "feed")}
      </Text>
      {narratives.length === 0 ? (
        <Text>{t(language, "feedEmpty")}</Text>
      ) : (
        <ol className={styles.list}>
          {narratives.map((narrative) => {
            const isSelected = narrative.moment_id === selectedId;
            return (
              <li key={narrative.id}>
                <button type="button" ref={isSelected ? selected : undefined} aria-pressed={isSelected}
                  data-highlighted={narrative.highlighted}
                  className={mergeClasses(styles.card, narrative.highlighted && styles.highlighted, isSelected && styles.selected)}
                  onClick={() => onSelect(narrative.moment_id)}>
                  <span className={styles.badges}>
                    <Badge appearance="outline">{narrative.minute}'</Badge>
                    {narrative.source === "scripted" && <Badge appearance="tint" color="subtle">{t(language, "scripted")}</Badge>}
                    {narrative.highlighted && <Badge appearance="tint" color="warning">{t(language, "highlighted")}</Badge>}
                  </span>
                  <Text>{narrative.text}</Text>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
