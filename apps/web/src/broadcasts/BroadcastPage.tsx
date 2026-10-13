import {
  Badge, Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, DialogTrigger, makeStyles,
  mergeClasses, MessageBar, MessageBarBody, Spinner, Text, tokens,
} from "@fluentui/react-components";
import {
  ArrowDownloadRegular, ArrowLeftRegular, BotSparkleRegular, ChatRegular, DeleteRegular, FilmstripRegular, FlashRegular,
  LiveRegular, PeopleCommunityRegular, PlayRegular, PollRegular, RecordRegular, RecordStopRegular, SparkleRegular,
  SportSoccerRegular, TimerRegular, VideoClipMultipleRegular,
} from "@fluentui/react-icons";
import { type ReactNode, useState } from "react";
import type { Broadcast, Broadcasts, Output } from "../contracts";
import { OUTPUT_STREAM } from "../output/api";
import { AppNav } from "../shell/AppNav";
import { PlatformMark } from "../shell/PlatformMark";
import { useLiveDocument } from "../stream/useLiveDocument";
import { useNow } from "../studio/useStudio";
import { BROADCASTS_STREAM, deleteBroadcast, deleteReel, endBroadcast, generateReels, goLiveWith, recordingUrl } from "./api";
import { bytes, clock, duration, intoBroadcast, MOMENT_LABELS, onAir, plural, reach, STATE, teamName, votes, when } from "./format";
import { ReelCard } from "./ReelCard";

const MAX_REELS = 12;

const OUTCOME = {
  live: { label: "Reached", color: "success" },
  failed: { label: "Failed", color: "danger" },
  off: { label: "Not reached", color: "subtle" },
} as const;

const useStyles = makeStyles({
  page: { minHeight: "100vh", display: "flex", flexDirection: "column", backgroundColor: tokens.colorNeutralBackground2 },
  main: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXL, padding: tokens.spacingHorizontalXXL, maxWidth: "1480px", width: "100%", boxSizing: "border-box", margin: "0 auto" },
  header: {
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM, padding: tokens.spacingHorizontalXXL, borderRadius: "20px",
    color: "#FFFFFF", boxShadow: tokens.shadow16,
    backgroundImage: "radial-gradient(circle at 85% 10%, rgba(217, 45, 32, 0.35), transparent 40%), linear-gradient(135deg, #1C0F33 0%, #3A1A78 55%, #6528CF 100%)",
  },
  back: { display: "inline-flex", alignItems: "center", gap: "6px", color: "rgba(255, 255, 255, 0.85)", textDecorationLine: "none", fontSize: tokens.fontSizeBase200, ":hover": { color: "#FFFFFF", textDecorationLine: "underline" } },
  headRow: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalS },
  title: { margin: 0, fontSize: "36px", lineHeight: 1.15, fontWeight: tokens.fontWeightBold, overflowWrap: "anywhere" },
  description: { opacity: 0.9, maxWidth: "760px", lineHeight: 1.5 },
  when: { opacity: 0.8, fontSize: tokens.fontSizeBase200 },
  actions: { display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalS },
  red: { backgroundColor: "#D92D20", color: "#FFFFFF", border: "none", ":hover": { backgroundColor: "#B42318", color: "#FFFFFF" }, ":hover:active": { backgroundColor: "#912018", color: "#FFFFFF" } },
  ghost: { color: "#FFFFFF", backgroundColor: "rgba(255, 255, 255, 0.12)", border: "1px solid rgba(255, 255, 255, 0.3)", ":hover": { color: "#FFFFFF", backgroundColor: "rgba(255, 255, 255, 0.22)" } },
  tiles: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: tokens.spacingHorizontalL },
  tile: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalM, padding: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke3}` },
  tileIcon: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: "44px", height: "44px", flexShrink: 0, borderRadius: "12px", fontSize: "24px" },
  tileText: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
  grid: { display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(320px, 2fr)", gap: tokens.spacingHorizontalXL, alignItems: "start", "@media (max-width: 1100px)": { gridTemplateColumns: "minmax(0, 1fr)" } },
  column: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXL, minWidth: 0 },
  card: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM, padding: tokens.spacingHorizontalXL, borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke3}`, minWidth: 0 },
  cardHead: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalS },
  cardIcon: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: "32px", height: "32px", borderRadius: tokens.borderRadiusMedium, fontSize: "18px", color: tokens.colorBrandForeground1, backgroundColor: tokens.colorBrandBackground2 },
  grow: { flexGrow: 1 },
  muted: { color: tokens.colorNeutralForeground3 },
  player: { width: "100%", aspectRatio: "16 / 9", borderRadius: tokens.borderRadiusLarge, backgroundColor: "#000000", display: "block" },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  row: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalM, padding: tokens.spacingHorizontalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3, minWidth: 0 },
  rowSelected: { outline: `${tokens.strokeWidthThick} solid ${tokens.colorBrandStroke1}` },
  rowText: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0, flexGrow: 1 },
  ai: { display: "flex", alignItems: "flex-start", gap: tokens.spacingHorizontalS, padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorBrandBackground2, color: tokens.colorNeutralForeground2 },
  aiIcon: { fontSize: "20px", color: tokens.colorBrandForeground1, flexShrink: 0, marginTop: "2px" },
  reels: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: tokens.spacingHorizontalL },
  generating: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  moment: { display: "flex", alignItems: "flex-start", gap: tokens.spacingHorizontalM, padding: tokens.spacingHorizontalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  minute: { display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: "44px", height: "28px", borderRadius: "999px", fontWeight: tokens.fontWeightBold, fontSize: tokens.fontSizeBase200, color: "#FFFFFF", backgroundColor: "#3A1A78", flexShrink: 0 },
  goal: { backgroundColor: "#D92D20" },
  session: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, padding: tokens.spacingHorizontalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  destination: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS, minWidth: 0 },
  empty: { color: tokens.colorNeutralForeground3, padding: `${tokens.spacingVerticalM} 0` },
});

