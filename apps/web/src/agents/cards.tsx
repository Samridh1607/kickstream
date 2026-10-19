import {
  Badge, Button, makeStyles, Menu, MenuButton, MenuDivider, MenuItem, MenuList, MenuPopover, MenuTrigger, MessageBar, MessageBarActions, MessageBarBody,
  mergeClasses, Select, Text, tokens,
} from "@fluentui/react-components";
import {
  AddRegular, BrainCircuitRegular, CubeAddRegular, CubeRegular, DataTrendingRegular, DismissRegular, FlashRegular, LightbulbRegular, OpenRegular,
  PersonRunningRegular, ScanRegular,
} from "@fluentui/react-icons";
import { type ReactElement, type ReactNode, type RefObject, useCallback, useMemo, useRef, useState } from "react";
import { CompareBars, Counted, HeatGrid, LineGraph, NEUTRAL, ShareBar, type Sides, Swatch } from "../charts/charts";
import type { AgentRun, MatchStatus, PlayEvent, Studio, TeamTactics } from "../contracts";
import { type Language, type StringKey, t } from "../i18n";
import { useCanUseStudio } from "../shell/viewer";
import { isKeyEvents } from "../matches/liveData";
import { MotionStyles, rise, SETTLE, slide } from "../motion/motion";
import type { MatchData } from "../stream/store";
import { getStudio } from "../studio/api";
import { addPitch, createPitchScene, hasRoom, PITCH_TEMPLATE, pitchProps } from "../studio/pitchScene";
import { trackedPlayer } from "../studio/widgets";
import type { AgentId } from "./api";
import { type Camera, LEVEL, Pitch3D, type View } from "./Pitch3D";

export const AGENT_ICONS: Record<AgentId, ReactElement> = {
  event_interpreter: <ScanRegular />,
  tactical_analyst: <BrainCircuitRegular />,
  prediction: <DataTrendingRegular />,
  explainability: <LightbulbRegular />,
  visualization: <CubeRegular />,
  player_tracking: <PersonRunningRegular />,
  highlights: <FlashRegular />,
};

export const AGENT_NAMES: Record<AgentId, string> = {
  event_interpreter: "Event Interpreter",
  tactical_analyst: "Tactical Analyst",
  prediction: "Prediction Agent",
  explainability: "Explainability Agent",
  visualization: "Visualization Agent",
  player_tracking: "Player Tracking Agent",
  highlights: "Highlights Agent",
};

const PATTERN_LABELS: Record<TeamTactics["patterns"][number], string> = {
  high_press: "High press", wing_overload_left: "Left overload", wing_overload_right: "Right overload", central_play: "Through the middle",
  counter_attack: "Counter-attack", patient_build_up: "Patient build-up", direct_play: "Direct play", low_block: "Low block",
};
const HIGHLIGHT_LABELS: Record<string, string> = {
  goal: "Goal", red_card: "Red card", big_chance: "Big chance", momentum_swing: "Momentum shift", sustained_pressure: "Sustained pressure",
  long_sequence: "Long move", big_save: "Save", dangerous_turnover: "Ball won high", tactical_foul: "Tactical foul", unsung_player: "Unsung player",
};
const DEFAULT_COLORS: Sides = { home: "#0F6CBD", away: "#C50F1F" };

export const colorsOf = (status: MatchStatus | null): Sides => (status ? { home: status.home.color, away: status.away.color } : DEFAULT_COLORS);
export const namesOf = (status: MatchStatus | null): Sides => ({ home: status?.home.name ?? "Home", away: status?.away.name ?? "Away" });

