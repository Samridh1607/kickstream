import { Button, makeStyles, MessageBar, MessageBarActions, MessageBarBody, Text, tokens } from "@fluentui/react-components";
import { DismissRegular } from "@fluentui/react-icons";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { endBroadcast, goLiveWith } from "../broadcasts/api";
import { useStudioBroadcast } from "../broadcasts/StudioBroadcast";
import { useHostCall } from "../calls/useHostCall";
import type { Broadcast, FanZone, Output, People, Scene, SceneElement, Studio, ViewerProfile } from "../contracts";
import { AskCopilot } from "../copilot/AskCopilot";
import { FANS_STREAM } from "../fans/api";
import { OUTPUT_STREAM } from "../output/api";
import { peopleStream } from "../people/api";
import { HOST } from "../people/PeoplePanel";
import { stageTiles } from "../people/stage";
import { ThemeToggle } from "../shell/AppNav";
import { useMatch } from "../stream/store";
import { useLiveDocument } from "../stream/useLiveDocument";
import { type CurrentMatchOptions, useCurrentMatch } from "../stream/useCurrentMatch";
import {
  activateScene, clearBanner, createScene, deleteScene, deleteTemplate, endCountdown, saveScene, saveSettings,
  saveTemplate, saveTicker, setSceneMode, showBanner, startBreak, startCountdown, startReplay, stopReplay, uploadImage,
} from "./api";
import { Backstage } from "./Backstage";
import { EditLayout } from "./EditLayout";
import { onAirScene, programMode } from "./mode";
import { withFallbacks } from "./ProgramPage";
import { SceneStrip } from "./SceneStrip";
import { Stage } from "./Stage";
import { TOOLS, type ToolName, ToolRail } from "./ToolRail";
import { BannersTool } from "./tools/BannersTool";
import { CommentsTool } from "./tools/CommentsTool";
import { GuestsTool } from "./tools/GuestsTool";
import { MatchTool } from "./tools/MatchTool";
import { ReplaysTool } from "./tools/ReplaysTool";
import { SettingsTool } from "./tools/SettingsTool";
import { StreamTool } from "./tools/StreamTool";
import { TimerTool } from "./tools/TimerTool";
import { TopBar } from "./TopBar";
import { useNow, useStudio } from "./useStudio";

// Padding around the stage column and the gaps between its rows, kept free besides what is measured.
const AROUND = 44;
// The edit layout's own header and padding, on top of the canvas.
const EDIT_CHROME = 100;
const NO_DESTINATION = "Turn on a destination in the Stream tool first.";

const useStyles = makeStyles({
  // The studio fits the window: the stage column and the tools scroll inside, never the page.
  // In a narrow window everything stacks in one column and the page scrolls instead.
  page: {
    height: "100vh", display: "grid", gridTemplateRows: "auto auto minmax(0, 1fr)", backgroundColor: tokens.colorNeutralBackground2,
    "@media (max-width: 1100px)": { height: "auto", minHeight: "100vh" },
  },
  // Takes no height of its own, so a toast floats over the stage instead of pushing it down.
  errors: { position: "relative", zIndex: 20 },
  toast: {
    position: "absolute", top: tokens.spacingVerticalS, left: "50%", transform: "translateX(-50%)", width: "min(640px, calc(100% - 32px))",
    boxShadow: tokens.shadow16,
  },
  body: {
    display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: tokens.spacingHorizontalM, padding: tokens.spacingHorizontalM, minHeight: 0,
    "@media (max-width: 1100px)": { gridTemplateColumns: "minmax(0, 1fr)" },
  },
  main: {
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, minWidth: 0, minHeight: 0, overflowY: "auto",
    "@media (max-width: 1100px)": { overflowY: "visible" },
  },
  fixed: { flexShrink: 0 },
  tools: { minHeight: 0 },
  connecting: { padding: tokens.spacingHorizontalXL },
  onDark: { color: "#FFFFFF", ":hover": { color: "#FFFFFF" }, ":hover:active": { color: "#FFFFFF" } },
});

/** The height a box is drawn at, kept up to date as its content wraps. */
function useHeight(): [(node: HTMLElement | null) => void, number] {
  const [height, setHeight] = useState(0);
  const cleanup = useRef<(() => void) | null>(null);
  const box = useCallback((node: HTMLElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!node) return;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    setHeight(node.offsetHeight);
    cleanup.current = () => observer.disconnect();
  }, []);
  return [box, height];
}

interface StudioPageProps extends CurrentMatchOptions {
  /** The broadcast this studio works on; its address is `/broadcasts/{id}/studio`. */
  broadcastId?: string;
}

