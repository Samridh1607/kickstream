import { Badge, makeStyles, mergeClasses, Text, tokens } from "@fluentui/react-components";
import {
  ChevronRightRegular, FilmstripRegular, LiveRegular, PollRegular, RecordRegular, SportSoccerRegular, TimerRegular,
} from "@fluentui/react-icons";
import type { ReactNode } from "react";
import type { Broadcast } from "../contracts";
import { broadcastPath } from "./api";
import { duration, onAir, plural, STATE, when } from "./format";

const useStyles = makeStyles({
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  row: {
    display: "flex", alignItems: "center", gap: tokens.spacingHorizontalL, padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge, color: "inherit", textDecorationLine: "none",
    backgroundColor: tokens.colorNeutralBackground3, border: `${tokens.strokeWidthThin} solid transparent`,
    transitionProperty: "background-color, border-color, transform", transitionDuration: tokens.durationFaster,
    ":hover": { backgroundColor: tokens.colorNeutralBackground3Hover, border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke2}` },
    ":focus-visible": { outline: `${tokens.strokeWidthThick} solid ${tokens.colorStrokeFocus2}` },
  },
  cover: {
    position: "relative", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    width: "96px", height: "54px", borderRadius: tokens.borderRadiusMedium, color: "#FFFFFF", fontSize: "24px",
    backgroundImage: "linear-gradient(135deg, #3A1A78 0%, #6528CF 100%)",
  },
  coverLive: { backgroundImage: "linear-gradient(135deg, #912018 0%, #D92D20 100%)" },
  coverEnded: { backgroundImage: "linear-gradient(135deg, #1D2939 0%, #475467 100%)" },
  text: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0, flexGrow: 1 },
  titleRow: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS, minWidth: 0 },
  facts: { display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: tokens.spacingHorizontalM, rowGap: "2px", color: tokens.colorNeutralForeground3 },
  fact: { display: "inline-flex", alignItems: "center", gap: "4px", fontSize: tokens.fontSizeBase200 },
  chevron: { color: tokens.colorNeutralForeground3, fontSize: "20px", flexShrink: 0 },
  empty: { display: "flex", flexDirection: "column", alignItems: "center", gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalXXL, textAlign: "center", color: tokens.colorNeutralForeground3 },
  emptyIcon: { fontSize: "40px", color: tokens.colorBrandForeground2 },
});

function Fact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  const styles = useStyles();
  return <span className={styles.fact}>{icon}{children}</span>;
}

/** Every broadcast, newest first, each leading to its page. */
export function BroadcastList({ broadcasts, now, empty }: { broadcasts: Broadcast[]; now: number; empty?: ReactNode }) {
  const styles = useStyles();
  if (broadcasts.length === 0) {
    return (
      <div className={styles.empty}>
        <FilmstripRegular className={styles.emptyIcon} />
        <Text weight="semibold">No broadcasts yet</Text>
        <Text size={200}>Each broadcast keeps its live sessions, recording and stats, and AI agents turn it into reels.</Text>
        {empty}
      </div>
    );
  }
  return (
    <ul className={styles.list}>
      {broadcasts.map((broadcast) => {
        const state = STATE[broadcast.state];
        const live = broadcast.state === "live";
        const ready = broadcast.reels.filter((reel) => reel.state === "ready").length;
        return (
          <li key={broadcast.id}>
            <a href={broadcastPath(broadcast.id)} className={styles.row} aria-label={`${broadcast.title}, ${state.label}`}>
              <span className={mergeClasses(styles.cover, live && styles.coverLive, broadcast.state === "ended" && styles.coverEnded)} aria-hidden>
                {live ? <LiveRegular /> : broadcast.state === "ended" ? <FilmstripRegular /> : <RecordRegular />}
              </span>
              <span className={styles.text}>
                <span className={styles.titleRow}>
                  <Text weight="semibold" truncate wrap={false}>{broadcast.title}</Text>
                  <Badge size="small" appearance={live ? "filled" : "tint"} color={state.color}>{state.label}</Badge>
                </span>
                <span className={styles.facts}>
                  <Fact icon={<TimerRegular />}>{when(broadcast.created_at)}</Fact>
                  {broadcast.sessions.length > 0 && <Fact icon={<LiveRegular />}>{duration(onAir(broadcast, now))} on air</Fact>}
                  {broadcast.recordings.length > 0 && <Fact icon={<RecordRegular />}>{plural(broadcast.recordings.length, "recording")}</Fact>}
                  {ready > 0 && <Fact icon={<FilmstripRegular />}>{plural(ready, "reel")}</Fact>}
                  {broadcast.stats.polls.length > 0 && <Fact icon={<PollRegular />}>{plural(broadcast.stats.polls.length, "poll")}</Fact>}
                  {broadcast.stats.score && (
                    <Fact icon={<SportSoccerRegular />}>
                      {`${broadcast.stats.score.home} ${broadcast.stats.score.score_home}–${broadcast.stats.score.score_away} ${broadcast.stats.score.away}`}
                    </Fact>
                  )}
                </span>
              </span>
              <ChevronRightRegular className={styles.chevron} />
            </a>
          </li>
        );
      })}
    </ul>
  );
}
