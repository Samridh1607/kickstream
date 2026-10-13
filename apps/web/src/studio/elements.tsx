import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { Pitch } from "../components/Pitch";
import { StatsPanel } from "../components/StatsPanel";
import { Timeline } from "../components/Timeline";
import type { Banner, MatchEvent, Replay, SceneElement, Studio } from "../contracts";
import { type Language, t } from "../i18n";
import type { MatchData } from "../stream/store";
import { fetchReplay, imageUrl } from "./api";
import { countdownLabel, formatRemaining, tickerItems } from "./format";

/** Someone on stage, as the cameras element draws them. */
export interface CameraTile {
  id: string;
  name: string;
  acsId: string | null;
  present: boolean;
}

/** Everything an element can draw from. `now` is the server's clock in Unix seconds. */
export interface ProgramData {
  match: MatchData;
  studio: Studio;
  now: number;
  language: Language;
  /** The people on stage, in order. */
  cameras?: readonly CameraTile[];
  /** Puts a person's video into the element; returns what takes it out. Absent where there is no call. */
  renderVideo?: (acsId: string, element: HTMLElement) => () => void;
}

// The program is a broadcast picture, not themed interface: one fixed look, sized for 1080p.
const PANEL: CSSProperties = {
  boxSizing: "border-box", width: "100%", height: "100%", overflow: "hidden", padding: 24, borderRadius: 16,
  color: "#FFFFFF", backgroundColor: "rgba(16, 24, 40, 0.88)", fontSize: 32, lineHeight: 1.3,
};
const CENTERED: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", gap: 32 };
const BANNER_COLOR: Record<Banner["kind"], string> = {
  goal: "#107C10", card: "#C50F1F", info: "#0F6CBD", custom: "#5C2E91",
};
const noop = () => {};

function Panel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ ...PANEL, ...style }}>{children}</div>;
}

/** Cycle 1 components are sized for a dashboard; enlarge them for the 1080p canvas. */
function Enlarged({ children }: { children: ReactNode }) {
  return (
    <Panel>
      <div style={{ zoom: 1.8 }}>{children}</div>
    </Panel>
  );
}

function Scoreboard({ match }: { match: MatchData }) {
  const status = match.status;
  if (!status) {
    return (
      <Panel style={CENTERED}>
        <span data-testid="program-score" style={{ fontSize: 64, opacity: 0.6 }}>–</span>
      </Panel>
    );
  }
  return (
    <Panel style={CENTERED}>
      <span style={{ fontWeight: 600 }}>{status.home.name}</span>
      <span data-testid="program-score" style={{ fontSize: 64, fontWeight: 700 }}>
        {status.score_home} - {status.score_away}
      </span>
      <span style={{ fontWeight: 600 }}>{status.away.name}</span>
      <span style={{ opacity: 0.8 }}>{Math.max(status.minute, match.minute)}'</span>
    </Panel>
  );
}

function Narration({ match, lines, language }: { match: MatchData; lines: number; language: Language }) {
  const shown = match.narratives.slice(0, lines);
  if (shown.length === 0) return <Panel style={{ opacity: 0.7 }}>{t(language, "feedEmpty")}</Panel>;
  return (
    <Panel style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {shown.map((line) => (
        <p key={line.id} style={{ margin: 0 }}>
          <span style={{ opacity: 0.7, marginRight: 12 }}>{line.minute}'</span>
          <span>{line.text}</span>
        </p>
      ))}
    </Panel>
  );
}

function BannerView({ banner }: { banner: Banner | null | undefined }) {
  if (!banner) return null;
  return (
    <div data-testid="program-banner" data-kind={banner.kind}
      style={{ ...PANEL, ...CENTERED, backgroundColor: BANNER_COLOR[banner.kind], fontSize: 40, fontWeight: 600, textAlign: "center" }}>
      {banner.text}
    </div>
  );
}

function TickerView({ data }: { data: ProgramData }) {
  const items = tickerItems(data.studio.ticker, data.match.status, data.match.stats, data.language);
  if (items.length === 0) return null;
  const text = items.join("   •   ");
  const seconds = Math.max(6, (1920 + text.length * 22) / data.studio.ticker.speed);
  return (
    <div data-testid="program-ticker" style={{ ...PANEL, padding: 0, borderRadius: 0, display: "flex", alignItems: "center", whiteSpace: "nowrap" }}>
      <div style={{ display: "inline-block", paddingLeft: "100%", animation: `kickstream-ticker ${seconds}s linear infinite` }}>
        {text}
      </div>
    </div>
  );
}

