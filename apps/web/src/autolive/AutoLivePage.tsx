import {
  Badge, Button, Checkbox, Field, Input, makeStyles, MessageBar, MessageBarBody, Select, Slider, Switch, Text, tokens,
} from "@fluentui/react-components";
import {
  BotSparkleRegular, ChatSparkleRegular, LiveRegular, NextRegular, PlayRegular, Speaker2Regular, SpeakerMuteRegular,
} from "@fluentui/react-icons";
import { useEffect, useMemo, useState } from "react";
import type { AutoLive, AutoLiveSettings, FanZone, Output, ViewerProfile } from "../contracts";
import { FANS_STREAM } from "../fans/api";
import { OUTPUT_STREAM } from "../output/api";
import { AppNav } from "../shell/AppNav";
import { useCanUseStudio } from "../shell/viewer";
import { useMatch } from "../stream/store";
import { type CurrentMatchOptions, useCurrentMatch } from "../stream/useCurrentMatch";
import { useLiveDocument } from "../stream/useLiveDocument";
import { programAudio, startCapture } from "../studio/capture";
import type { ProgramData } from "../studio/elements";
import { CANVAS, fitScale } from "../studio/geometry";
import { useWindowSize } from "../studio/ProgramPage";
import { useCaptureOffer } from "../studio/useCaptureOffer";
import { useNow, useStudio } from "../studio/useStudio";
import { AUTOLIVE_STREAM, nextScene, sayNow, saveAutoLiveSettings, showScene } from "./api";
import { AutoLiveStage } from "./AutoLiveStage";
import type { SpeakerDeps } from "./speaker";
import { useAutoLiveVoice } from "./useAutoLiveVoice";
import { type StayAwakeOptions, useStayAwake } from "./useStayAwake";

/** Auto live speaks English: its commentary, its voices and its screens' labels. */
const PROFILE: ViewerProfile = { mode: "fan", language: "en", club: null, player: null };
/** In silence, a commentary line stays on screen this long. */
const CAPTION_S = 30;

export const VOICES: { id: string; label: string }[] = [
  { id: "en-GB-RyanNeural", label: "Ryan (UK)" },
  { id: "en-GB-SoniaNeural", label: "Sonia (UK)" },
  { id: "en-GB-ThomasNeural", label: "Thomas (UK)" },
  { id: "en-US-AndrewNeural", label: "Andrew (US)" },
  { id: "en-US-AvaNeural", label: "Ava (US)" },
  { id: "en-US-GuyNeural", label: "Guy (US)" },
  { id: "en-US-JennyNeural", label: "Jenny (US)" },
  { id: "en-AU-WilliamNeural", label: "William (Australia)" },
  { id: "en-IE-ConnorNeural", label: "Connor (Ireland)" },
  { id: "en-IN-PrabhatNeural", label: "Prabhat (India)" },
  { id: "en-IN-NeerjaNeural", label: "Neerja (India)" },
];
const SPEEDS = [1, 2, 5, 10, 30];

type Options = CurrentMatchOptions & {
  capture?: typeof startCapture;
  speech?: Partial<SpeakerDeps>;
  awake?: Pick<StayAwakeOptions, "wakeLock" | "reload">;
};

/** What both pages draw from: auto live's document, the studio's, the match and the fans. */
function useProgram({ eventSource, retryMs, pollMs }: CurrentMatchOptions) {
  const { doc, offset, accept, connected } = useLiveDocument<AutoLive>(AUTOLIVE_STREAM, eventSource, retryMs);
  const { studio } = useStudio(eventSource, retryMs);
  const { doc: fans } = useLiveDocument<FanZone>(FANS_STREAM, eventSource, retryMs);
  useCurrentMatch(PROFILE, { eventSource, retryMs, pollMs });
  const match = useMatch((state) => state.data);
  // Once a second is enough for the clock and the bar; the screens animate by themselves.
  const now = useNow(1000) + offset;
  const data: ProgramData | null = studio ? { match, studio, now, language: "en", fans } : null;
  const latest = match.narratives[0];
  const narrative = useMemo(() => (latest ? { id: latest.id, text: latest.text } : null), [latest]);
  return { doc, accept, data, now, narrative, connected };
}

function captionOf(doc: AutoLive | null, now: number, spoken: string | null, silent: boolean): string | null {
  if (spoken) return spoken;
  const commentary = doc?.commentary;
  if (!silent || !commentary || commentary.scene_id !== doc.scene_id || now - commentary.at > CAPTION_S) return null;
  return commentary.text;
}

