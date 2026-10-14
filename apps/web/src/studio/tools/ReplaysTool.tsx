import { Button, makeStyles, Text, tokens } from "@fluentui/react-components";
import { type StringKey, t } from "../../i18n";
import type { FeedMoment, FeedNarrative, MatchData } from "../../stream/store";

const useStyles = makeStyles({
  panel: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  item: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalXS },
});

// --- highlights --------------------------------------------------------------------------------

interface HighlightsPanelProps {
  match: MatchData;
  replaying: boolean;
  onReplay(moment: FeedMoment): void;
  onStopReplay(): void;
  onBanner(narrative: FeedNarrative): void;
}

export function HighlightsPanel({ match, replaying, onReplay, onStopReplay, onBanner }: HighlightsPanelProps) {
  const styles = useStyles();
  const newestFirst = [...match.moments].reverse();
  return (
    <div className={styles.panel}>
      {replaying && <Button onClick={onStopReplay}>Stop replay</Button>}
      {newestFirst.length === 0 && <Text size={200}>Key moments appear here as the match is played.</Text>}
      <ul className={styles.list}>
        {newestFirst.map((moment) => {
          const label = `${moment.minute}' ${t("en", `kind_${moment.kind}` as StringKey)}`;
          const narrative = match.narratives.find((line) => line.moment_id === moment.id);
          return (
            <li key={moment.id} className={styles.item}>
              <Text weight="semibold">{label}</Text>
              {narrative && <Text size={200}>{narrative.text}</Text>}
              <div className={styles.row}>
                <Button size="small" aria-label={`Replay ${label}`} onClick={() => onReplay(moment)}>Replay</Button>
                {narrative && (
                  <Button size="small" aria-label={`Show ${label} on banner`} onClick={() => onBanner(narrative)}>Show on banner</Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export const ReplaysTool = HighlightsPanel;
