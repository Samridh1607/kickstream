import { Badge, Button, makeStyles, mergeClasses, MessageBar, MessageBarBody, Text, tokens, Tooltip } from "@fluentui/react-components";
import {
  ChatRegular, CheckmarkCircleFilled, CircleRegular, CopyRegular, LiveRegular, OpenRegular, PeopleCommunityRegular,
  PlayRegular, PollRegular, RecordStopRegular, SlideLayoutRegular, SportSoccerRegular, TvRegular, VideoClipMultipleRegular,
} from "@fluentui/react-icons";
import { type ReactNode, useMemo, useState } from "react";
import { speedFromLocation, startMatch } from "../api";
import { STUDIO_AUDIENCE_STREAM } from "../audience/api";
import type { Audience, Output, ViewerProfile } from "../contracts";
import { goLive, OUTPUT_STREAM, stopOutput } from "../output/api";
import { AppNav } from "../shell/AppNav";
import { PlatformMark, platformLabel } from "../shell/PlatformMark";
import { useMatch } from "../stream/store";
import { useLiveDocument } from "../stream/useLiveDocument";
import { type CurrentMatchOptions, useCurrentMatch } from "../stream/useCurrentMatch";
import { activateScene } from "../studio/api";
import { onAirScene, programMode } from "../studio/mode";
import { ModeBadge, sceneIcon } from "../studio/panels";
import { withFallbacks } from "../studio/ProgramPage";
import { SceneCanvas } from "../studio/SceneCanvas";
import { useNow, useStudio } from "../studio/useStudio";

const HERO_SCALE = 0.25;
const THUMB_SCALE = 0.125;

const STATUS = {
  idle: { label: "Off", color: "subtle" },
  connecting: { label: "Connecting", color: "warning" },
  live: { label: "Live", color: "success" },
  retrying: { label: "Retrying", color: "warning" },
  failed: { label: "Failed", color: "danger" },
} as const;

const useStyles = makeStyles({
  page: { minHeight: "100vh", display: "flex", flexDirection: "column", backgroundColor: tokens.colorNeutralBackground2 },
  main: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXL, padding: tokens.spacingHorizontalXXL, maxWidth: "1480px", width: "100%", boxSizing: "border-box", margin: "0 auto" },
  hero: {
    display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalXXL, padding: tokens.spacingHorizontalXXL,
    borderRadius: "20px", color: "#FFFFFF", boxShadow: tokens.shadow16,
    backgroundImage: "radial-gradient(circle at 15% 20%, rgba(217, 45, 32, 0.45), transparent 45%), linear-gradient(135deg, #1C0F33 0%, #3A1A78 55%, #6528CF 100%)",
  },
  heroText: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM, flex: "1 1 380px", minWidth: 0 },
  kicker: { display: "inline-flex", alignItems: "center", gap: tokens.spacingHorizontalXS, textTransform: "uppercase", letterSpacing: "0.12em", fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold, opacity: 0.85 },
  heroTitle: { margin: 0, fontSize: "40px", lineHeight: 1.1, fontWeight: tokens.fontWeightBold },
  heroSub: { fontSize: tokens.fontSizeBase400, lineHeight: 1.5, opacity: 0.9, maxWidth: "560px" },
  actions: { display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalS },
  goLive: { backgroundColor: "#D92D20", color: "#FFFFFF", border: "none", ":hover": { backgroundColor: "#B42318", color: "#FFFFFF" }, ":hover:active": { backgroundColor: "#912018", color: "#FFFFFF" } },
  ghost: { color: "#FFFFFF", backgroundColor: "rgba(255, 255, 255, 0.12)", border: "1px solid rgba(255, 255, 255, 0.3)", ":hover": { color: "#FFFFFF", backgroundColor: "rgba(255, 255, 255, 0.22)" } },
  monitor: { position: "relative", padding: "10px", borderRadius: "16px", backgroundColor: "rgba(0, 0, 0, 0.45)", boxShadow: "0 20px 50px rgba(0, 0, 0, 0.35)" },
  monitorScreen: { borderRadius: "8px", overflow: "hidden", lineHeight: 0 },
  tag: { position: "absolute", bottom: "18px", left: "18px", zIndex: 1, display: "inline-flex", alignItems: "center", gap: "6px", padding: "2px 10px", borderRadius: "999px", fontSize: "12px", fontWeight: 700, letterSpacing: "0.08em" },
  tagLive: { backgroundColor: "#D92D20", color: "#FFFFFF" },
  tagOff: { backgroundColor: "rgba(255, 255, 255, 0.85)", color: "#1C0F33" },
  dot: { width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "currentColor", animationName: { "0%": { opacity: 1 }, "50%": { opacity: 0.3 }, "100%": { opacity: 1 } }, animationDuration: "1.4s", animationIterationCount: "infinite" },
  tiles: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: tokens.spacingHorizontalL },
  tile: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalM, padding: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke3}` },
  tileIcon: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: "44px", height: "44px", flexShrink: 0, borderRadius: "12px", fontSize: "24px" },
  tileText: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
  grid: { display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(320px, 2fr)", gap: tokens.spacingHorizontalXL, alignItems: "start", "@media (max-width: 1100px)": { gridTemplateColumns: "minmax(0, 1fr)" } },
  column: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXL },
  card: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM, padding: tokens.spacingHorizontalXL, borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke3}` },
  cardHead: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  cardIcon: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: "32px", height: "32px", borderRadius: tokens.borderRadiusMedium, fontSize: "18px", color: tokens.colorBrandForeground1, backgroundColor: tokens.colorBrandBackground2 },
  grow: { flexGrow: 1 },
  scenes: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: tokens.spacingHorizontalL },
  scene: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, padding: tokens.spacingHorizontalS, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground3, border: `${tokens.strokeWidthThick} solid transparent` },
  sceneOnAir: { border: `${tokens.strokeWidthThick} solid #D92D20` },
  thumb: { borderRadius: tokens.borderRadiusMedium, overflow: "hidden", lineHeight: 0, alignSelf: "center" },
  sceneRow: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS, minWidth: 0 },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  destination: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalM, padding: tokens.spacingHorizontalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  share: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS, padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3, fontFamily: tokens.fontFamilyMonospace, overflowWrap: "anywhere" },
  step: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  done: { color: tokens.colorPaletteGreenForeground1, fontSize: "20px" },
  todo: { color: tokens.colorNeutralForeground4, fontSize: "20px" },
  muted: { color: tokens.colorNeutralForeground3 },
});

function elapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(whole % 60)}` : `${minutes}:${pad(whole % 60)}`;
}

function Card({ icon, title, action, label, children }: { icon: ReactNode; title: string; action?: ReactNode; label: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <section className={styles.card} aria-label={label}>
      <div className={styles.cardHead}>
        <span className={styles.cardIcon} aria-hidden>{icon}</span>
        <Text as="h2" weight="semibold" size={500}>{title}</Text>
        <span className={styles.grow} />
        {action}
      </div>
      {children}
    </section>
  );
}

function Tile({ icon, tint, label, value, detail }: { icon: ReactNode; tint: string; label: string; value: ReactNode; detail?: ReactNode }) {
  const styles = useStyles();
  return (
    <div className={styles.tile}>
      <span className={styles.tileIcon} aria-hidden style={{ color: tint, backgroundColor: `${tint}1F` }}>{icon}</span>
      <div className={styles.tileText}>
        <Text size={200} className={styles.muted}>{label}</Text>
        <Text weight="semibold" size={500} truncate wrap={false}>{value}</Text>
        {detail}
      </div>
    </div>
  );
}

/** The streamer's home: is the stream on, where it goes, what is on air, and the way into everything else. */
export function HomePage({ eventSource, retryMs, pollMs }: CurrentMatchOptions) {
  const styles = useStyles();
  const { studio, offset, accept: acceptStudio } = useStudio(eventSource, retryMs);
  const { doc: output, accept: acceptOutput } = useLiveDocument<Output>(OUTPUT_STREAM, eventSource, retryMs);
  const { doc: audience } = useLiveDocument<Audience>(STUDIO_AUDIENCE_STREAM, eventSource, retryMs);
  const mode = studio ? programMode(studio) : undefined;
  const language = studio?.settings.language;
  const profile = useMemo<ViewerProfile | null>(
    () => (mode && language ? { mode, language, club: null, player: null } : null),
    [mode, language],
  );
  const { matchId, setMatchId } = useCurrentMatch(profile, { eventSource, retryMs, pollMs });
  const match = useMatch((state) => state.data);
  const connection = useMatch((state) => state.connection);
  const now = useNow() + offset;
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const attempt = async (request: () => Promise<void>, failure: string) => {
    setBusy(true);
    try {
      await request();
      setProblem(null);
    } catch (caught) {
      setProblem(caught instanceof Error && caught.message ? caught.message : failure);
    } finally {
      setBusy(false);
    }
  };

  const state = output?.state ?? "idle";
  const live = state === "live";
  const sending = output?.destinations.filter((item) => item.enabled) ?? [];
  const onAir = studio ? onAirScene(studio) : null;
  const status = matchId !== null && connection !== "idle" ? match.status : null;
  const openQuestions = audience?.questions.filter((question) => question.state === "open").length ?? 0;
  const votes = audience?.poll?.options.reduce((sum, option) => sum + option.votes, 0) ?? 0;
  const joinUrl = `${window.location.origin}/join`;
  const data = studio ? { match, studio, now, language: studio.settings.language, audience } : null;

  const title = live ? "You're live" : state === "starting" ? "Going live…" : state === "stopping" ? "Ending the stream…" : "Ready to go live";
  const subtitle = live
    ? `Streaming to ${sending.length} ${sending.length === 1 ? "destination" : "destinations"}${onAir ? ` · ${onAir.name} on air` : ""}.`
    : sending.length === 0
      ? "Add YouTube, X, Facebook or Twitch in the studio, pick a scene, and send one stream to every platform at once."
      : `${sending.length} ${sending.length === 1 ? "destination is" : "destinations are"} ready. Pick a scene and press Go live.`;

  const steps = [
    { done: (output?.destinations.length ?? 0) > 0, label: "Add a streaming destination" },
    { done: status !== null, label: "Start the match feed" },
    { done: Boolean(onAir && onAir.template !== "Starting soon"), label: "Put a match scene on air" },
    { done: live, label: "Go live" },
  ];

  return (
    <div className={styles.page}>
      <AppNav current="home" output={output} now={now} />
      <main className={styles.main}>
        {problem && (
          <MessageBar intent="error">
            <MessageBarBody>{problem}</MessageBarBody>
          </MessageBar>
        )}

        <section className={styles.hero} aria-label="Broadcast">
          <div className={styles.heroText}>
            <span className={styles.kicker}><LiveRegular /> Kickstream live studio</span>
            <h1 className={styles.heroTitle}>{title}</h1>
            <Text className={styles.heroSub}>{subtitle}</Text>
            {live && typeof output?.started_at === "number" && (
              <Text size={600} weight="bold" style={{ fontVariantNumeric: "tabular-nums" }}>{elapsed(now - output.started_at)}</Text>
            )}
            <div className={styles.actions}>
              {state === "idle" ? (
                <Button size="large" icon={<LiveRegular />} className={styles.goLive} disabled={busy || sending.length === 0}
                  onClick={() => void attempt(async () => acceptOutput(await goLive()), "The stream could not start.")}>
                  Go live
                </Button>
              ) : (
                <Button size="large" icon={<RecordStopRegular />} className={styles.goLive} disabled={busy || state === "stopping"}
                  onClick={() => void attempt(async () => acceptOutput(await stopOutput()), "The stream could not stop.")}>
                  Stop stream
                </Button>
              )}
              <Button as="a" href="/studio" size="large" icon={<VideoClipMultipleRegular />} className={styles.ghost}>Open studio</Button>
              <Button as="a" href="/program" target="_blank" rel="noreferrer" size="large" icon={<TvRegular />} className={styles.ghost}>Program</Button>
            </div>
          </div>
          {studio && onAir && data && (
            <div className={styles.monitor} aria-label="Program preview">
              <span className={mergeClasses(styles.tag, live ? styles.tagLive : styles.tagOff)}>
                {live && <span className={styles.dot} />}
                {live ? "ON AIR" : "PREVIEW"}
              </span>
              <div className={styles.monitorScreen}>
                <SceneCanvas scene={withFallbacks(onAir, studio, audience)} data={data} scale={HERO_SCALE} />
              </div>
            </div>
          )}
        </section>

        <div className={styles.tiles}>
          <Tile icon={<LiveRegular />} tint="#D92D20" label="Destinations"
            value={`${sending.length} of ${output?.destinations.length ?? 0} on`}
            detail={<Text size={200} className={styles.muted}>{live ? "Streaming now" : "Off air"}</Text>} />
          <Tile icon={<SlideLayoutRegular />} tint="#7535E3" label="Scene on air" value={onAir?.name ?? "—"}
            detail={studio && onAir ? <ModeBadge scene={onAir} studio={studio} /> : undefined} />
          <Tile icon={<PeopleCommunityRegular />} tint="#0E9F6E" label="Audience"
            value={audience?.poll ? `${votes} ${votes === 1 ? "vote" : "votes"}` : `${openQuestions} ${openQuestions === 1 ? "question" : "questions"}`}
            detail={<Text size={200} className={styles.muted}>{audience?.poll ? `Poll: ${audience.poll.question}` : "No poll running"}</Text>} />
          <Tile icon={<SportSoccerRegular />} tint="#0866FF" label="Match feed"
            value={status ? `${status.home.name} ${status.score_home}–${status.score_away} ${status.away.name}` : "Not started"}
            detail={status ? <Text size={200} className={styles.muted}>{`${Math.max(status.minute, match.minute)}' · ${status.state}`}</Text> : (
              <Button size="small" appearance="primary" icon={<PlayRegular />} disabled={busy}
                onClick={() => void attempt(async () => setMatchId(await startMatch(speedFromLocation(window.location.search))), "The match could not be started.")}>
                Start match
              </Button>
            )} />
        </div>

        <div className={styles.grid}>
          <div className={styles.column}>
            <Card icon={<SlideLayoutRegular />} title="Scenes" label="Scenes"
              action={<Button as="a" href="/studio" appearance="subtle" icon={<OpenRegular />}>Edit in studio</Button>}>
              {!studio || !data ? (
                <Text className={styles.muted}>Connecting to the studio…</Text>
              ) : (
                <div className={styles.scenes}>
                  {studio.scenes.map((scene) => {
                    const isOnAir = scene.id === studio.active_scene_id;
                    return (
                      <div key={scene.id} className={mergeClasses(styles.scene, isOnAir && styles.sceneOnAir)}>
                        <div className={styles.thumb}>
                          <SceneCanvas scene={scene} data={data} scale={THUMB_SCALE} />
                        </div>
                        <div className={styles.sceneRow}>
                          <span aria-hidden style={{ display: "inline-flex", fontSize: 18, color: tokens.colorBrandForeground1 }}>{sceneIcon(scene)}</span>
                          <Text weight="semibold" truncate wrap={false} className={styles.grow}>{scene.name}</Text>
                          {isOnAir ? (
                            <Badge color="danger">On air</Badge>
                          ) : (
                            <Button size="small" icon={<PlayRegular />} aria-label={`Switch to ${scene.name}`} disabled={busy}
                              onClick={() => void attempt(async () => acceptStudio(await activateScene(scene.id)), "The scene could not be switched.")}>
                              Switch
                            </Button>
                          )}
                        </div>
                        <ModeBadge scene={scene} studio={studio} />
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>

          <div className={styles.column}>
            <Card icon={<LiveRegular />} title="Destinations" label="Destinations"
              action={<Button as="a" href="/studio" appearance="subtle" icon={<OpenRegular />}>Manage</Button>}>
              {!output || output.destinations.length === 0 ? (
                <Text className={styles.muted}>No destinations yet. Add YouTube, X, Facebook, Twitch or a recording in the studio's Output box.</Text>
              ) : (
                <ul className={styles.list}>
                  {output.destinations.map((item) => (
                    <li key={item.id} className={styles.destination}>
                      <PlatformMark platform={item.platform} size={32} />
                      <div className={mergeClasses(styles.tileText, styles.grow)}>
                        <Text weight="semibold">{item.name}</Text>
                        <Text size={200} className={styles.muted}>
                          {[
                            platformLabel(item.platform),
                            item.platform === "file" ? "Saved on this computer" : item.key_hint && `key ending ${item.key_hint}`,
                            !item.enabled && "switched off",
                          ].filter(Boolean).join(" · ")}
                        </Text>
                      </div>
                      <Badge appearance="tint" color={(STATUS[item.status] ?? STATUS.idle).color}>{(STATUS[item.status] ?? STATUS.idle).label}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card icon={<PeopleCommunityRegular />} title="Your audience" label="Audience">
              <Text className={styles.muted}>Share the fan page in your stream description. Fans vote in polls and ask questions you can put on air.</Text>
              <div className={styles.share}>
                <Text className={styles.grow}>{joinUrl}</Text>
                <Tooltip content={copied ? "Copied" : "Copy link"} relationship="label">
                  <Button size="small" appearance="subtle" icon={<CopyRegular />}
                    onClick={() => void navigator.clipboard?.writeText(joinUrl).then(() => setCopied(true), () => undefined)} />
                </Tooltip>
              </div>
              <div className={styles.step}>
                <PollRegular />
                <Text>{audience?.poll ? `${audience.poll.question} · ${votes} ${votes === 1 ? "vote" : "votes"}` : "No poll running"}</Text>
              </div>
              <div className={styles.step}>
                <ChatRegular />
                <Text>{`${openQuestions} ${openQuestions === 1 ? "question" : "questions"} waiting`}</Text>
              </div>
            </Card>

            <Card icon={<CheckmarkCircleFilled />} title="Quick start" label="Quick start">
              <ol className={styles.list}>
                {steps.map((step) => (
                  <li key={step.label} className={styles.step}>
                    {step.done ? <CheckmarkCircleFilled className={styles.done} /> : <CircleRegular className={styles.todo} />}
                    <Text style={step.done ? { textDecorationLine: "line-through", opacity: 0.7 } : undefined}>{step.label}</Text>
                  </li>
                ))}
              </ol>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
