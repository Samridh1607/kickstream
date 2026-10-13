import { Badge, makeStyles, mergeClasses, MessageBar, MessageBarBody, Select, Tab, TabList, Text, tokens } from "@fluentui/react-components";
import {
  FlashRegular, LayerRegular, LiveRegular, MegaphoneRegular, PeopleCommunityRegular, SettingsRegular,
  SlideLayoutRegular, TextBulletListSquareRegular, TimerRegular, TvRegular,
} from "@fluentui/react-icons";
import { type ReactElement, type ReactNode, useEffect, useMemo, useState } from "react";
import { STUDIO_AUDIENCE_STREAM } from "../audience/api";
import { AudienceTab } from "../audience/AudienceTab";
import { endBroadcast, goLiveWith } from "../broadcasts/api";
import { StudioBroadcastBar, useStudioBroadcast } from "../broadcasts/StudioBroadcast";
import type { Audience, Broadcast, Output, Scene, SceneElement, Studio, ViewerProfile } from "../contracts";
import { OUTPUT_STREAM } from "../output/api";
import { OutputTab } from "../output/OutputTab";
import { AppNav } from "../shell/AppNav";
import { useMatch } from "../stream/store";
import { useLiveDocument } from "../stream/useLiveDocument";
import { type CurrentMatchOptions, useCurrentMatch } from "../stream/useCurrentMatch";
import {
  activateScene, clearBanner, createScene, deleteScene, deleteTemplate, endCountdown, saveScene, saveSettings,
  saveTemplate, saveTicker, setSceneMode, showBanner, startBreak, startCountdown, startReplay, stopReplay, uploadImage,
} from "./api";
import { onAirScene, programMode } from "./mode";
import { BannerPanel, CountdownPanel, ElementPanel, HighlightsPanel, ModeBadge, SceneList, SettingsPanel, TickerPanel } from "./panels";
import { withFallbacks } from "./ProgramPage";
import { SceneCanvas } from "./SceneCanvas";
import { useNow, useStudio } from "./useStudio";

const EDITOR_SCALE = 0.45;
const PREVIEW_SCALE = 0.16;
const TABS = ["Elements", "Banner", "Ticker", "Highlights", "Audience", "Countdown", "Settings"] as const;
type TabName = (typeof TABS)[number];
const TAB_ICONS: Record<TabName, ReactElement> = {
  Elements: <LayerRegular />, Banner: <MegaphoneRegular />, Ticker: <TextBulletListSquareRegular />, Highlights: <FlashRegular />,
  Audience: <PeopleCommunityRegular />, Countdown: <TimerRegular />, Settings: <SettingsRegular />,
};

