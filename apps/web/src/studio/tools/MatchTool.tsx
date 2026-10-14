import { Button, makeStyles, MessageBar, MessageBarBody, Text, tokens } from "@fluentui/react-components";
import { useCallback, useEffect, useState } from "react";
import { speedFromLocation } from "../../api";
import type { QueuedMatch, Sources, Studio } from "../../contracts";
import { fetchSources, speedLabel, stopMatch } from "../../matches/api";
import { MatchPicker, sourceName } from "../../matches/MatchPicker";
import { queueMatch } from "../api";

const POLL_MS = 10_000;

const useStyles = makeStyles({
  panel: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  item: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  muted: { color: tokens.colorNeutralForeground3 },
});

const sameMatch = (a: QueuedMatch, b: QueuedMatch) => a.source === b.source && (a.ref ?? null) === (b.ref ?? null) && a.speed === b.speed;

/** What the next match is and how it plays: its source when it has a title, and its speed unless it is live. */
function queuedDetail(queued: QueuedMatch): string {
  const paced = queued.source === "simulated" || queued.source === "statsbomb";
  return [queued.title ? sourceName("en", queued.source) : null, paced ? speedLabel(queued.speed) : null].filter(Boolean).join(" · ");
}

interface MatchToolProps {
  studio: Studio;
  /** Sends one studio change as the studio page does. */
  onRun(request: () => Promise<Studio>): Promise<boolean>;
  /** Called with the new match's id once the server has started it. */
  onStarted(matchId: string): void;
  /** How often the running match is read again. */
  pollMs?: number;
}

/** The match playing now, with Stop, the match the countdown will start, and the picker for the next one. */
export function MatchTool({ studio, onRun, onStarted, pollMs = POLL_MS }: MatchToolProps) {
  const styles = useStyles();
  const [sources, setSources] = useState<Sources | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const queued = studio.settings.queued_match ?? null;

  const refresh = useCallback(async () => {
    try {
      setSources(await fetchSources());
      setProblem(null);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The match sources could not be read.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollMs);
    return () => window.clearInterval(timer);
  }, [refresh, pollMs]);

  const stop = async () => {
    setStopping(true);
    try {
      await stopMatch();
      await refresh();
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The match could not be stopped.");
    } finally {
      setStopping(false);
    }
  };

  const keep = (choice: QueuedMatch) => {
    if (queued === null || !sameMatch(queued, choice)) void onRun(() => queueMatch(choice));
  };

  const running = sources?.running;
  return (
    <div className={styles.panel}>
      {problem && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>{problem}</MessageBarBody>
        </MessageBar>
      )}
      {running && (
        <section aria-label="Now playing" className={styles.item}>
          <Text size={200} className={styles.muted}>Now playing</Text>
          <Text weight="semibold">{running.title ?? running.match_id}</Text>
          <Text size={200}>{sourceName("en", running.source)}</Text>
          {running.problem && (
            <MessageBar intent="warning" layout="multiline">
              <MessageBarBody>{running.problem}</MessageBarBody>
            </MessageBar>
          )}
          <Button size="small" disabled={stopping} onClick={() => void stop()}>Stop match</Button>
        </section>
      )}
      {queued && (
        <section aria-label="Next match" className={styles.item}>
          <Text size={200} className={styles.muted}>Starts when the countdown ends</Text>
          <Text weight="semibold">{queued.title ?? sourceName("en", queued.source)}</Text>
          <Text size={200}>{queuedDetail(queued)}</Text>
          {!studio.settings.auto_start && (
            <Text size={200} className={styles.muted}>Automatic start is off in Settings.</Text>
          )}
          <Button size="small" onClick={() => void onRun(() => queueMatch(null))}>Clear</Button>
        </section>
      )}
      <MatchPicker sources={sources} extraSpeed={speedFromLocation(window.location.search)} onChoose={keep}
        onStarted={(matchId) => {
          onStarted(matchId);
          void refresh();
        }} />
    </div>
  );
}
