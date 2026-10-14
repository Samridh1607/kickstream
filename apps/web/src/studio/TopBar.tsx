import { Badge, Button, makeStyles, mergeClasses, MessageBar, MessageBarBody, Text, ToggleButton, tokens } from "@fluentui/react-components";
import { KeyboardRegular, LiveFilled, RecordRegular, RecordStopRegular, SlideLayoutRegular } from "@fluentui/react-icons";
import type { ReactNode } from "react";
import { broadcastPath, studioPath } from "../broadcasts/api";
import { STATE } from "../broadcasts/format";
import type { StudioBroadcast } from "../broadcasts/StudioBroadcast";
import type { Broadcast, Destination, Output } from "../contracts";
import { PlatformMark } from "../shell/PlatformMark";
import { Trail } from "../shell/Trail";

const STATUS: Record<Destination["status"], { label: string; color: "subtle" | "warning" | "success" | "danger" }> = {
  idle: { label: "Off", color: "subtle" },
  connecting: { label: "Connecting", color: "warning" },
  live: { label: "Live", color: "success" },
  retrying: { label: "Retrying", color: "warning" },
  failed: { label: "Failed", color: "danger" },
};
/** A status this page does not know (an older page after a server upgrade) is shown as it came. */
const statusOf = (value: string) => (Object.hasOwn(STATUS, value) ? STATUS[value as Destination["status"]] : { label: value, color: "subtle" as const });

const useStyles = makeStyles({
  bar: {
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
    color: "#FFFFFF", boxShadow: tokens.shadow8, backgroundImage: "linear-gradient(135deg, #1C0F33 0%, #3A1A78 60%, #6528CF 100%)",
  },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalM, minWidth: 0 },
  broadcast: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalM, minWidth: 0 },
  trail: { fontSize: tokens.fontSizeBase300 },
  onAir: { maxWidth: "240px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "inherit" },
  lights: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalXS },
  light: {
    display: "inline-flex", alignItems: "center", gap: tokens.spacingHorizontalXS, padding: `2px ${tokens.spacingHorizontalS} 2px 2px`,
    borderRadius: tokens.borderRadiusCircular, backgroundColor: "rgba(255, 255, 255, 0.12)",
  },
  live: {
    display: "inline-flex", alignItems: "center", gap: tokens.spacingHorizontalXS, padding: `2px ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusCircular, color: "#FFFFFF", backgroundColor: "#D92D20", fontWeight: tokens.fontWeightSemibold,
  },
  pulse: {
    width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#FFFFFF",
    animationName: { "0%": { opacity: 1 }, "50%": { opacity: 0.25 }, "100%": { opacity: 1 } },
    animationDuration: "1.4s", animationIterationCount: "infinite",
  },
  timer: { color: "inherit", fontVariantNumeric: "tabular-nums" },
  grow: { flexGrow: 1 },
  ghost: {
    color: "#FFFFFF", backgroundColor: "rgba(255, 255, 255, 0.12)", border: "1px solid rgba(255, 255, 255, 0.3)",
    ":hover": { color: "#FFFFFF", backgroundColor: "rgba(255, 255, 255, 0.22)" },
    ":hover:active": { color: "#FFFFFF", backgroundColor: "rgba(255, 255, 255, 0.3)" },
  },
  pressed: { color: "#1C0F33", backgroundColor: "#FFFFFF", ":hover": { color: "#1C0F33", backgroundColor: "#F0EBFA" } },
  red: { color: "#FFFFFF", backgroundColor: "#D92D20", border: "none", ":hover": { color: "#FFFFFF", backgroundColor: "#B42318" } },
  unavailable: { opacity: 0.55, cursor: "not-allowed" },
});

/** Always with hours: `0:05:12`, `1:01:01`. */
export function elapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${Math.floor(whole / 3600)}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}`;
}

/** When the broadcast's open session began, or else when the output went live. */
function liveSince(broadcast: Broadcast | null, output: Output | null): number | null {
  const open = broadcast?.sessions.find((session) => session.ended_at === null || session.ended_at === undefined);
  return open?.started_at ?? output?.started_at ?? null;
}

export interface TopBarProps {
  /** The studio's broadcast, from `useStudioBroadcast`; null in the plain studio, which has none. */
  link: StudioBroadcast | null;
  output: Output | null;
  /** Whether the studio document is streaming. */
  connected: boolean;
  onAirName: string;
  /** Whether Edit layout is open. */
  editing: boolean;
  onToggleEdit(): void;
  /** Absent where going live is not offered from the bar. */
  onGoLive?(): void;
  /** Why going live is not possible yet; Go live is offered but disabled, with this as its tooltip. */
  goLiveBlocked?: string;
  onEnd?(broadcast: Broadcast): void;
  /** A go live or end is in flight. */
  busy?: boolean;
  /** Server time, in seconds. */
  now: number;
  /** What the page adds beside the bar's own buttons. */
  extras?: ReactNode;
}

