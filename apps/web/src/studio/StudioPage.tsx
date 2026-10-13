import { Badge, Button, makeStyles, MessageBar, MessageBarBody, Select, Tab, TabList, Text, tokens } from "@fluentui/react-components";
import {
  FlashRegular, LayerRegular, LiveRegular, MegaphoneRegular, PeopleCommunityRegular, PeopleTeamRegular, PlayRegular, SettingsRegular,
  SlideLayoutRegular, TextBulletListSquareRegular, TimerRegular, TvRegular,
} from "@fluentui/react-icons";
import { type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { endBroadcast, goLiveWith } from "../broadcasts/api";
import { StudioBroadcastBar, useStudioBroadcast } from "../broadcasts/StudioBroadcast";
import type { Broadcast, FanZone, Output, People, Scene, SceneElement, Studio, ViewerProfile } from "../contracts";
import { FANS_STREAM } from "../fans/api";
import { FanPanel } from "../fans/FanPanel";
import { OUTPUT_STREAM } from "../output/api";
import { OutputTab } from "../output/OutputTab";
import { peopleStream } from "../people/api";
import { PeoplePanel } from "../people/PeoplePanel";
import { stageTiles } from "../people/stage";
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
import { CANVAS } from "./geometry";
import { SceneCanvas } from "./SceneCanvas";
import { useNow, useStudio } from "./useStudio";

// The stage's scale where its box cannot be measured, and the limits it is kept within where it can.
const STAGE_SCALE = 0.45;
const MIN_STAGE_SCALE = 0.25;
// Room kept for the page bar above the stage and the scenes beneath it.
const AROUND_STAGE = 460;
const PREVIEW_SCALE = 0.18;
const TABS = ["Elements", "People", "Fans", "Banner", "Ticker", "Highlights", "Countdown", "Settings"] as const;
type TabName = (typeof TABS)[number];
const TAB_ICONS: Record<TabName, ReactElement> = {
  Elements: <LayerRegular />, People: <PeopleTeamRegular />, Fans: <PeopleCommunityRegular />, Banner: <MegaphoneRegular />, Ticker: <TextBulletListSquareRegular />, Highlights: <FlashRegular />,
  Countdown: <TimerRegular />, Settings: <SettingsRegular />,
};

const useStyles = makeStyles({
  page: { minHeight: "100vh", display: "flex", flexDirection: "column", backgroundColor: tokens.colorNeutralBackground2 },
  // Stage first: the stage takes the width, its scenes sit beneath it, and the controls keep to a side panel
  // that moves under the stage in a narrow window.
  body: {
    display: "grid", gridTemplateColumns: "minmax(0, 1fr) 380px", gap: tokens.spacingHorizontalL, padding: tokens.spacingHorizontalL,
    alignItems: "start",
    "@media (max-width: 1100px)": { gridTemplateColumns: "minmax(0, 1fr)" },
  },
  card: {
    padding: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke3}`,
  },
  column: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL, minWidth: 0 },
  // The stage is letterboxed in its frame when the window is too short for its full width.
  frame: { display: "flex", justifyContent: "center", overflow: "hidden", borderRadius: tokens.borderRadiusLarge, backgroundColor: "#05080F" },
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

/** The scale at which the 16:9 stage fills the box it is in, without growing taller than the window has room for. */
function useStageScale(): [(node: HTMLDivElement | null) => void, number] {
  const [scale, setScale] = useState(STAGE_SCALE);
  const cleanup = useRef<(() => void) | null>(null);
  const frame = useCallback((node: HTMLDivElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!node) return;
    const measure = () => {
      const width = node.clientWidth;
      if (width === 0) return;
      const fit = Math.min(width / CANVAS.width, (window.innerHeight - AROUND_STAGE) / CANVAS.height);
      setScale(Math.min(Math.max(fit, MIN_STAGE_SCALE), width / CANVAS.width));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("resize", measure);
    measure();
    cleanup.current = () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return [frame, scale];
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
  const { doc: output, accept: acceptOutput } = useLiveDocument<Output>(OUTPUT_STREAM, eventSource, retryMs);
  const { doc: people, accept: acceptPeople } = useLiveDocument<People>(broadcastId !== undefined ? peopleStream(broadcastId) : null, eventSource, retryMs);
  const { doc: fans, accept: acceptFans } = useLiveDocument<FanZone>(FANS_STREAM, eventSource, retryMs);
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
  const [frame, stageScale] = useStageScale();
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

  const runFans = async (request: () => Promise<FanZone>): Promise<boolean> => {
    try {
      acceptFans(await request());
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
  const cameras = stageTiles(people);
  const data = { match, studio, now, language: studio.settings.language, fans, cameras };

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

  // People are invited into a broadcast, so only a broadcast's studio has the tab.
  const tabs = TABS.filter((name) => name !== "People" || broadcastId !== undefined);
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
        <div className={styles.column}>
          <section className={styles.card} aria-label="Editor">
            <Heading icon={<SlideLayoutRegular />} title={`Editing: ${editing.name}`}>
              {editing.id === onAir.id ? (
                <Badge color="danger" icon={<LiveRegular />}>On the program</Badge>
              ) : (
                <>
                  <Badge appearance="outline">Not on the program</Badge>
                  <Button size="small" appearance="primary" icon={<PlayRegular />} aria-label={`Put ${editing.name} on the program`}
                    onClick={() => void run(() => activateScene(editing.id))}>
                    Put on the program
                  </Button>
                </>
              )}
              <Select size="small" aria-label="Commentary" value={editing.mode ?? ""}
                onChange={(_, choice) => void run(() => setSceneMode(editing.id, choice.value === "" ? null : (choice.value as "fan" | "analyst")))}>
                <option value="">{`Studio default (${defaultMode})`}</option>
                <option value="fan">Fan commentary</option>
                <option value="analyst">Analyst commentary</option>
              </Select>
            </Heading>
            <div ref={frame} className={styles.frame}>
              <SceneCanvas key={editing.id} scene={editing} data={data} scale={stageScale} editable selectedId={selectedId}
                onSelect={setSelectedId} onChange={(elements) => void changeElements(elements)} />
            </div>
          </section>
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
        </div>
        <div className={styles.column}>
          <section className={styles.card} aria-label="Program preview">
            <Heading icon={<TvRegular />} title="Program">
              <Text size={200}>{onAir.name}</Text>
            </Heading>
            <div className={styles.frame}>
              <SceneCanvas scene={withFallbacks(onAir, studio, cameras, fans)} data={data} scale={PREVIEW_SCALE} />
            </div>
          </section>
          <section className={styles.card} aria-label="Output">
            <Heading icon={<LiveRegular />} title="Output" />
            <OutputTab output={output} now={now} onRun={runOutput} onGoLive={goLiveWithBroadcast}
              recordsItself={linked !== null && linked.record && linked.state === "ready"} />
          </section>
          <div className={styles.card}>
            <TabList size="small" style={{ flexWrap: "wrap" }} selectedValue={tab} onTabSelect={(_, selection) => setTab(selection.value as TabName)}>
              {tabs.map((name) => (
                <Tab key={name} value={name} icon={TAB_ICONS[name]}>{name}</Tab>
              ))}
            </TabList>
            <div role="tabpanel" aria-label={tab} style={{ paddingTop: tokens.spacingVerticalM }}>
              {tab === "Elements" && (
                <ElementPanel scene={editing} selectedId={selectedId} onSelect={setSelectedId}
                  onChange={(elements) => void changeElements(elements)} onUpload={upload} status={match.status} />
              )}
              {broadcastId !== undefined && (
                // Kept in the page while another tab is open: the panel holds the streamer's own camera call.
                <section aria-label="People" hidden={tab !== "People"}>
                  <PeoplePanel key={broadcastId} broadcastId={broadcastId} people={people} live={link.broadcast?.state === "live"} onPeople={acceptPeople} />
                </section>
              )}
              {tab === "Fans" && <FanPanel fans={fans} onRun={runFans} />}
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
      </div>
    </main>
  );
}