function Card({ icon, title, action, children }: { icon: ReactNode; title: string; action?: ReactNode; children: ReactNode }) {
  const styles = useStyles();
  return (
    <section className={styles.card} aria-label={title}>
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
    <div className={styles.tile} role="group" aria-label={label}>
      <span className={styles.tileIcon} aria-hidden style={{ color: tint, backgroundColor: `${tint}1F` }}>{icon}</span>
      <div className={styles.tileText}>
        <Text size={200} className={styles.muted}>{label}</Text>
        <Text weight="semibold" size={500} truncate wrap={false}>{value}</Text>
        {detail && <Text size={200} className={styles.muted} truncate wrap={false}>{detail}</Text>}
      </div>
    </div>
  );
}

interface Props {
  broadcastId: string;
  eventSource?: new (url: string) => EventSource;
  retryMs?: number;
}

/** One broadcast: what happened while it was live, its recording, and the reels made from it. */
export function BroadcastPage({ broadcastId, eventSource, retryMs }: Props) {
  const styles = useStyles();
  const { doc, offset, accept } = useLiveDocument<Broadcasts>(BROADCASTS_STREAM, eventSource, retryMs);
  const { doc: output } = useLiveDocument<Output>(OUTPUT_STREAM, eventSource, retryMs);
  const now = useNow() + offset;
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);

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

  const broadcast = doc?.broadcasts.find((item) => item.id === broadcastId) ?? null;

  return (
    <div className={styles.page}>
      <AppNav current="home" output={output} now={now} />
      <main className={styles.main}>
        {problem && (
          <MessageBar intent="error">
            <MessageBarBody>{problem}</MessageBarBody>
          </MessageBar>
        )}
        {doc === null ? (
          <Spinner label="Loading the broadcast…" />
        ) : broadcast === null ? (
          <MessageBar intent="warning">
            <MessageBarBody>
              This broadcast no longer exists. <a href="/">Back to all broadcasts</a>
            </MessageBarBody>
          </MessageBar>
        ) : (
          <Details broadcast={broadcast} doc={doc} output={output} now={now} busy={busy} playing={playing} setPlaying={setPlaying}
            run={(request, failure) => void attempt(async () => accept(await request()), failure)}
            remove={() => void attempt(async () => {
              await deleteBroadcast(broadcast.id);
              window.location.assign("/");
            }, "The broadcast could not be deleted.")} />
        )}
      </main>
    </div>
  );
}