/** Across the top of the studio: the broadcast, whether it is live and for how long, and the one main action. */
export function TopBar({
  link, output, connected, onAirName, editing, onToggleEdit, onGoLive, goLiveBlocked, onEnd, busy = false, now, extras,
}: TopBarProps) {
  const styles = useStyles();
  const broadcast = link?.broadcast ?? null;
  const broadcastLive = broadcast?.state === "live";
  const onAir = broadcastLive || (link === null && output?.state === "live");
  const since = onAir ? liveSince(broadcast, output) : null;
  const canGoLive = onGoLive !== undefined && !onAir && (link === null || broadcast?.state === "ready");
  const lights = output && output.state !== "idle" ? output.destinations.filter((item) => item.enabled) : [];

  return (
    <section className={styles.bar} aria-label="Studio top bar">
      <div className={styles.row}>
        {broadcast && (
          <section className={styles.broadcast} aria-label="Studio broadcast">
            <Trail className={styles.trail}
              steps={[{ label: "Home", href: "/" }, { label: broadcast.title, href: broadcastPath(broadcast.id) }, { label: "Studio" }]} />
            {!broadcastLive && <Badge appearance="filled" color={STATE[broadcast.state].color}>{STATE[broadcast.state].label}</Badge>}
            {broadcast.record && <Badge appearance="tint" color="success" icon={<RecordRegular />}>Recording on</Badge>}
          </section>
        )}
        {onAir && (
          <span className={styles.live}>
            <span className={styles.pulse} />
            <Text weight="semibold" className={styles.timer}>LIVE</Text>
            {since !== null && <Text className={styles.timer}>{elapsed(now - since)}</Text>}
          </span>
        )}
        <Badge appearance="tint" color={connected ? "success" : "warning"}>{connected ? "Connected" : "Reconnecting"}</Badge>
        <Text className={styles.onAir} title={onAirName}>On air: {onAirName}</Text>
        {lights.length > 0 && (
          <div role="group" aria-label="Destinations" className={styles.lights}>
            {lights.map((item) => (
              <span key={item.id} className={styles.light} title={item.reason ?? undefined}>
                <PlatformMark platform={item.platform} size={20} />
                <Text size={200} style={{ color: "inherit" }}>{item.name}</Text>
                <Badge appearance="tint" color={statusOf(item.status).color}>{statusOf(item.status).label}</Badge>
              </span>
            ))}
          </div>
        )}
        <span className={styles.grow} />
        {extras}
        <Button icon={<KeyboardRegular />} className={styles.ghost} disabledFocusable title="Coming in a later phase">Shortcuts</Button>
        <ToggleButton icon={<SlideLayoutRegular />} className={editing ? styles.pressed : styles.ghost} checked={editing} onClick={onToggleEdit}>
          Edit layout
        </ToggleButton>
        {broadcastLive && onEnd && (
          <Button icon={<RecordStopRegular />} className={styles.red} disabled={busy} onClick={() => onEnd(broadcast)}>End broadcast</Button>
        )}
        {canGoLive && (
          <Button icon={<LiveFilled />} className={mergeClasses(styles.red, (busy || goLiveBlocked !== undefined) && styles.unavailable)} disabled={busy} disabledFocusable={goLiveBlocked !== undefined}
            title={goLiveBlocked} onClick={onGoLive}>
            Go live
          </Button>
        )}
      </div>
      {link?.doc && broadcast === null && (
        <MessageBar intent="warning">
          <MessageBarBody>
            This broadcast no longer exists. <a href="/">Choose or create one on Home</a> to use the studio.
          </MessageBarBody>
        </MessageBar>
      )}
      {broadcast?.state === "ended" && (
        <MessageBar intent="warning">
          <MessageBarBody>
            This broadcast has ended, so it cannot go live again. <a href="/">Create a new broadcast</a> to go live; it uses these scenes too.
          </MessageBarBody>
        </MessageBar>
      )}
      {broadcast && link?.liveElsewhere && (
        <MessageBar intent="warning">
          <MessageBarBody>
            {`“${link.liveElsewhere.title}” is live, and the program you change here is what it is sending. `}
            <a href={studioPath(link.liveElsewhere.id)}>Open its studio</a>
          </MessageBarBody>
        </MessageBar>
      )}
      {broadcast?.state === "ready" && link?.refusal && !link.liveElsewhere && (
        <MessageBar intent="error"><MessageBarBody>{link.refusal}</MessageBarBody></MessageBar>
      )}
    </section>
  );
}
