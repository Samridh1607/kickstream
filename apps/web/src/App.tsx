import { makeStyles, MessageBar, MessageBarBody, Switch, Tab, TabList, tokens } from "@fluentui/react-components";
import { useCallback, useEffect, useState } from "react";
import { fetchCurrentMatch, fetchTeams, speedFromLocation, startMatch, streamUrl, type Teams } from "./api";
import { Header } from "./components/Header";
import { NarrativeFeed } from "./components/NarrativeFeed";
import { OverlayTab } from "./components/OverlayTab";
import { PipelinePanel } from "./components/PipelinePanel";
import { Pitch } from "./components/Pitch";
import { PreferencesDrawer } from "./components/PreferencesDrawer";
import { RecapDialog } from "./components/RecapDialog";
import { StatsPanel } from "./components/StatsPanel";
import { Timeline } from "./components/Timeline";
import type { Recap, ViewerProfile } from "./contracts";
import { t } from "./i18n";
import { loadProfile, saveProfile } from "./prefs";
import { connect } from "./stream/client";
import { useMatch } from "./stream/store";

type View = "match" | "overlay";

const useStyles = makeStyles({
  app: { display: "flex", flexDirection: "column", minHeight: "100vh", backgroundColor: tokens.colorNeutralBackground2 },
  views: { padding: `0 ${tokens.spacingHorizontalXL}` },
  match: {
    display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)", gap: tokens.spacingHorizontalXL,
    padding: tokens.spacingHorizontalXL, alignItems: "start",
    "@media (max-width: 900px)": { gridTemplateColumns: "minmax(0, 1fr)" },
  },
  column: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
  panel: { padding: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow2 },
  feed: { maxHeight: "70vh", display: "flex", flexDirection: "column" },
});

interface AppProps {
  /** Injected by tests; the browser's EventSource is used otherwise. */
  eventSource?: new (url: string) => EventSource;
}

export function App({ eventSource }: AppProps) {
  const styles = useStyles();
  const [profile, setProfile] = useState<ViewerProfile>(loadProfile);
  const [matchId, setMatchId] = useState<string | null>(null);
  const [teams, setTeams] = useState<Teams | null>(null);
  const [view, setView] = useState<View>("match");
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [showPressure, setShowPressure] = useState(true);
  const [openRecap, setOpenRecap] = useState<Recap | null>(null);
  const [startFailed, setStartFailed] = useState(false);

  const data = useMatch((state) => state.data);
  const connection = useMatch((state) => state.connection);
  const selectedId = useMatch((state) => state.selectedId);
  const select = useMatch((state) => state.select);
  const language = profile.language;

  /** Follow whichever match the server considers current, or none. */
  const joinCurrent = useCallback(async () => {
    try {
      const current = await fetchCurrentMatch();
      setMatchId(current);
      if (current === null) useMatch.getState().setConnection("idle");
    } catch {
      useMatch.getState().setConnection("reconnecting");
    }
  }, []);

  useEffect(() => {
    fetchTeams().then(setTeams).catch(() => setTeams(null));
    void joinCurrent();
  }, [joinCurrent]);

  // One stream per (match, profile). Changing either replays the match in the new variant.
  useEffect(() => {
    if (matchId === null) return;
    const { apply, reset, setConnection } = useMatch.getState();
    reset();
    setOpenRecap(null);
    return connect(streamUrl(matchId, profile), { onEnvelope: apply, onConnection: setConnection }, eventSource);
  }, [matchId, profile, eventSource]);

  // A replaced match, or one the server no longer knows: move to the current match.
  const abandoned = data.status?.state === "abandoned";
  useEffect(() => {
    if (abandoned || connection === "no_match") void joinCurrent();
  }, [abandoned, connection, joinCurrent]);

  const latestRecap = data.recaps[data.recaps.length - 1] ?? null;
  useEffect(() => {
    // Keyed on the recap's id: open when a new recap arrives, not on every render of the same one.
    if (latestRecap) setOpenRecap(latestRecap);
  }, [latestRecap?.id]);

  const updateProfile = (next: ViewerProfile) => {
    setProfile(next);
    saveProfile(next);
  };

  const start = async () => {
    setStartFailed(false);
    try {
      setMatchId(await startMatch(speedFromLocation(window.location.search)));
    } catch {
      setStartFailed(true);
    }
  };

  const hasMatch = matchId !== null && connection !== "idle";
  const selectedNarrative = data.narratives.find((narrative) => narrative.moment_id === selectedId);
  const selectedMoment = data.moments.find((moment) => moment.id === selectedId);
  const selectedOverlay = selectedNarrative && data.overlays.find((overlay) => overlay.sources.includes(selectedNarrative.id));

  return (
    <div className={styles.app}>
      <Header
        status={hasMatch ? data.status : null}
        connection={connection}
        profile={profile}
        onModeChange={(mode) => updateProfile({ ...profile, mode })}
        onLanguageChange={(next) => updateProfile({ ...profile, language: next })}
        onOpenPreferences={() => setPreferencesOpen(true)}
        onStart={start}
      />
      {startFailed && (
        <MessageBar intent="error">
          <MessageBarBody>{t(language, "startFailed")}</MessageBarBody>
        </MessageBar>
      )}
      <TabList className={styles.views} selectedValue={view} onTabSelect={(_, tab) => setView(tab.value as View)}>
        <Tab value="match">{t(language, "matchTab")}</Tab>
        <Tab value="overlay">{t(language, "overlayTab")}</Tab>
      </TabList>
      {view === "match" ? (
        <main className={styles.match}>
          <div className={styles.column}>
            <div className={styles.panel}>
              <Switch checked={showPressure} label={t(language, "pressureMap")}
                onChange={(_, state) => setShowPressure(state.checked)} />
              <Pitch events={data.events} pressure={data.pressure} status={data.status} showPressure={showPressure} language={language} />
            </div>
            <div className={styles.panel}>
              <Timeline moments={data.moments} recaps={data.recaps} selectedId={selectedId} language={language}
                onSelect={select} onOpenRecap={setOpenRecap} />
            </div>
            <div className={styles.panel}>
              <StatsPanel stats={data.stats} status={data.status} language={language} />
            </div>
          </div>
          <div className={styles.column}>
            <div className={`${styles.panel} ${styles.feed}`}>
              <NarrativeFeed narratives={data.narratives} selectedId={selectedId} language={language} onSelect={select} />
            </div>
            <div className={styles.panel}>
              <PipelinePanel narrative={selectedNarrative} moment={selectedMoment} overlay={selectedOverlay || undefined} profile={profile} />
            </div>
          </div>
        </main>
      ) : (
        <main>
          <OverlayTab overlays={data.overlays} language={language} />
        </main>
      )}
      <PreferencesDrawer open={preferencesOpen} profile={profile} teams={teams} onChange={updateProfile}
        onClose={() => setPreferencesOpen(false)} />
      <RecapDialog recap={openRecap} language={language} onClose={() => setOpenRecap(null)} />
    </div>
  );
}