interface DetailsProps {
  broadcast: Broadcast;
  doc: Broadcasts;
  output: Output | null;
  now: number;
  busy: boolean;
  playing: string | null;
  setPlaying: (file: string) => void;
  run: (request: () => Promise<Broadcasts>, failure: string) => void;
  remove: () => void;
}

function Details({ broadcast, doc, output, now, busy, playing, setPlaying, run, remove }: DetailsProps) {
  const styles = useStyles();
  const state = STATE[broadcast.state];
  const live = broadcast.state === "live";
  const outputRunning = (output?.state ?? "idle") !== "idle";
  const { reached, total } = reach(broadcast);
  const score = broadcast.stats.score;
  const recordings = [...broadcast.recordings].sort((a, b) => (b.made_at - b.started_at) - (a.made_at - a.started_at));
  const shown = recordings.find((item) => item.file === playing) ?? recordings[0] ?? null;
  const readyReels = broadcast.reels.filter((reel) => reel.state === "ready").length;
  const canGenerate = !live && recordings.length > 0 && !broadcast.generating && broadcast.reels.length < MAX_REELS;
  const generateLabel = doc.ai ? "Generate reels with AI agents" : "Generate reels";

  return (
    <>
      <section className={styles.header} aria-label="Broadcast">
        <a href="/" className={styles.back}><ArrowLeftRegular /> All broadcasts</a>
        <div className={styles.headRow}>
          <Badge appearance="filled" color={state.color} icon={live ? <LiveRegular /> : undefined}>{state.label}</Badge>
          <Text className={styles.when}>{`Created ${when(broadcast.created_at)}`}</Text>
          {broadcast.record && <Badge appearance="tint" color="success" icon={<RecordRegular />}>Recording on</Badge>}
        </div>
        <h1 className={styles.title}>{broadcast.title}</h1>
        {broadcast.description && <Text className={styles.description}>{broadcast.description}</Text>}
        {broadcast.problem && (
          <MessageBar intent="warning">
            <MessageBarBody>{`The stream stopped: ${broadcast.problem}`}</MessageBarBody>
          </MessageBar>
        )}
        <div className={styles.actions}>
          {broadcast.state === "ready" && (
            <Button size="large" icon={<LiveRegular />} className={styles.red} disabled={busy || outputRunning}
              onClick={() => run(() => goLiveWith(broadcast.id), "The broadcast could not go live.")}>
              {broadcast.sessions.length > 0 ? "Go live again" : "Go live"}
            </Button>
          )}
          {broadcast.state !== "ended" && (
            <Button size="large" icon={<RecordStopRegular />} className={live ? styles.red : styles.ghost} disabled={busy || output?.state === "stopping"}
              onClick={() => run(() => endBroadcast(broadcast.id), "The broadcast could not end.")}>
              End broadcast
            </Button>
          )}
          <Button as="a" href="/studio" size="large" icon={<VideoClipMultipleRegular />} className={styles.ghost}>Open studio</Button>
          {!live && (
            <Dialog>
              <DialogTrigger disableButtonEnhancement>
                <Button size="large" icon={<DeleteRegular />} className={styles.ghost} disabled={busy || broadcast.generating}>Delete</Button>
              </DialogTrigger>
              <DialogSurface>
                <DialogBody>
                  <DialogTitle>Delete this broadcast?</DialogTitle>
                  <DialogContent>Its sessions, stats and reels are deleted. Recordings stay on this computer.</DialogContent>
                  <DialogActions>
                    <DialogTrigger disableButtonEnhancement><Button appearance="secondary">Keep it</Button></DialogTrigger>
                    <Button appearance="primary" onClick={remove}>Delete broadcast</Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>
          )}
        </div>
      </section>

      <div className={styles.tiles}>
        <Tile icon={<TimerRegular />} tint="#D92D20" label="Time on air" value={live ? clock(onAir(broadcast, now)) : duration(onAir(broadcast, now))}
          detail={plural(broadcast.sessions.length, "session")} />
        <Tile icon={<LiveRegular />} tint="#7535E3" label="Destinations reached" value={total > 0 ? `${reached} of ${total}` : "—"}
          detail={total > 0 && reached === total ? "Every destination got the stream" : "Platforms and recordings"} />
        <Tile icon={<PeopleCommunityRegular />} tint="#0E9F6E" label="Audience" value={plural(votes(broadcast), "vote")}
          detail={`${plural(broadcast.stats.polls.length, "poll")} · ${plural(broadcast.stats.questions, "question")}`} />
        <Tile icon={<SportSoccerRegular />} tint="#0866FF" label="Match" value={score ? `${score.score_home}–${score.score_away}` : "No match"}
          detail={score ? `${score.home} v ${score.away}` : "Start the match feed while live"} />
        <Tile icon={<FlashRegular />} tint="#DC6803" label="Key moments" value={broadcast.moments.length}
          detail={`${plural(readyReels, "reel")} made`} />
      </div>

      <div className={styles.grid}>
        <div className={styles.column}>
          <Card icon={<RecordRegular />} title="Recording">
            {shown === null ? (
              <Text className={styles.empty}>
                {live ? "The recording is listed here when the broadcast ends."
                  : broadcast.record ? "No recording yet. It is saved while the broadcast is live." : "Recording was off for this broadcast."}
              </Text>
            ) : (
              <>
                <video key={shown.file} className={styles.player} src={recordingUrl(broadcast.id, shown.file)} controls preload="metadata" aria-label="Recording player" />
                <ul className={styles.list} aria-label="Recordings">
                  {recordings.map((item) => (
                    <li key={item.file} className={mergeClasses(styles.row, item.file === shown.file && styles.rowSelected)}>
                      <PlatformMark platform="file" size={32} />
                      <div className={styles.rowText}>
                        <Text weight="semibold" truncate wrap={false}>{item.file}</Text>
                        <Text size={200} className={styles.muted}>{`${duration(item.made_at - item.started_at)} · ${bytes(item.size_bytes)} · ${when(item.started_at)}`}</Text>
                      </div>
                      {item.file !== shown.file && (
                        <Button size="small" appearance="subtle" icon={<PlayRegular />} onClick={() => setPlaying(item.file)} aria-label={`Play ${item.file}`} />
                      )}
                      <Button as="a" size="small" appearance="subtle" icon={<ArrowDownloadRegular />} href={recordingUrl(broadcast.id, item.file)} download={item.file}
                        aria-label={`Download ${item.file}`} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>

          <Card icon={<FilmstripRegular />} title="Reels"
            action={
              <Button appearance="primary" icon={doc.ai ? <BotSparkleRegular /> : <SparkleRegular />} disabled={busy || !canGenerate}
                onClick={() => run(() => generateReels(broadcast.id), "The reels could not be started.")}>
                {generateLabel}
              </Button>
            }>
            <div className={styles.ai}>
              <BotSparkleRegular className={styles.aiIcon} />
              <Text size={200}>
                {doc.ai
                  ? "Two AI agents work on your recording: the Highlight Editor picks the moments worth a reel, and the Social Copywriter writes a title, caption and hashtags for each. Each reel is a 15-second vertical clip, ready for Shorts, Reels and TikTok."
                  : "No AI model is set, so templates pick the moments and write the posts. Set KICKSTREAM_LLM_BASE_URL, KICKSTREAM_LLM_MODEL and KICKSTREAM_LLM_API_KEY to have the AI agents do it. Each reel is a 15-second vertical clip, ready for Shorts, Reels and TikTok."}
              </Text>
            </div>
            {broadcast.generating && (
              <div className={styles.generating} role="status">
                <Spinner size="tiny" />
                <Text>{doc.ai ? "The agents are picking moments and cutting clips…" : "Picking moments and cutting clips…"}</Text>
              </div>
            )}
            {broadcast.reels.length === 0 ? (
              !broadcast.generating && (
                <Text className={styles.empty}>
                  {live ? "Reels are made once the broadcast is off air."
                    : recordings.length === 0 ? "Reels are cut from the recording, and this broadcast has none." : "No reels yet. Generate some from the recording."}
                </Text>
              )
            ) : (
              <div className={styles.reels}>
                {broadcast.reels.map((reel) => (
                  <ReelCard key={reel.id} broadcastId={broadcast.id} reel={reel} busy={busy}
                    onDelete={() => run(() => deleteReel(broadcast.id, reel.id), "The reel could not be deleted.")} />
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className={styles.column}>
          <Card icon={<FlashRegular />} title="Key moments">
            {broadcast.moments.length === 0 ? (
              <Text className={styles.empty}>Goals, red cards and big chances while live appear here, and become reels.</Text>
            ) : (
              <ul className={styles.list}>
                {broadcast.moments.map((moment) => (
                  <li key={moment.id} className={styles.moment}>
                    <span className={mergeClasses(styles.minute, moment.kind === "goal" && styles.goal)}>{`${moment.minute}'`}</span>
                    <div className={styles.rowText}>
                      <Text weight="semibold">
                        {[MOMENT_LABELS[moment.kind], teamName(broadcast, moment.team)].filter(Boolean).join(" · ")}
                        {` (${moment.score_home}–${moment.score_away})`}
                      </Text>
                      {moment.commentary && <Text size={200}>{moment.commentary}</Text>}
                      <Text size={200} className={styles.muted}>{`${clock(intoBroadcast(broadcast, moment.at))} into the broadcast`}</Text>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card icon={<LiveRegular />} title="Sessions">
            {broadcast.sessions.length === 0 ? (
              <Text className={styles.empty}>Not live yet. Each time the broadcast goes live, a session is kept here with how every destination fared.</Text>
            ) : (
              <ol className={styles.list}>
                {broadcast.sessions.map((session, index) => (
                  <li key={session.started_at} className={styles.session}>
                    <Text weight="semibold">
                      {`Session ${index + 1} · ${when(session.started_at)} · ${session.ended_at === null || session.ended_at === undefined ? `live for ${clock(now - session.started_at)}` : duration(session.ended_at - session.started_at)}`}
                    </Text>
                    {session.problem && <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>{session.problem}</Text>}
                    {session.destinations.map((destination) => (
                      <div key={destination.id} className={styles.destination}>
                        <PlatformMark platform={destination.platform} size={22} />
                        <Text className={styles.grow} truncate wrap={false}>{destination.name}</Text>
                        <Badge size="small" appearance="tint" color={OUTCOME[destination.outcome].color}>{OUTCOME[destination.outcome].label}</Badge>
                      </div>
                    ))}
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card icon={<PollRegular />} title="Audience">
            {broadcast.stats.polls.length === 0 && broadcast.stats.questions === 0 ? (
              <Text className={styles.empty}>Polls and fan questions while live are counted here.</Text>
            ) : (
              <ul className={styles.list}>
                {broadcast.stats.polls.map((poll) => (
                  <li key={poll.id} className={styles.row}>
                    <PollRegular />
                    <Text className={styles.grow}>{poll.question}</Text>
                    <Badge appearance="tint" color="brand">{plural(poll.votes, "vote")}</Badge>
                  </li>
                ))}
                <li className={styles.row}>
                  <ChatRegular />
                  <Text className={styles.grow}>Fan questions</Text>
                  <Badge appearance="tint" color="informative">{broadcast.stats.questions}</Badge>
                </li>
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