const useStyles = makeStyles({
  page: { minHeight: "100vh", display: "flex", flexDirection: "column", backgroundColor: tokens.colorNeutralBackground2 },
  // The editor canvas has a fixed width, so narrower windows move the scene list, then the controls, beneath it.
  body: {
    display: "grid", gridTemplateColumns: "300px auto minmax(320px, 1fr)", gridTemplateAreas: `"scenes editor controls"`,
    gap: tokens.spacingHorizontalXL, padding: tokens.spacingHorizontalXL, alignItems: "start",
    "@media (min-width: 1321px) and (max-width: 1640px)": { gridTemplateColumns: "auto minmax(320px, 1fr)", gridTemplateAreas: `"editor controls" "scenes controls"` },
    "@media (max-width: 1320px)": { gridTemplateColumns: "auto", gridTemplateAreas: `"editor" "controls" "scenes"` },
  },
  card: {
    padding: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke3}`,
  },
  column: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
  scenes: { gridArea: "scenes" },
  editor: { gridArea: "editor" },
  controls: { gridArea: "controls" },
  heading: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalM },
  headingIcon: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", borderRadius: tokens.borderRadiusMedium,
    fontSize: "18px", color: tokens.colorBrandForeground1, backgroundColor: tokens.colorBrandBackground2,
  },
  grow: { flexGrow: 1 },
  onAirName: { display: "inline-flex", alignItems: "center", gap: tokens.spacingHorizontalXS },
});

/** A box's title, with an icon, and what the box puts beside it. */
function Heading({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  const styles = useStyles();
  return (
    <div className={styles.heading}>
      <span className={styles.headingIcon} aria-hidden>{icon}</span>
      <Text as="h2" weight="semibold" size={400}>{title}</Text>
      <span className={styles.grow} />
      {children}
    </div>
  );
}

interface StudioPageProps extends CurrentMatchOptions {
  /** The broadcast this studio works on; its address is `/broadcasts/{id}/studio`. */
  broadcastId?: string;
}

/** The streamer's control page: arrange scenes, switch them, and drive what is on the program. */
export function StudioPage({ broadcastId, eventSource, retryMs, pollMs }: StudioPageProps) {
  const styles = useStyles();
  const { studio, offset, connected, accept } = useStudio(eventSource, retryMs);
  const link = useStudioBroadcast(broadcastId, eventSource, retryMs);
  const [ending, setEnding] = useState(false);
  const { doc: audience, accept: acceptAudience } = useLiveDocument<Audience>(STUDIO_AUDIENCE_STREAM, eventSource, retryMs);
  const { doc: output, accept: acceptOutput } = useLiveDocument<Output>(OUTPUT_STREAM, eventSource, retryMs);
  // The match is followed in the commentary of the scene on air, as the program shows it.
  const mode = studio ? programMode(studio) : undefined;
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

  // The editor is pinned to one scene. It opens on the scene on air and then stays put when the
  // program cuts elsewhere, so an edit never lands on a scene the streamer was not looking at.
  const activeId = studio?.active_scene_id ?? null;
  const editingExists = studio?.scenes.some((scene) => scene.id === editingId) ?? false;
  useEffect(() => {
    if (activeId !== null && !editingExists) setEditingId(activeId);
  }, [activeId, editingExists]);

  // A selection or half-finished edit belongs to one scene; never carry it into another.
  const editingSceneId = editingExists ? editingId : activeId;
  useEffect(() => {
    setSelectedId(null);
    setPending(null);
  }, [editingSceneId]);

  if (!studio) {
    return (
      <main className={styles.page}>
        <AppNav current="studio" output={output} now={now}>
          <Text>Connecting to the studio…</Text>
        </AppNav>
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

  const runAudience = async (request: () => Promise<Audience>): Promise<boolean> => {
    try {
      acceptAudience(await request());
      setProblem(null);
      return true;
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The change was not saved.");
      return false;
    }
  };

  const runOutput = async (request: () => Promise<Output>): Promise<boolean> => {
    try {
      acceptOutput(await request());
      setProblem(null);
      return true;
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The change was not made.");
      return false;
    }
  };

  /** Going live in a broadcast's studio goes live with that broadcast, so its sessions, recording and stats are kept. */
  const linked = broadcastId !== undefined ? link.broadcast : null;
  const goLiveWithBroadcast = linked === null ? undefined : async (): Promise<boolean> => {
    try {
      link.accept(await goLiveWith(linked.id));
      setProblem(null);
      return true;
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The broadcast could not go live.");
      return false;
    }
  };
  const end = async (broadcast: Broadcast) => {
    setEnding(true);
    try {
      link.accept(await endBroadcast(broadcast.id));
      setProblem(null);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The broadcast could not end.");
    } finally {
      setEnding(false);
    }
  };

  const onAir = onAirScene(studio);
  const saved = studio.scenes.find((scene) => scene.id === editingId) ?? onAir;
  const editing = pending?.id === saved.id ? pending : saved;
  const data = { match, studio, now, language: studio.settings.language, audience };

  const changeElements = async (elements: SceneElement[]) => {
    const edited = { ...editing, elements };
    setPending(edited);
    await run(() => saveScene(edited));
    // Clear only this edit's copy: a later edit may already be showing and waiting for its answer.
    setPending((current) => (current === edited ? null : current));
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

  const defaultMode = studio.settings.mode === "fan" ? "Fan" : "Analyst";

  return (
    <main className={styles.page}>
      <AppNav current="studio" output={output} now={now}>
        <Badge appearance="tint" color={connected ? "success" : "warning"}>{connected ? "Connected" : "Reconnecting"}</Badge>
        <span className={styles.onAirName}>
          <Text>On air: {onAir.name}</Text>
          <ModeBadge scene={onAir} studio={studio} />
        </span>
      </AppNav>
      {broadcastId !== undefined && <StudioBroadcastBar link={link} busy={ending} onEnd={(broadcast) => void end(broadcast)} />}
      {problem && (
        <MessageBar intent="error">
          <MessageBarBody>{problem}</MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.body}>
        <div className={mergeClasses(styles.card, styles.scenes)}>
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
        <div className={mergeClasses(styles.column, styles.editor)}>
          <section className={styles.card} aria-label="Editor">
            <Heading icon={<SlideLayoutRegular />} title={`Editing: ${editing.name}`}>
              <Select size="small" aria-label="Commentary" value={editing.mode ?? ""}
                onChange={(_, choice) => void run(() => setSceneMode(editing.id, choice.value === "" ? null : (choice.value as "fan" | "analyst")))}>
                <option value="">{`Studio default (${defaultMode})`}</option>
                <option value="fan">Fan commentary</option>
                <option value="analyst">Analyst commentary</option>
              </Select>
            </Heading>
            <SceneCanvas key={editing.id} scene={editing} data={data} scale={EDITOR_SCALE} editable selectedId={selectedId}
              onSelect={setSelectedId} onChange={(elements) => void changeElements(elements)} />
          </section>
          <section className={styles.card} aria-label="Program preview">
            <Heading icon={<TvRegular />} title="Program" />
            <SceneCanvas scene={withFallbacks(onAir, studio, audience)} data={data} scale={PREVIEW_SCALE} />
          </section>
        </div>
        <div className={mergeClasses(styles.column, styles.controls)}>
          <section className={styles.card} aria-label="Output">
            <Heading icon={<LiveRegular />} title="Output" />
            <OutputTab output={output} now={now} onRun={runOutput} onGoLive={goLiveWithBroadcast}
              recordsItself={linked !== null && linked.record && linked.state === "ready"} />
          </section>
          <div className={styles.card}>
            <TabList size="small" style={{ flexWrap: "wrap" }} selectedValue={tab} onTabSelect={(_, selection) => setTab(selection.value as TabName)}>
              {TABS.map((name) => (
                <Tab key={name} value={name} icon={TAB_ICONS[name]}>{name}</Tab>
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
              {tab === "Audience" && <AudienceTab audience={audience} onRun={runAudience} />}
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
      </div>
    </main>
  );
}
