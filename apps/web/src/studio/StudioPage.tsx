import { Badge, Link, makeStyles, MessageBar, MessageBarBody, Tab, TabList, Text, tokens } from "@fluentui/react-components";
import { useMemo, useState } from "react";
import type { Scene, SceneElement, Studio, ViewerProfile } from "../contracts";
import { useMatch } from "../stream/store";
import { type CurrentMatchOptions, useCurrentMatch } from "../stream/useCurrentMatch";
import {
  activateScene, clearBanner, createScene, deleteScene, deleteTemplate, endCountdown, saveScene, saveSettings,
  saveTemplate, saveTicker, showBanner, startBreak, startCountdown, startReplay, stopReplay, uploadImage,
} from "./api";
import { BannerPanel, CountdownPanel, ElementPanel, HighlightsPanel, SceneList, SettingsPanel, TickerPanel } from "./panels";
import { withReplayFallback } from "./ProgramPage";
import { SceneCanvas } from "./SceneCanvas";
import { useNow, useStudio } from "./useStudio";

const EDITOR_SCALE = 0.45;
const PREVIEW_SCALE = 0.16;
const TABS = ["Elements", "Banner", "Ticker", "Highlights", "Countdown", "Settings"] as const;
type TabName = (typeof TABS)[number];

const useStyles = makeStyles({
  page: { minHeight: "100vh", display: "flex", flexDirection: "column", backgroundColor: tokens.colorNeutralBackground2 },
  bar: {
    display: "flex", alignItems: "center", gap: tokens.spacingHorizontalL, padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalXL}`,
    backgroundColor: tokens.colorNeutralBackground1, borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  grow: { flexGrow: 1 },
  body: { display: "grid", gridTemplateColumns: "300px auto minmax(320px, 1fr)", gap: tokens.spacingHorizontalXL, padding: tokens.spacingHorizontalXL, alignItems: "start" },
  card: { padding: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow2 },
  column: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
});

/** The streamer's control page: arrange scenes, switch them, and drive what is on the program. */
export function StudioPage({ eventSource, retryMs, pollMs }: CurrentMatchOptions) {
  const styles = useStyles();
  const { studio, offset, connected, accept } = useStudio(eventSource, retryMs);
  const mode = studio?.settings.mode;
  const language = studio?.settings.language;
  const profile = useMemo<ViewerProfile | null>(
    () => (mode && language ? { mode, language, club: null, player: null } : null),
    [mode, language],
  );
  const { matchId } = useCurrentMatch(profile, { eventSource, retryMs, pollMs });
  const match = useMatch((state) => state.data);
  const now = useNow() + offset;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabName>("Elements");
  // The scene as just edited, shown until the server's answer arrives.
  const [pending, setPending] = useState<Scene | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  if (!studio) {
    return (
      <main className={styles.page}>
        <div className={styles.bar}>
          <Text>Connecting to the studio…</Text>
        </div>
      </main>
    );
  }

  /** Sends one change, applies the server's answer, and reports a refusal. True when it was accepted. */
  const run = async (request: () => Promise<Studio>): Promise<boolean> => {
    try {
      accept(await request());
      setProblem(null);
      return true;
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The change was not saved.");
      return false;
    }
  };

  const onAir = studio.scenes.find((scene) => scene.id === studio.active_scene_id) ?? studio.scenes[0];
  const saved = studio.scenes.find((scene) => scene.id === editingId) ?? onAir;
  const editing = pending?.id === saved.id ? pending : saved;
  const data = { match, studio, now, language: studio.settings.language };

  const changeElements = async (elements: SceneElement[]) => {
    const edited = { ...editing, elements };
    setPending(edited);
    await run(() => saveScene(edited));
    setPending(null);
  };

  const upload = async (file: File) => {
    try {
      const imageId = await uploadImage(file);
      setProblem(null);
      return imageId;
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The image was not uploaded.");
      return null;
    }
  };

  return (
    <main className={styles.page}>
      <div className={styles.bar}>
        <Text as="h1" size={500} weight="semibold">Kickstream Studio</Text>
        <Badge color={connected ? "success" : "warning"}>{connected ? "Connected" : "Reconnecting"}</Badge>
        <Text className={styles.grow}>On air: {onAir.name}</Text>
        <Link href="/program" target="_blank" rel="noreferrer">Open program</Link>
      </div>
      {problem && (
        <MessageBar intent="error">
          <MessageBarBody>{problem}</MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.body}>
        <div className={styles.card}>
          <SceneList
            studio={studio}
            editingId={editing.id}
            onEdit={(sceneId) => {
              setEditingId(sceneId);
              setSelectedId(null);
            }}
            onActivate={(sceneId) => void run(() => activateScene(sceneId))}
            onCreate={(source, ref) => void run(() => createScene(source, ref))}
            onDelete={(sceneId) => void run(() => deleteScene(sceneId))}
            onSaveTemplate={(sceneId) => void run(() => saveTemplate(sceneId))}
            onDeleteTemplate={(templateId) => void run(() => deleteTemplate(templateId))}
          />
        </div>
        <div className={styles.column}>
          <section className={styles.card} aria-label="Editor">
            <Text as="h2" weight="semibold" block>Editing: {editing.name}</Text>
            <SceneCanvas scene={editing} data={data} scale={EDITOR_SCALE} editable selectedId={selectedId}
              onSelect={setSelectedId} onChange={(elements) => void changeElements(elements)} />
          </section>
          <section className={styles.card} aria-label="Program preview">
            <Text as="h2" weight="semibold" block>Program</Text>
            <SceneCanvas scene={withReplayFallback(onAir, studio)} data={data} scale={PREVIEW_SCALE} />
          </section>
        </div>
        <div className={styles.card}>
          <TabList selectedValue={tab} onTabSelect={(_, selection) => setTab(selection.value as TabName)}>
            {TABS.map((name) => (
              <Tab key={name} value={name}>{name}</Tab>
            ))}
          </TabList>
          <div role="tabpanel" aria-label={tab} style={{ paddingTop: tokens.spacingVerticalM }}>
            {tab === "Elements" && (
              <ElementPanel scene={editing} selectedId={selectedId} onSelect={setSelectedId}
                onChange={(elements) => void changeElements(elements)} onUpload={upload} />
            )}
            {tab === "Banner" && (
              <BannerPanel studio={studio}
                onShow={(text) => run(() => showBanner({ text, kind: "custom" }))}
                onClear={() => void run(clearBanner)}
                onAuto={(enabled) => void run(() => saveSettings({ ...studio.settings, auto_banner: enabled }))} />
            )}
            {tab === "Ticker" && <TickerPanel ticker={studio.ticker} onSave={(ticker) => void run(() => saveTicker(ticker))} />}
            {tab === "Highlights" && (
              <HighlightsPanel match={match} replaying={studio.replay !== null && studio.replay !== undefined}
                onReplay={(moment) => matchId && void run(() => startReplay(matchId, moment.id))}
                onStopReplay={() => void run(stopReplay)}
                onBanner={(narrative) => void run(() => showBanner({ text: narrative.text.slice(0, 200), kind: "info", source_id: narrative.id }))} />
            )}
            {tab === "Countdown" && (
              <CountdownPanel studio={studio} now={now}
                onStart={(startsAt) => void run(() => startCountdown(startsAt))}
                onBreak={(minutes) => void run(() => startBreak(minutes))}
                onEnd={() => void run(endCountdown)} />
            )}
            {tab === "Settings" && <SettingsPanel settings={studio.settings} onSave={(settings) => void run(() => saveSettings(settings))} />}
          </div>
        </div>
      </div>
    </main>
  );
}
