import { useCallback, useEffect, useRef, useState } from "react";
import { fetchCurrentMatch, streamUrl } from "../api";
import type { ViewerProfile } from "../contracts";
import { batched } from "./batch";
import { connect } from "./client";
import { useMatch } from "./store";

export interface CurrentMatchOptions {
  /** Injected by tests; the browser's EventSource is used otherwise. */
  eventSource?: new (url: string) => EventSource;
  /** Delay before retrying when the server cannot be reached. */
  retryMs?: number;
  /** How often to check for a new match while there is none, or the current one has finished. */
  pollMs?: number;
  /**
   * How long envelopes are gathered before the page draws them together. A match sends hundreds in
   * a burst when a page joins late; drawing each would leave the page seconds behind. With an
   * injected source (a test's) each envelope is applied as it arrives.
   */
  batchMs?: number;
}

/**
 * Follows whichever match the server considers current and keeps one stream open for the
 * given profile, feeding the shared match store. With a null profile no stream is opened.
 */
export function useCurrentMatch(
  profile: ViewerProfile | null,
  { eventSource, retryMs = 2000, pollMs = 3000, batchMs = eventSource ? 0 : 30 }: CurrentMatchOptions = {},
) {
  const [matchId, setMatchId] = useState<string | null>(null);
  // Bumped to reopen the stream for the same match after the server refused it.
  const [attempt, setAttempt] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // True once the server has answered what is current, so polling never races the first answer.
  const [answered, setAnswered] = useState(false);
  const connection = useMatch((state) => state.connection);
  const matchState = useMatch((state) => state.data.status?.state);

  const joinCurrent = useCallback(
    async (reopen = false) => {
      clearTimeout(retryTimer.current);
      try {
        const current = await fetchCurrentMatch();
        setAnswered(true);
        setMatchId(current);
        if (current === null) useMatch.getState().setConnection("idle");
        else if (reopen) setAttempt((count) => count + 1);
      } catch {
        useMatch.getState().setConnection("reconnecting");
        retryTimer.current = setTimeout(() => void joinCurrent(reopen), retryMs);
      }
    },
    [retryMs],
  );

  useEffect(() => () => clearTimeout(retryTimer.current), []);

  useEffect(() => {
    void joinCurrent();
  }, [joinCurrent]);

  // One stream per (match, profile). Changing either replays the match in the new variant.
  useEffect(() => {
    if (matchId === null || profile === null) return;
    const { applyAll, reset, setConnection } = useMatch.getState();
    reset();
    const gathered = batched(applyAll, batchMs);
    const close = connect(streamUrl(matchId, profile), { onEnvelope: gathered.add, onConnection: setConnection }, eventSource);
    return () => {
      close();
      gathered.cancel();
    };
  }, [matchId, profile, eventSource, attempt, batchMs]);

  // A replaced match: move to the current one.
  useEffect(() => {
    if (matchState === "abandoned") void joinCurrent();
  }, [matchState, joinCurrent]);

  // A stream the server refused stays closed. After a pause, ask what is current and reopen.
  useEffect(() => {
    if (connection !== "no_match") return;
    const timer = setTimeout(() => void joinCurrent(true), retryMs);
    return () => clearTimeout(timer);
  }, [connection, joinCurrent, retryMs]);

  // With no match, or a finished one, nothing more will arrive: check now and then for the next.
  const waiting = answered && (matchId === null || matchState === "finished");
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void joinCurrent(), pollMs);
    return () => clearInterval(timer);
  }, [waiting, joinCurrent, pollMs]);

  return { matchId, setMatchId };
}
