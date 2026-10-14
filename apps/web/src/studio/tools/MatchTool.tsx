import { Button, makeStyles, MessageBar, MessageBarBody, Text, tokens } from "@fluentui/react-components";
import { useCallback, useEffect, useState } from "react";
import { speedFromLocation } from "../../api";
import type { Sources } from "../../contracts";
import { fetchSources, stopMatch } from "../../matches/api";
import { MatchPicker, sourceName } from "../../matches/MatchPicker";

const POLL_MS = 10_000;

const useStyles = makeStyles({
  panel: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  item: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  muted: { color: tokens.colorNeutralForeground3 },
});

interface MatchToolProps {
  /** Called with the new match's id once the server has started it. */
  onStarted(matchId: string): void;
  /** How often the running match is read again. */
  pollMs?: number;
}

/** The match playing now, with Stop, and the picker for the next one. */
export function MatchTool({ onStarted, pollMs = POLL_MS }: MatchToolProps) {
  const styles = useStyles();
  const [sources, setSources] = useState<Sources | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

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
      <MatchPicker sources={sources} extraSpeed={speedFromLocation(window.location.search)}
        onStarted={(matchId) => {
          onStarted(matchId);
          void refresh();
        }} />
    </div>
  );
}