function CountdownView({ data }: { data: ProgramData }) {
  const countdown = data.studio.countdown;
  if (!countdown) return null;
  return (
    <div data-testid="program-countdown" style={{ ...PANEL, ...CENTERED, flexDirection: "column", gap: 8 }}>
      <span style={{ fontSize: 40, opacity: 0.85 }}>{countdownLabel(countdown, data.language)}</span>
      <span style={{ fontSize: 112, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
        {formatRemaining(countdown.ends_at - data.now)}
      </span>
    </div>
  );
}

function RecapView({ match }: { match: MatchData }) {
  const recap = match.recaps[match.recaps.length - 1];
  if (!recap) return null;
  return (
    <div data-testid="program-recap" style={PANEL}>
      <div style={{ fontSize: 40, fontWeight: 700, marginBottom: 16 }}>{recap.title}</div>
      <ul style={{ margin: 0, paddingLeft: 40 }}>
        {recap.bullets.map((bullet) => (
          <li key={bullet}>{bullet}</li>
        ))}
      </ul>
    </div>
  );
}

function ReplayView({ replay, data }: { replay: Replay; data: ProgramData }) {
  const [events, setEvents] = useState<MatchEvent[]>([]);

  useEffect(() => {
    let current = true;
    setEvents([]);
    fetchReplay(replay.match_id, replay.moment_id)
      .then((body) => current && setEvents(body.events))
      .catch(() => current && setEvents([]));
    return () => {
      current = false;
    };
  }, [replay.match_id, replay.moment_id, replay.started_at]);

  const progress = Math.max(0, Math.min(1, (data.now - replay.started_at) / replay.duration_s));
  const revealed = events.slice(0, Math.max(1, Math.ceil(events.length * progress)));
  // Opaque: a replay often sits on top of other elements, which must not show through it.
  return (
    <div data-testid="program-replay"
      style={{ ...PANEL, display: "flex", flexDirection: "column", gap: 12, border: "6px solid #FFB900", backgroundColor: "#101828" }}>
      <span style={{ alignSelf: "flex-start", padding: "4px 16px", borderRadius: 8, color: "#1B1B1B", backgroundColor: "#FFB900", fontWeight: 700 }}>
        {t(data.language, "replay")} · {replay.minute}'
      </span>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Pitch events={revealed} pressure={null} status={data.match.status} showPressure={false} language={data.language} fill />
      </div>
    </div>
  );
}

function ImageView({ imageId, fit }: { imageId: unknown; fit: unknown }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [imageId]);
  if (typeof imageId !== "string" || broken) {
    return <div style={{ ...PANEL, backgroundColor: "rgba(255, 255, 255, 0.08)", border: "4px dashed rgba(255, 255, 255, 0.4)" }} />;
  }
  return (
    <img data-testid="program-image" src={imageUrl(imageId)} alt="" onError={() => setBroken(true)}
      style={{ width: "100%", height: "100%", objectFit: fit === "cover" ? "cover" : "contain", display: "block" }} />
  );
}

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0].toUpperCase()).join("");

function CameraFeed({ tile, names, renderVideo, language }: { tile: CameraTile; names: boolean; renderVideo?: ProgramData["renderVideo"]; language: Language }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tile.acsId || !renderVideo || !box.current) return;
    return renderVideo(tile.acsId, box.current);
  }, [tile.acsId, renderVideo]);
  return (
    <div data-testid="camera-tile" data-person={tile.id}
      style={{ position: "relative", overflow: "hidden", borderRadius: 16, backgroundColor: "#101828" }}>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 96, fontWeight: 700, color: "rgba(255, 255, 255, 0.45)" }}>
        {initials(tile.name)}
      </div>
      <div ref={box} style={{ position: "absolute", inset: 0 }} />
      {names && (
        <span style={{ position: "absolute", left: 16, bottom: 16, padding: "4px 16px", borderRadius: 8, color: "#FFFFFF", backgroundColor: "rgba(16, 24, 40, 0.8)", fontSize: 28, fontWeight: 600 }}>
          {tile.present ? tile.name : `${tile.name} · ${t(language, "away")}`}
        </span>
      )}
    </div>
  );
}

function CamerasView({ data, names }: { data: ProgramData; names: boolean }) {
  const tiles = data.cameras ?? [];
  if (tiles.length === 0) return null;
  const columns = tiles.length === 1 ? 1 : 2;
  const rows = tiles.length <= 2 ? 1 : 2;
  return (
    <div data-testid="program-cameras"
      style={{ width: "100%", height: "100%", display: "grid", gap: 16, gridTemplateColumns: `repeat(${columns}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}>
      {tiles.map((tile) => (
        <CameraFeed key={tile.id} tile={tile} names={names} renderVideo={data.renderVideo} language={data.language} />
      ))}
    </div>
  );
}

/** Draws one scene element from the match and the studio document. */
export function ElementView({ element, data }: { element: SceneElement; data: ProgramData }) {
  const { match, studio, language } = data;
  const props = element.props as Record<string, unknown>;
  switch (element.type) {
    case "scoreboard":
      return <Scoreboard match={match} />;
    case "pitch":
      return (
        <Panel style={{ padding: 12 }}>
          <Pitch events={match.events} pressure={match.pressure} status={match.status} showPressure={props.pressure !== false} language={language} fill />
        </Panel>
      );
    case "narration":
      return <Narration match={match} lines={typeof props.lines === "number" ? props.lines : 3} language={language} />;
    case "stats":
      return (
        <Enlarged>
          <StatsPanel stats={match.stats} status={match.status} language={language} />
        </Enlarged>
      );
    case "banner":
      return <BannerView banner={studio.banner} />;
    case "ticker":
      return <TickerView data={data} />;
    case "timeline":
      // On the program the timeline is a picture, not a control: its buttons must not take focus or clicks.
      return (
        <Enlarged>
          <div inert>
            <Timeline moments={match.moments} recaps={match.recaps} selectedId={null} language={language} onSelect={noop} onOpenRecap={noop} />
          </div>
        </Enlarged>
      );
    case "recap":
      return <RecapView match={match} />;
    case "replay":
      return studio.replay ? <ReplayView replay={studio.replay} data={data} /> : null;
    case "countdown":
      return <CountdownView data={data} />;
    case "text":
      return (
        <div style={{ ...PANEL, ...CENTERED, backgroundColor: "transparent" }}>
          <span style={{ width: "100%", fontSize: typeof props.size === "number" ? props.size : 48, fontWeight: 700, textAlign: (props.align as CSSProperties["textAlign"]) ?? "center" }}>
            {typeof props.text === "string" ? props.text : ""}
          </span>
        </div>
      );
    case "image":
      return <ImageView imageId={props.image_id} fit={props.fit} />;
    case "cameras":
      return <CamerasView data={data} names={props.names !== false} />;
  }
}