const useStyles = makeStyles({
  card: {
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM, minWidth: 0, padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke3}`,
    transitionProperty: "box-shadow, transform", transitionDuration: "200ms",
  },
  heading: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  icon: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium, fontSize: "18px", color: tokens.colorBrandForeground1, backgroundColor: tokens.colorBrandBackground2,
  },
  grow: { flexGrow: 1 },
  muted: { color: tokens.colorNeutralForeground3 },
  chips: { display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalXS },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  scroll: { maxHeight: "360px", overflowY: "auto" },
  item: {
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXXS, padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3,
    borderLeft: `${tokens.strokeWidthThickest} solid ${tokens.colorNeutralStroke2}`,
  },
  favourite: { backgroundColor: tokens.colorPaletteYellowBackground1 },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalS },
  pitch: { height: "320px", borderRadius: tokens.borderRadiusLarge, color: "#FFFFFF", background: "linear-gradient(180deg, #0B1220 0%, #16233B 100%)" },
  tall: { height: "460px" },
  meter: { height: "8px", borderRadius: tokens.borderRadiusCircular, backgroundColor: tokens.colorNeutralBackground4, overflow: "hidden" },
  stats: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(72px, 1fr))", gap: tokens.spacingHorizontalM },
  stat: { display: "flex", flexDirection: "column" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: tokens.fontSizeBase200, "& th, & td": { textAlign: "left", padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`, whiteSpace: "nowrap" }, "& th": { color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightRegular } },
  graph: { height: "200px" },
  evidence: { margin: 0, paddingLeft: tokens.spacingHorizontalL, color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

/** A titled box, as every part of the page is drawn. */
export function Card({ agent, title, extra, children, testId }: { agent?: AgentId; title: string; extra?: ReactNode; children: ReactNode; testId?: string }) {
  const styles = useStyles();
  return (
    <section className={mergeClasses(styles.card, "ks-motion")} aria-label={title} data-testid={testId} style={{ animation: rise() }}>
      <MotionStyles />
      <div className={styles.heading}>
        {agent && <span className={styles.icon} aria-hidden>{AGENT_ICONS[agent]}</span>}
        <Text as="h2" weight="semibold" size={400}>{title}</Text>
        <span className={styles.grow} />
        {extra}
      </div>
      {children}
    </section>
  );
}

function Waiting({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <Text size={200} className={styles.muted}>{children}</Text>;
}

function LiveDataOnly({ language }: { language: Language }) {
  const styles = useStyles();
  return <Text size={200} className={styles.muted} data-testid="live-data-only">{t(language, "liveDataOnly")}</Text>;
}

interface CardProps {
  match: MatchData;
  language: Language;
}

// --- Visualization Agent ---------------------------------------------------------------------------

type Added = { intent: "success"; scene: string } | { intent: "error"; message: string };

/** Puts the 3D pitch, as the viewer has it framed, into one of the studio's scenes or a new one. */
function AddToScene(props: { camera: "auto" | Camera; view: RefObject<View>; onAdded(result: Added): void }) {
  return useCanUseStudio() ? <SceneMenu {...props} /> : null;
}

function SceneMenu({ camera, view, onAdded }: { camera: "auto" | Camera; view: RefObject<View>; onAdded(result: Added): void }) {
  const [studio, setStudio] = useState<Studio | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => {
    setFailed(false);
    getStudio().then(setStudio).catch(() => setFailed(true));
  };
  const add = async (name: string, request: () => Promise<Studio>) => {
    setBusy(true);
    try {
      setStudio(await request());
      onAdded({ intent: "success", scene: name });
    } catch (caught) {
      onAdded({ intent: "error", message: caught instanceof Error ? caught.message : "The 3D pitch could not be added." });
    } finally {
      setBusy(false);
    }
  };
  const props = () => pitchProps(camera, view.current);
  return (
    <Menu onOpenChange={(_, data) => data.open && load()}>
      <MenuTrigger disableButtonEnhancement>
        <MenuButton size="small" icon={<CubeAddRegular />} disabled={busy}>Add to scene</MenuButton>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {!studio && !failed && <MenuItem disabled>Loading scenes…</MenuItem>}
          {failed && <MenuItem disabled>The studio's scenes could not be loaded</MenuItem>}
          {studio?.scenes.map((scene) => (
            <MenuItem key={scene.id} disabled={!hasRoom(scene)} onClick={() => void add(scene.name, () => addPitch(scene, props()))}>
              Add to {scene.name}
            </MenuItem>
          ))}
          <MenuDivider />
          <MenuItem icon={<AddRegular />} onClick={() => void add(PITCH_TEMPLATE, () => createPitchScene(props()))}>New scene with 3D pitch</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

export function PitchCard({ match, language, followId, tall = false }: CardProps & { followId: string | null; tall?: boolean }) {
  const styles = useStyles();
  const [camera, setCamera] = useState<"auto" | Camera>("auto");
  const [added, setAdded] = useState<Added | null>(null);
  const view = useRef<View>(LEVEL);
  const onView = useCallback((next: View) => {
    view.current = next;
  }, []);
  const home = match.status?.home.color;
  const away = match.status?.away.color;
  const colors = useMemo(() => (home && away ? { home, away } : DEFAULT_COLORS), [home, away]);
  if (isKeyEvents(match.status)) {
    return (
      <Card agent="visualization" title={t(language, "pitch3d")} testId="card-pitch">
        <LiveDataOnly language={language} />
      </Card>
    );
  }
  return (
    <Card agent="visualization" title={t(language, "pitch3d")} testId="card-pitch"
      extra={
        <>
          <AddToScene camera={camera} view={view} onAdded={setAdded} />
          <Select size="small" aria-label="Camera" value={camera} onChange={(_, data) => setCamera(data.value as "auto" | Camera)}>
            <option value="auto">Follow the play</option>
            <option value="broadcast">Broadcast view</option>
            <option value="tactical">Tactical view</option>
            <option value="attack_home">Behind the home attack</option>
            <option value="attack_away">Behind the away attack</option>
          </Select>
        </>
      }>
      {added && (
        <MessageBar intent={added.intent}>
          <MessageBarBody>{added.intent === "success" ? `Added to ${added.scene}` : added.message}</MessageBarBody>
          <MessageBarActions containerAction={<Button appearance="transparent" size="small" aria-label="Dismiss" icon={<DismissRegular />} onClick={() => setAdded(null)} />}>
            {added.intent === "success" && <Button as="a" href="/studio" size="small" icon={<OpenRegular />}>Open studio</Button>}
          </MessageBarActions>
        </MessageBar>
      )}
      <div className={mergeClasses(styles.pitch, tall && styles.tall)}>
        <Pitch3D scene={match.pitch} colors={colors} camera={camera === "auto" ? undefined : camera} followId={followId} controls onViewChange={onView}
          label={t(language, "pitch3d")} emptyText={t(language, "pitch3dEmpty")} />
      </div>
      {match.pitch && (
        <div className={styles.row}>
          <Text size={200} className={styles.muted}>{t(language, "estimated")}. The dashed figures are placed from the formation and the ball.</Text>
          <span className={styles.grow} />
          <Badge appearance="tint">{match.pitch.columns.length} danger zones</Badge>
          <Badge appearance="tint">{match.pitch.lanes.length} pass lanes</Badge>
        </div>
      )}
    </Card>
  );
}

// --- Prediction Agent ------------------------------------------------------------------------------

function Odds({ label, value, color }: { label: string; value: number; color: string }) {
  const styles = useStyles();
  return (
    <div>
      <div className={styles.row}>
        <Swatch color={color} />
        <Text size={200}>{label}</Text>
        <span className={styles.grow} />
        <Text weight="semibold"><Counted value={value * 100} suffix="%" /></Text>
      </div>
      <div className={styles.meter} aria-hidden>
        <div style={{ width: `${value * 100}%`, height: "100%", backgroundColor: color, borderRadius: 999, transition: `width ${SETTLE}` }} />
      </div>
    </div>
  );
}

export function PredictionCard({ match, language, detailed = false }: CardProps & { detailed?: boolean }) {
  const styles = useStyles();
  const prediction = match.prediction;
  const colors = colorsOf(match.status);
  const names = namesOf(match.status);
  const side = prediction?.possession ?? null;
  return (
    <Card agent="prediction" title={t(language, "winProbability")} testId="card-prediction" extra={prediction && <Badge appearance="outline">{prediction.minute}'</Badge>}>
      {!prediction ? <Waiting>{t(language, "predictionEmpty")}</Waiting> : (
        <>
          <ShareBar label={t(language, "winProbability")} parts={[
            { id: "home", label: names.home, value: prediction.win_home, color: colors.home },
            { id: "draw", label: t(language, "draw"), value: prediction.draw, color: NEUTRAL },
            { id: "away", label: names.away, value: prediction.win_away, color: colors.away },
          ]} />
          <Text size={200} weight="semibold">{t(language, "nextGoal")}</Text>
          <Odds label={names.home} value={prediction.next_goal_home} color={colors.home} />
          <Odds label={names.away} value={prediction.next_goal_away} color={colors.away} />
          {prediction.next_actions.length > 0 && (
            <>
              <Text size={200} weight="semibold">{t(language, "nextAction")}{side ? ` · ${names[side]} ${t(language, "onTheBall")}` : ""}</Text>
              {prediction.next_actions.map((action) => (
                <Odds key={action.action} label={t(language, `action_${action.action}` as StringKey)} value={action.probability} color={side ? colors[side] : NEUTRAL} />
              ))}
            </>
          )}
          {detailed && (
            <>
              <div className={styles.graph}>
                <LineGraph label={t(language, "winProbability")} xs={match.series.map((point) => point.minute)} xMax={Math.max(90, match.minute)} yMin={0} yMax={100}
                  format={(value) => `${value.toFixed(0)}%`} surface={tokens.colorNeutralBackground1}
                  lines={[
                    { id: "home", label: names.home, color: colors.home, values: match.series.map((point) => (point.winHome === null ? null : point.winHome * 100)) },
                    { id: "draw", label: t(language, "draw"), color: NEUTRAL, values: match.series.map((point) => (point.draw === null ? null : point.draw * 100)) },
                    { id: "away", label: names.away, color: colors.away, values: match.series.map((point) => (point.winAway === null ? null : point.winAway * 100)) },
                  ]} />
              </div>
              <Text size={200} weight="semibold">Where the danger has been coming from</Text>
              {isKeyEvents(match.status) ? <LiveDataOnly language={language} /> : (
                <div style={{ maxWidth: 360 }}>
                  <HeatGrid cols={prediction.cols} rows={prediction.rows} values={prediction.danger} color={tokens.colorPaletteMarigoldBackground3} label="Danger by zone of the pitch" />
                </div>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
}

// --- Tactical Analyst ------------------------------------------------------------------------------

export function TacticsCard({ match, language }: CardProps) {
  const styles = useStyles();
  const tactics = match.tactics;
  const colors = colorsOf(match.status);
  const names = namesOf(match.status);
  const patterns = (side: "home" | "away") => (
    <div className={styles.chips} aria-label={`${names[side]} patterns`}>
      <Swatch color={colors[side]} />
      {tactics && tactics[side].patterns.length === 0 && <Text size={200} className={styles.muted}>No pattern yet</Text>}
      {tactics?.[side].patterns.map((pattern) => (
        <Badge key={pattern} appearance="tint" color="brand" style={{ animation: slide() }}>{PATTERN_LABELS[pattern]}</Badge>
      ))}
    </div>
  );
  if (isKeyEvents(match.status)) {
    return (
      <Card agent="tactical_analyst" title={t(language, "tactics")} testId="card-tactics">
        <LiveDataOnly language={language} />
      </Card>
    );
  }
  return (
    <Card agent="tactical_analyst" title={t(language, "tactics")} testId="card-tactics"
      extra={tactics && <Badge appearance="tint" color={tactics.rhythm === "frantic" || tactics.rhythm === "fast" ? "danger" : "informative"}>Rhythm: {tactics.rhythm}</Badge>}>
      {!tactics ? <Waiting>{t(language, "graphEmpty")}</Waiting> : (
        <>
          <Text data-testid="tactics-summary">{tactics.summary}</Text>
          <CompareBars colors={colors} names={names} rows={[
            { id: "pressure", label: t(language, "pressure"), home: tactics.home.pressure, away: tactics.away.pressure },
            { id: "tempo", label: t(language, "tempo"), home: tactics.home.tempo, away: tactics.away.tempo, digits: 1 },
            { id: "tilt", label: t(language, "fieldTilt"), home: tactics.home.field_tilt, away: tactics.away.field_tilt },
            { id: "move", label: t(language, "averageMove"), home: tactics.home.avg_sequence, away: tactics.away.avg_sequence, digits: 1 },
          ]} />
          {patterns("home")}
          {patterns("away")}
        </>
      )}
    </Card>
  );
}

// --- Player Tracking Agent -------------------------------------------------------------------------

export function PlayerCard({ match, language, playerId, onChoose, detailed = false }: CardProps & { playerId: string | null; onChoose?(playerId: string | null): void; detailed?: boolean }) {
  const styles = useStyles();
  const player = trackedPlayer(match, playerId);
  const report = match.players;
  const colors = colorsOf(match.status);
  const followed = playerId !== null && player?.player_id === playerId;
  const ranked = report ? [...report.players].sort((a, b) => b.rating - a.rating || b.touches - a.touches).slice(0, 8) : [];
  return (
    <Card agent="player_tracking" title={followed ? t(language, "favoritePlayer") : "Player tracking"} testId="card-player"
      extra={report && onChoose && (
        <Select size="small" aria-label="Player to follow" value={playerId ?? ""} onChange={(_, data) => onChoose(data.value || null)}>
          <option value="">Best rated so far</option>
          {report.players.map((line) => <option key={line.player_id} value={line.player_id}>{line.number}. {line.name}</option>)}
        </Select>
      )}>
      {!player || !report ? <Waiting>{t(language, "playerEmpty")}</Waiting> : (
        <>
          <div className={styles.row}>
            <span style={{ display: "grid", placeItems: "center", width: 40, height: 40, borderRadius: 10, color: "#FFFFFF", fontWeight: 700, backgroundColor: colors[player.team] }}>{player.number}</span>
            <div className={styles.stat}>
              <Text weight="semibold" size={400} data-testid="tracked-name">{player.name}</Text>
              <Text size={200} className={styles.muted}>{player.position}{player.on_pitch ? "" : ` · ${t(language, "offPitch")}`}</Text>
            </div>
            <span className={styles.grow} />
            <div className={styles.stat} style={{ textAlign: "right" }}>
              <Text size={600} weight="bold"><Counted value={player.rating} digits={1} /></Text>
              <Text size={200} className={styles.muted}>{t(language, "rating")}</Text>
            </div>
          </div>
          <div className={styles.stats}>
            {([
              ["touches", player.touches, 0], ["passes", player.passes, 0], ["passAccuracy", player.pass_accuracy, 0], ["shots", player.shots, 0],
              ["xg", player.xg, 2], ["goals", player.goals, 0], ["fouls", player.fouls, 0],
              ["distance", player.distance ?? 0, 0], ["topSpeed", player.top_speed ?? 0, 0],
            ] as [StringKey, number, number][]).map(([key, value, digits]) => (
              <div key={key} className={styles.stat}>
                <Text weight="semibold" size={400}><Counted value={value} digits={digits} /></Text>
                <Text size={100} className={styles.muted}>{t(language, key)}</Text>
              </div>
            ))}
          </div>
          {player.callout ? (
            <Text size={200} data-testid="player-callout">{player.callout}</Text>
          ) : null}
          <div style={{ maxWidth: 360 }}>
            <HeatGrid cols={report.cols} rows={report.rows} values={player.heat} color={colors[player.team]} label={`${player.name}: ${t(language, "touches")}`} />
          </div>
          {detailed && (
            <table className={styles.table} aria-label="Best rated players">
              <thead><tr><th>#</th><th>Player</th><th>{t(language, "rating")}</th><th>{t(language, "touches")}</th><th>{t(language, "passAccuracy")}</th><th>{t(language, "goals")}</th></tr></thead>
              <tbody>
                {ranked.map((line) => (
                  <tr key={line.player_id}>
                    <td><Swatch color={colors[line.team]} /> {line.number}</td><td>{line.name}</td><td>{line.rating.toFixed(1)}</td><td>{line.touches}</td><td>{line.pass_accuracy.toFixed(0)}</td><td>{line.goals}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Card>
  );
}

/** The followed player's key moments and highlights, newest first, kept for the whole match. */
export function TheirMomentsCard({ match, language, playerId, onStop }: CardProps & { playerId: string; onStop(): void }) {
  const styles = useStyles();
  const colors = colorsOf(match.status);
  const covered = new Set(match.highlights.map((highlight) => highlight.moment_id));
  const items = [
    ...match.highlights.filter((highlight) => highlight.player_id === playerId)
      .map((highlight) => ({ id: highlight.id, minute: highlight.minute, team: highlight.team, title: highlight.title, detail: highlight.reason })),
    ...match.moments.filter((moment) => moment.player_id === playerId && !covered.has(moment.id))
      .map((moment) => ({ id: moment.id, minute: moment.minute, team: moment.team, title: HIGHLIGHT_LABELS[moment.kind], detail: `${moment.score_home}–${moment.score_away}` })),
  ].sort((a, b) => b.minute - a.minute);
  return (
    <Card agent="highlights" title={t(language, "theirMoments")} testId="card-their-moments"
      extra={<Button size="small" appearance="subtle" icon={<DismissRegular />} onClick={onStop}>{t(language, "stopFollowing")}</Button>}>
      {items.length === 0 && <Waiting>{t(language, "theirMomentsEmpty")}</Waiting>}
      <ul className={mergeClasses(styles.list, styles.scroll)}>
        {items.map((item) => (
          <li key={item.id} data-testid="their-moment" className={mergeClasses(styles.item, styles.favourite)} style={{ borderLeftColor: colors[item.team], animation: slide() }}>
            <Text weight="semibold">{item.minute}' {item.title}</Text>
            <Text size={200} className={styles.muted}>{item.detail}</Text>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// --- Highlights Agent ------------------------------------------------------------------------------

export function HighlightsCard({ match, language, limit = 8 }: CardProps & { limit?: number }) {
  const styles = useStyles();
  const [show, setShow] = useState<"all" | "key" | "hidden">("all");
  const colors = colorsOf(match.status);
  const ranked = match.highlights.filter((highlight) => show === "all" || highlight.kind === show).sort((a, b) => b.score - a.score || b.minute - a.minute).slice(0, limit);
  return (
    <Card agent="highlights" title="Highlights" testId="card-highlights"
      extra={
        <Select size="small" aria-label="Highlights to show" value={show} onChange={(_, data) => setShow(data.value as typeof show)}>
          <option value="all">Key and hidden</option>
          <option value="key">Key moments</option>
          <option value="hidden">Hidden events</option>
        </Select>
      }>
      {ranked.length === 0 && <Waiting>Highlights appear here, best first, as the match is played.</Waiting>}
      <ul className={mergeClasses(styles.list, styles.scroll)}>
        {ranked.map((highlight) => (
          <li key={highlight.id} data-testid="highlight" data-kind={highlight.kind} className={mergeClasses(styles.item, highlight.highlighted && styles.favourite)}
            style={{ borderLeftColor: colors[highlight.team], animation: slide() }}>
            <div className={styles.row}>
              <Text weight="semibold">{highlight.minute}' {highlight.title}</Text>
              <span className={styles.grow} />
              <Badge appearance={highlight.kind === "hidden" ? "filled" : "tint"} color={highlight.kind === "hidden" ? "important" : "brand"}>
                {highlight.kind === "hidden" ? "Hidden" : "Key"} · {HIGHLIGHT_LABELS[highlight.category]}
              </Badge>
              <Badge appearance="outline">{Math.round(highlight.score)}</Badge>
            </div>
            <Text size={200} className={styles.muted}>{highlight.reason}</Text>
            {highlight.highlighted && <Text size={200}>{t(language, "highlighted")}</Text>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// --- Explainability Agent --------------------------------------------------------------------------

export function ExplanationsCard({ match, language, limit = 4, evidence = false }: CardProps & { limit?: number; evidence?: boolean }) {
  const styles = useStyles();
  const colors = colorsOf(match.status);
  const shown = match.explanations.slice(0, limit);
  return (
    <Card agent="explainability" title={t(language, "whyItMatters")} testId="card-explanations">
      {shown.length === 0 && <Waiting>{t(language, "insightEmpty")}</Waiting>}
      <ul className={mergeClasses(styles.list, styles.scroll)}>
        {shown.map((explanation) => (
          <li key={explanation.id} data-testid="explanation" className={styles.item} style={{ borderLeftColor: explanation.team ? colors[explanation.team] : NEUTRAL, animation: slide() }}>
            <div className={styles.row}>
              <Text weight="semibold">{explanation.minute}' {explanation.headline}</Text>
              <span className={styles.grow} />
              <Badge appearance="outline">{explanation.subject_kind}</Badge>
              {explanation.source === "scripted" && <Badge appearance="outline">{t(language, "scripted")}</Badge>}
            </div>
            <Text>{explanation.why}</Text>
            {evidence && (
              <ul className={styles.evidence} aria-label={t(language, "evidence")}>
                {explanation.evidence.map((fact) => <li key={fact}>{fact}</li>)}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// --- Event Interpreter -----------------------------------------------------------------------------

const words = (value: string) => value.replace(/_/g, " ");

export function PlaysCard({ match, limit = 10 }: { match: MatchData; limit?: number }) {
  const styles = useStyles();
  const colors = colorsOf(match.status);
  const plays: PlayEvent[] = [...match.plays].reverse().slice(0, limit);
  return (
    <Card agent="event_interpreter" title="Structured events" testId="card-plays">
      {plays.length === 0 ? <Waiting>Each detection appears here as a structured event.</Waiting> : (
        <div style={{ overflowX: "auto" }}>
          <table className={styles.table}>
            <thead><tr><th>Time</th><th>Event</th><th>Where</th><th>Phase</th><th>Move</th><th>Danger</th></tr></thead>
            <tbody>
              {plays.map((play) => (
                <tr key={play.id} data-testid="play">
                  <td>{play.minute}:{String(play.second).padStart(2, "0")}</td>
                  <td>{play.team && <Swatch color={colors[play.team]} />} {words(play.type)}</td>
                  <td>{words(play.zone)}, {play.lane}</td>
                  <td>{words(play.phase)}</td>
                  <td>#{play.sequence} · {play.sequence_length}</td>
                  <td>
                    <span className={styles.meter} style={{ display: "inline-block", width: 56, verticalAlign: "middle" }} aria-hidden>
                      <span style={{ display: "block", width: `${play.danger * 100}%`, height: "100%", backgroundColor: tokens.colorPaletteMarigoldBackground3, transition: `width ${SETTLE}` }} />
                    </span>{" "}
                    {play.danger.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// --- the trace -------------------------------------------------------------------------------------

export function ActivityList({ runs, onPick }: { runs: readonly AgentRun[]; onPick?(agentId: AgentId): void }) {
  const styles = useStyles();
  if (runs.length === 0) return <Waiting>Each agent's work appears here, newest first.</Waiting>;
  return (
    <ol className={styles.list} aria-label="Activity">
      {runs.map((run) => (
        <li key={run.id} data-testid="agent-run" className={styles.item} style={{ animation: slide(), cursor: onPick ? "pointer" : undefined }} onClick={onPick ? () => onPick(run.agent) : undefined}>
          <div className={styles.row}>
            <span className={styles.icon} style={{ width: 22, height: 22, fontSize: 14 }} aria-hidden>{AGENT_ICONS[run.agent]}</span>
            <Text size={200} weight="semibold">{AGENT_NAMES[run.agent]}</Text>
            <span className={styles.grow} />
            <Text size={100} className={styles.muted}>{run.minute}'</Text>
          </div>
          <Text size={200}>{words(run.trigger)} → {run.count} × {words(run.produced)}{run.source === "agent" ? " · model" : ""} · {run.duration_ms.toFixed(1)} ms</Text>
          {run.note && <Text size={200} className={styles.muted}>{run.note}</Text>}
        </li>
      ))}
    </ol>
  );
}