/** `/live?output`: the clean picture the pipeline's hidden browser records and streams, voice included. */
export function AutoLiveOutput({ capture = startCapture, speech, awake, ...options }: Options) {
  const { doc, data, now, narrative, connected } = useProgram(options);
  const size = useWindowSize();
  useCaptureOffer(Boolean(doc && data), capture);
  useStayAwake({ connected, reloadWhenCutOff: false, ...awake });
  const { spoken } = useAutoLiveVoice(doc, narrative, { on: true, stream: true, monitor: false, deps: speech });
  return (
    <div data-testid="autolive-output"
      style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", overflow: "hidden", backgroundColor: "#000000", cursor: "none" }}>
      {doc && data && (
        <AutoLiveStage doc={doc} data={data} now={now} scale={fitScale(size.width, size.height)}
          caption={captionOf(doc, now, spoken.text, false)} speaking={spoken.text !== null} />
      )}
    </div>
  );
}

const useStyles = makeStyles({
  page: { minHeight: "100vh", backgroundColor: tokens.colorNeutralBackground2 },
  main: {
    display: "grid", gridTemplateColumns: "minmax(0, 1fr) 440px", gap: tokens.spacingHorizontalXL, padding: tokens.spacingHorizontalXL,
    "@media (max-width: 1100px)": { gridTemplateColumns: "minmax(0, 1fr)" },
  },
  column: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL, minWidth: 0 },
  card: {
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM, padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
  },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalS },
  pair: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: tokens.spacingHorizontalM },
  monitor: { borderRadius: tokens.borderRadiusLarge, overflow: "hidden", alignSelf: "flex-start", boxShadow: tokens.shadow16 },
  scenes: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: tokens.spacingHorizontalS },
  scene: {
    display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXS, padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  onAir: { border: `${tokens.strokeWidthThick} solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  muted: { color: tokens.colorNeutralForeground3 },
});

/** A number typed in a box, saved when the box is left or Enter is pressed. */
function MinutesInput({ label, value, min, max, onCommit, disabled }: {
  label: string; value: number; min: number; max: number; onCommit(value: number): void; disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const parsed = Number(draft);
  const valid = draft.trim() !== "" && Number.isFinite(parsed) && parsed >= min && parsed <= max;
  const commit = () => {
    if (valid && parsed !== value) onCommit(parsed);
    else if (!valid) setDraft(String(value));
  };
  return (
    <Field label={label} validationMessage={valid ? undefined : `${min} to ${max}`}>
      <Input type="number" value={draft} min={min} max={max} step={0.5} disabled={disabled}
        onChange={(_, data) => setDraft(data.value)} onBlur={commit} onKeyDown={(event) => event.key === "Enter" && commit()} />
    </Field>
  );
}

/** The speaking rate, saved once the slider is let go rather than at every step of a drag. */
function RateSlider({ value, disabled, onCommit }: { value: number; disabled?: boolean; onCommit(value: number): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  return (
    <Field label={`Speaking rate: ${draft.toFixed(2)}×`}>
      <Slider min={0.5} max={2} step={0.05} value={draft} disabled={disabled} onChange={(_, data) => setDraft(data.value)}
        onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
    </Field>
  );
}

/** `/live`: auto live's controls, beside a preview of exactly what the stream shows. */
export function AutoLivePage(props: Options) {
  const styles = useStyles();
  const { eventSource, retryMs } = props;
  const { doc, accept, data, now, narrative, connected } = useProgram(props);
  // A viewer, not signed in to the studio, watches and listens; only the studio's users change anything.
  const studio = useCanUseStudio();
  const { doc: output } = useLiveDocument<Output>(studio ? OUTPUT_STREAM : null, eventSource, retryMs);
  useStayAwake({ connected, reloadWhenCutOff: true, ...props.awake });
  const [sound, setSound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { spoken, speaker } = useAutoLiveVoice(doc, narrative, { on: sound, stream: false, monitor: true, deps: props.speech });
  const size = useWindowSize();
  // The settings column sits beside the preview only for the studio's users.
  const previewWidth = Math.max(320, Math.min(1280, (studio && size.width > 1100 ? size.width - 440 : size.width) - 96));
  const scale = previewWidth / CANVAS.width;

  const attempt = async (work: () => Promise<AutoLive>) => {
    setBusy(true);
    try {
      accept(await work());
      setProblem(null);
    } catch (error) {
      setProblem((error as Error).message || "The change could not be made.");
    } finally {
      setBusy(false);
    }
  };
  const save = (patch: Partial<AutoLiveSettings>) => doc && void attempt(() => saveAutoLiveSettings({ ...doc.settings, ...patch }));

  const turnSoundOn = async () => {
    try {
      const context = programAudio().context;
      if (context.state === "suspended") await context.resume();
    } catch {
      // No Web Audio: the browser's voice still speaks.
    }
    setSound(true);
  };

  if (!doc || !data) {
    return (
      <div className={styles.page}>
        <AppNav current="live" output={output} now={now} />
        <main className={styles.main}><Text>Loading auto live…</Text></main>
      </div>
    );
  }
  const s = doc.settings;
  const speech = doc.speech;
  const toggleScene = (id: string, kept: boolean) => save({ scenes: kept ? [...s.scenes, id] : s.scenes.filter((scene) => scene !== id) });
  const nextIn = doc.next_at != null && s.enabled ? Math.max(0, Math.round(doc.next_at - now)) : null;

  return (
    <div className={styles.page}>
      <AppNav current="live" output={output} now={now}>
        <Badge appearance="filled" color={s.enabled ? "danger" : "informative"} icon={<BotSparkleRegular />}>
          {s.enabled ? "Auto live on" : "Auto live off"}
        </Badge>
      </AppNav>
      <main className={styles.main}>
        <div className={styles.column}>
          {(problem ?? doc.problem) && (
            <MessageBar intent={problem ? "error" : "warning"}>
              <MessageBarBody>{problem ?? doc.problem}</MessageBarBody>
            </MessageBar>
          )}
          <div className={styles.monitor} aria-label="Auto live preview">
            <AutoLiveStage doc={doc} data={data} now={now} scale={scale}
              caption={captionOf(doc, now, spoken.text, !sound)} speaking={spoken.text !== null} />
          </div>
          <div className={styles.row}>
            {studio && <Button appearance="primary" icon={<NextRegular />} disabled={busy} onClick={() => void attempt(nextScene)}>Next screen</Button>}
            {studio && <Button icon={<ChatSparkleRegular />} disabled={busy || !s.enabled || !s.commentary} onClick={() => void attempt(sayNow)}>Say something now</Button>}
            {sound
              ? <Button icon={<SpeakerMuteRegular />} onClick={() => setSound(false)}>Mute this preview</Button>
              : <Button icon={<Speaker2Regular />} onClick={() => void turnSoundOn()}>Hear the commentary here</Button>}
            <Text className={styles.muted}>
              {nextIn !== null ? `Next screen in ${Math.floor(nextIn / 60)}:${String(nextIn % 60).padStart(2, "0")}` : s.enabled ? "Screens change by hand" : "Auto live is off"}
              {` · ${doc.matches_started} matches started · ${doc.stream_restarts} stream restarts`}
            </Text>
          </div>
          {studio && <section className={styles.card} aria-label="Screens">
            <Text weight="semibold" size={500}>Screens ({s.scenes.length} of {doc.scenes.length} in the rotation)</Text>
            <div className={styles.scenes}>
              {doc.scenes.map((scene) => (
                <div key={scene.id} className={`${styles.scene} ${scene.id === doc.scene_id ? styles.onAir : ""}`}>
                  <Checkbox checked={s.scenes.includes(scene.id)} disabled={busy || (s.scenes.length === 1 && s.scenes.includes(scene.id))}
                    label={scene.name} onChange={(_, value) => toggleScene(scene.id, value.checked === true)} />
                  {scene.kind === "agent" && <Badge size="small" appearance="tint" color="brand">agent</Badge>}
                  <Button size="small" appearance="subtle" icon={<PlayRegular />} aria-label={`Show ${scene.name} now`} style={{ marginLeft: "auto" }}
                    disabled={busy || scene.id === doc.scene_id} onClick={() => void attempt(() => showScene(scene.id))} />
                </div>
              ))}
            </div>
          </section>}
        </div>

        {studio && <div className={styles.column}>
          <section className={styles.card} aria-label="Auto live">
            <Switch label="Auto live" checked={s.enabled} disabled={busy} onChange={(_, value) => save({ enabled: value.checked })} />
            <Text className={styles.muted}>Rotates the screens with live AI commentary, keeps a match playing and, if you want, keeps the stream on air around the clock.</Text>
            <Switch label="Change screens automatically" checked={s.rotate} disabled={busy} onChange={(_, value) => save({ rotate: value.checked })} />
            <div className={styles.pair}>
              <MinutesInput label="Shortest time on a screen (minutes)" value={s.min_minutes} min={0.5} max={Math.min(120, s.max_minutes)}
                disabled={busy || !s.rotate} onCommit={(value) => save({ min_minutes: value })} />
              <MinutesInput label="Longest time on a screen (minutes)" value={s.max_minutes} min={Math.max(0.5, s.min_minutes)} max={120}
                disabled={busy || !s.rotate} onCommit={(value) => save({ max_minutes: value })} />
            </div>
          </section>

          <section className={styles.card} aria-label="Commentary">
            <Text weight="semibold" size={500}>Commentary</Text>
            <Switch label="AI live commentary" checked={s.commentary} disabled={busy} onChange={(_, value) => save({ commentary: value.checked })} />
            <MinutesInput label="Talk again on the same screen every (minutes, 0 = only on a new screen)" value={s.talk_minutes} min={0} max={60}
              disabled={busy || !s.commentary} onCommit={(value) => save({ talk_minutes: value })} />
            <Switch label="Also read the match narration" checked={s.narration} disabled={busy} onChange={(_, value) => save({ narration: value.checked })} />
            <Field label="Voice">
              <Select value={s.voice} disabled={busy} onChange={(_, value) => save({ voice: value.value })}>
                {(VOICES.some((voice) => voice.id === s.voice) ? VOICES : [{ id: s.voice, label: s.voice }, ...VOICES]).map((voice) => (
                  <option key={voice.id} value={voice.id}>{voice.label}</option>
                ))}
              </Select>
            </Field>
            <RateSlider value={s.rate} disabled={busy} onCommit={(rate) => save({ rate })} />
            <div className={styles.row}>
              <Button icon={<Speaker2Regular />} onClick={() => {
                void turnSoundOn().then(() => speaker?.say("This is Kickstream Live, football around the clock, with seven AI agents and live commentary."));
              }}>Test the voice</Button>
              <Badge appearance="tint" color={speech.azure && !speech.problem ? "success" : "warning"}>
                {speech.azure ? `Azure Speech${speech.region ? ` · ${speech.region}` : ""}` : "Browser voice"}
              </Badge>
            </div>
            <Text size={200} className={styles.muted}>
              {speech.azure
                ? `${speech.chars_today.toLocaleString()} of ${speech.chars_limit.toLocaleString()} Azure Speech characters used today.`
                : "Azure Speech is not set up: this page speaks with the browser's voice (Edge's natural voices sound best), which the stream cannot carry."}
              {spoken.engine === "browser" && speech.azure ? " Azure did not answer; the browser's voice is standing in." : ""}
            </Text>
            {(speech.problem ?? spoken.problem) && (
              <MessageBar intent="warning"><MessageBarBody>{speech.problem ?? spoken.problem}</MessageBarBody></MessageBar>
            )}
          </section>

          <section className={styles.card} aria-label="Around the clock">
            <Text weight="semibold" size={500}>Around the clock</Text>
            <Switch label="Keep a match playing" checked={s.keep_match} disabled={busy} onChange={(_, value) => save({ keep_match: value.checked })} />
            <Field label="Match speed">
              <Select value={String(s.match_speed)} disabled={busy || !s.keep_match} onChange={(_, value) => save({ match_speed: Number(value.value) })}>
                {(SPEEDS.includes(s.match_speed) ? SPEEDS : [s.match_speed, ...SPEEDS]).map((speed) => (
                  <option key={speed} value={speed}>{speed === 1 ? "Real time" : `${speed}× faster`}</option>
                ))}
              </Select>
            </Field>
            <Switch label="Stream 24/7" checked={s.stream} disabled={busy} onChange={(_, value) => save({ stream: value.checked })} />
            <Text size={200} className={styles.muted}>
              Sends this page to the destinations set up in the studio and starts it again whenever it stops. A stream the studio
              started is left alone. Turn this off to end the 24/7 stream.
            </Text>
            <div className={styles.row}>
              <LiveRegular />
              <Text>{output ? `Output: ${output.state}` : "Output: unknown"}</Text>
            </div>
          </section>
        </div>}
      </main>
    </div>
  );
}