/** The streamer's control page: the program on a large stage, the people backstage, the scenes, and one tool at a time. */
export function StudioPage({ broadcastId, eventSource, retryMs, pollMs }: StudioPageProps) {
  const styles = useStyles();
  const { studio, offset, connected, accept } = useStudio(eventSource, retryMs);
  const link = useStudioBroadcast(broadcastId, eventSource, retryMs);
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

  // The host's camera call lives here, above every tool and mode, so switching them never drops it.
  const broadcastLive = link.broadcast?.state === "live";
  const hostOnStage = people?.stage.some((person) => person.id === HOST) ?? false;
  const host = useHostCall({ broadcastId: broadcastId ?? "", people, mutedLive: broadcastLive && !hostOnStage });

  // Null while live; otherwise the scene open in Edit layout.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openTool, setOpenTool] = useState<ToolName | null>(null);
  // The scene as just edited, shown until the server's answer arrives.
  const [pending, setPending] = useState<Scene | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
  const [topBar, topBarHeight] = useHeight();
  const [backstage, backstageHeight] = useHeight();
  const [strip, stripHeight] = useHeight();

  // Edit layout is pinned to one scene. It stays put when the program cuts elsewhere, so an edit never lands
  // on a scene the streamer was not looking at; if that scene is deleted it moves to the scene on air.
  const activeId = studio?.active_scene_id ?? null;
  const editingExists = studio?.scenes.some((scene) => scene.id === editingId) ?? false;
  useEffect(() => {
    if (editingId !== null && !editingExists) setEditingId(activeId);
  }, [editingId, editingExists, activeId]);

  // A selection or half-finished edit belongs to one scene; never carry it into another.
  const editingSceneId = editingId === null ? null : editingExists ? editingId : activeId;
  useEffect(() => {
    setSelectedId(null);
    setPending(null);
  }, [editingSceneId]);

  const latestComment = fans ? fans.comments.reduce((latest, comment) => Math.max(latest, comment.at), 0) : null;
  const [seenUntil, setSeenUntil] = useState<number | null>(null);
  const readingComments = openTool === "Comments";
  useEffect(() => {
    if (latestComment !== null && (seenUntil === null || readingComments)) setSeenUntil(latestComment);
  }, [latestComment, seenUntil, readingComments]);
  const unseen = seenUntil === null || readingComments ? 0 : (fans?.comments.filter((comment) => comment.at > seenUntil).length ?? 0);

  if (!studio) {
    return (
      <main className={styles.connecting}>
        <Text>Connecting to the studio…</Text>
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

  const runPeople = async (request: () => Promise<People>): Promise<boolean> => {
    try {
      acceptPeople(await request());
      setProblem(null);
      return true;
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The change was not made.");
      return false;
    }
  };

  /** One go live or end at a time; a second click while one is on its way does nothing. */
  const guard = async (work: () => Promise<void>) => {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      acting.current = false;
      setBusy(false);
    }
  };

  /** Going live in a broadcast's studio goes live with that broadcast, so its sessions, recording and stats are kept. */
  const linked = broadcastId !== undefined ? link.broadcast : null;
  const goLiveWithBroadcast = linked === null ? undefined : () => guard(async () => {
    try {
      link.accept(await goLiveWith(linked.id));
      setProblem(null);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The broadcast could not go live.");
    }
  });
  const end = (broadcast: Broadcast) => guard(async () => {
    try {
      link.accept(await endBroadcast(broadcast.id));
      setProblem(null);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The broadcast could not end.");
    }
  });
  // Going live turns recording on by itself, so no destination needs to be switched on first.
  const recordsItself = linked !== null && linked.record && linked.state === "ready";
  const canSend = recordsItself || (output?.destinations.some((item) => item.enabled) ?? false);

  const onAir = onAirScene(studio);
  const saved = editingId === null ? null : (studio.scenes.find((scene) => scene.id === editingId) ?? onAir);
  const editing = saved && pending?.id === saved.id ? pending : saved;
  const cameras = stageTiles(people);
  const data = { match, studio, now, language: studio.settings.language, fans, cameras };
  const live = broadcastLive || output?.state === "live";

  const changeElements = async (scene: Scene, elements: SceneElement[]) => {
    const edited = { ...scene, elements };
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

  const rename = (sceneId: string, name: string) => {
    const scene = editing?.id === sceneId ? editing : studio.scenes.find((item) => item.id === sceneId);
    if (scene) void run(() => saveScene({ id: sceneId, name, elements: scene.elements }));
  };
  const setMode = (sceneId: string, choice: "fan" | "analyst" | null) => void run(() => setSceneMode(sceneId, choice));
  const activate = (sceneId: string) => void run(() => activateScene(sceneId));

  // People are invited into a broadcast, so only a broadcast's studio has the Guests tool.
  const tools = TOOLS.filter((name) => name !== "Guests" || broadcastId !== undefined);
  const reserve = topBarHeight + stripHeight + AROUND + (editing ? EDIT_CHROME : backstageHeight);

  const toolPanel = (tool: ToolName | null): ReactNode => {
    switch (tool) {
      case "Match":
        return <MatchTool onStarted={() => setProblem(null)} />;
      case "Banners":
        return (
          <BannersTool studio={studio}
            onShow={(text) => run(() => showBanner({ text, kind: "custom" }))}
            onClear={() => void run(clearBanner)}
            onAuto={(enabled) => void run(() => saveSettings({ ...studio.settings, auto_banner: enabled }))}
            onSaveTicker={(ticker) => void run(() => saveTicker(ticker))} />
        );
      case "Comments":
        return <CommentsTool fans={fans} onRun={runFans} />;
      case "Guests":
        return broadcastId !== undefined && <GuestsTool broadcastId={broadcastId} people={people} onRun={runPeople} />;
      case "Replays":
        return (
          <ReplaysTool match={match} replaying={studio.replay !== null && studio.replay !== undefined}
            onReplay={(moment) => matchId && void run(() => startReplay(matchId, moment.id))}
            onStopReplay={() => void run(stopReplay)}
            onBanner={(narrative) => void run(() => showBanner({ text: narrative.text.slice(0, 200), kind: "info", source_id: narrative.id }))} />
        );
      case "Timer":
        return (
          <TimerTool studio={studio} now={now}
            onStart={(startsAt) => void run(() => startCountdown(startsAt))}
            onBreak={(minutes) => void run(() => startBreak(minutes))}
            onEnd={() => void run(endCountdown)} />
        );
      case "Stream":
        return <StreamTool output={output} now={now} onRun={runOutput} liveControls={broadcastId === undefined} />;
      case "Settings":
        return <SettingsTool settings={studio.settings} onSave={(settings) => void run(() => saveSettings(settings))} />;
      default:
        return null;
    }
  };

  return (
    <main className={styles.page}>
      <div ref={topBar}>
        <TopBar link={broadcastId !== undefined ? link : null} output={output} connected={connected} onAirName={onAir.name}
          editing={editing !== null} onToggleEdit={() => setEditingId(editing === null ? onAir.id : null)}
          onGoLive={goLiveWithBroadcast && (() => void goLiveWithBroadcast())} goLiveBlocked={canSend ? undefined : NO_DESTINATION}
          onEnd={(broadcast) => void end(broadcast)} busy={busy} now={now}
          extras={<><AskCopilot /><ThemeToggle className={styles.onDark} /></>} />
      </div>
      <section aria-label="Studio errors" className={styles.errors}>
        {problem && (
          <MessageBar intent="error" className={styles.toast}>
            <MessageBarBody>{problem}</MessageBarBody>
            <MessageBarActions
              containerAction={<Button appearance="transparent" aria-label="Dismiss" icon={<DismissRegular />} onClick={() => setProblem(null)} />} />
          </MessageBar>
        )}
      </section>
      <div className={styles.body}>
        <div className={styles.main}>
          {editing ? (
            <EditLayout scene={editing} studio={studio} data={data} selectedId={selectedId} onSelect={setSelectedId}
              onChange={(elements) => void changeElements(editing, elements)} onUpload={upload} onActivate={activate}
              onMode={setMode} onRename={rename} onClose={() => setEditingId(null)} status={match.status} reserve={reserve} />
          ) : (
            <div className={styles.fixed}>
              <Stage scene={withFallbacks(onAir, studio, cameras, fans)} data={data} live={live} reserve={reserve} />
            </div>
          )}
          {broadcastId !== undefined && (
            // Hidden, not removed, while editing: backstage shows the host's camera call, which must carry on.
            <div ref={backstage} className={styles.fixed} hidden={editing !== null}>
              <Backstage broadcastId={broadcastId} people={people} live={broadcastLive} host={host} onRun={runPeople}
                onInvite={() => setOpenTool("Guests")} />
            </div>
          )}
          <div ref={strip} className={styles.fixed}>
            <SceneStrip studio={studio} data={data} editingId={editing?.id ?? null}
              onActivate={activate}
              onEdit={setEditingId}
              onRename={rename}
              onMode={setMode}
              onCreate={(source, ref) => void run(() => createScene(source, ref))}
              onDelete={(sceneId) => void run(() => deleteScene(sceneId))}
              onSaveTemplate={(sceneId) => void run(() => saveTemplate(sceneId))}
              onDeleteTemplate={(templateId) => void run(() => deleteTemplate(templateId))} />
          </div>
        </div>
        <div className={styles.tools}>
          <ToolRail tools={tools} open={openTool} onOpen={setOpenTool} badges={{ Comments: unseen }}>
            {toolPanel(openTool)}
          </ToolRail>
        </div>
      </div>
    </main>
  );
}
