import { Badge, Button, Field, Input, makeStyles, MessageBar, MessageBarBody, Select, Switch, Text, tokens, Tooltip } from "@fluentui/react-components";
import { AddRegular, DeleteRegular, LiveFilled, RecordRegular, StopFilled } from "@fluentui/react-icons";
import { useRef, useState } from "react";
import type { Destination, Output } from "../contracts";
import { PlatformMark } from "../shell/PlatformMark";
import { addDestination, goLive, removeDestination, setDestinationEnabled, setQuality, stopOutput } from "./api";

type Platform = Destination["platform"];

const PLATFORMS: Record<Platform, { label: string; address: string }> = {
  youtube: { label: "YouTube", address: "rtmp://a.rtmp.youtube.com/live2" },
  x: { label: "X", address: "" },
  facebook: { label: "Facebook", address: "rtmps://live-api-s.facebook.com:443/rtmp/" },
  twitch: { label: "Twitch", address: "rtmp://live.twitch.tv/app" },
  custom: { label: "Custom RTMP", address: "" },
  file: { label: "Record to file", address: "" },
};
const STATE = {
  idle: { label: "Off air", color: "subtle" },
  starting: { label: "Starting", color: "warning" },
  live: { label: "Live", color: "danger" },
  stopping: { label: "Stopping", color: "warning" },
} as const;
const STATUS = {
  idle: { label: "Off", color: "subtle" },
  connecting: { label: "Connecting", color: "warning" },
  live: { label: "Live", color: "success" },
  retrying: { label: "Retrying", color: "warning" },
  failed: { label: "Failed", color: "danger" },
} as const;

const NEUTRAL = "subtle" as const;
/** A value this page does not know (an older page after a server upgrade) is shown as it came. */
function look<T extends { label: string }>(table: Record<string, T>, value: string): Omit<T, "label"> & { label: string; color: string } {
  return (Object.hasOwn(table, value) ? table[value] : { label: value, color: NEUTRAL }) as never;
}

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
  section: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalS },
  grow: { flexGrow: 1, minWidth: 0, overflowWrap: "anywhere" },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  pair: {
    display: "inline-flex", alignItems: "center", gap: tokens.spacingHorizontalXS, padding: `2px ${tokens.spacingHorizontalS} 2px 2px`,
    borderRadius: tokens.borderRadiusCircular, backgroundColor: tokens.colorNeutralBackground3,
  },
  onAir: {
    display: "inline-flex", alignItems: "center", gap: tokens.spacingHorizontalXS, padding: `2px ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusCircular, color: "#FFFFFF", backgroundColor: "#D92D20", fontWeight: tokens.fontWeightSemibold,
  },
  pulse: {
    width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#FFFFFF",
    animationName: { "0%": { opacity: 1 }, "50%": { opacity: 0.25 }, "100%": { opacity: 1 } },
    animationDuration: "1.4s", animationIterationCount: "infinite",
  },
  destination: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
});

/** Minutes and seconds, or hours too once there are any. */
function elapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(whole % 60)}` : `${minutes}:${pad(whole % 60)}`;
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

interface OutputTabProps {
  output: Output | null;
  /** Server time, in seconds. */
  now: number;
  /** Sends one change and applies the answer. Resolves to true when it was accepted. */
  onRun(request: () => Promise<Output>): Promise<boolean>;
  /** Goes live some other way, such as with the studio's broadcast. Resolves to true when it started. */
  onGoLive?(): Promise<boolean>;
  /** Going live turns recording on by itself, so no destination needs to be switched on first. */
  recordsItself?: boolean;
  /** Whether this tab offers Go live and Stop; false where the page has its own. */
  liveControls?: boolean;
}

/** While the output is on: how long it has been live, and how each stream it sends to is doing. */
export function LiveStatus({ output, now }: { output: Output | null; now: number }) {
  const styles = useStyles();
  if (!output || output.state === "idle") return null;
  return (
    <section className={styles.row} aria-label="Stream status">
      {output.state === "live" ? (
        <span className={styles.onAir}>
          <span className={styles.pulse} />
          <Text weight="semibold" style={{ color: "inherit" }}>Live</Text>
          {typeof output.started_at === "number" && <Text style={{ color: "inherit", fontVariantNumeric: "tabular-nums" }}>{elapsed(now - output.started_at)}</Text>}
        </span>
      ) : (
        <Badge color={look(STATE, output.state).color}>{look(STATE, output.state).label}</Badge>
      )}
      {output.destinations.filter((item) => item.enabled).map((item) => (
        <span key={item.id} className={styles.pair} title={item.reason ?? undefined}>
          <PlatformMark platform={item.platform} size={20} />
          <Text size={200}>{item.name}</Text>
          <Badge appearance="tint" color={look(STATUS, item.status).color}>{look(STATUS, item.status).label}</Badge>
        </span>
      ))}
    </section>
  );
}

/** Where the program is sent, and the button that sends it. */
export function OutputTab({ output, now, onRun, onGoLive, recordsItself = false, liveControls = true }: OutputTabProps) {
  const styles = useStyles();
  const [platform, setPlatform] = useState<Platform>("youtube");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  /** One request at a time: while it is in flight nothing else from this tab can start. */
  const guard = async (work: () => Promise<boolean>): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    try {
      return await work();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const run = (request: () => Promise<Output>) => guard(() => onRun(request));

  if (!output) return <Text>Connecting to the output…</Text>;

  const idle = output.state === "idle";
  const toFile = platform === "file";
  const add = async () => {
    const added = { name: name.trim() || PLATFORMS[platform].label, platform, url: toFile ? "" : address.trim(), key: toFile ? "" : key };
    if (await run(() => addDestination(added))) {
      setName("");
      setAddress("");
      setKey("");
    }
  };

  return (
    <div className={styles.root}>
      <section className={styles.section} aria-label="Stream">
        <div className={styles.row}>
          <Badge color={look(STATE, output.state).color}>{look(STATE, output.state).label}</Badge>
          {output.state === "live" && typeof output.started_at === "number" && <Text>{elapsed(now - output.started_at)}</Text>}
          <span className={styles.grow} />
          {liveControls && (idle ? (
            <Button appearance="primary" icon={<LiveFilled />} disabled={busy || (!recordsItself && !output.destinations.some((item) => item.enabled))}
              onClick={() => void (onGoLive ? guard(onGoLive) : run(goLive))}>Go live</Button>
          ) : (
            <Button icon={<StopFilled />} disabled={busy || output.state === "stopping"} onClick={() => void run(stopOutput)}>Stop</Button>
          ))}
        </div>
        {output.problem && (
          <MessageBar intent="error">
            <MessageBarBody>{output.problem}</MessageBarBody>
          </MessageBar>
        )}
        <Field label="Quality">
          <Select value={output.quality} disabled={!idle || busy} onChange={(_, data) => void run(() => setQuality(data.value as Output["quality"]))}>
            <option value="720p30">720p, 30 frames per second</option>
            <option value="1080p30">1080p, 30 frames per second</option>
          </Select>
        </Field>
      </section>

      <section className={styles.section} aria-label="Destinations">
        <Text weight="semibold">Destinations</Text>
        {output.destinations.length === 0 && <Text size={200}>Add a destination to go live.</Text>}
        <ul className={styles.list}>
          {output.destinations.map((item) => (
            <li key={item.id} data-testid={`destination-${item.id}`}>
              <div className={styles.destination}>
                <PlatformMark platform={item.platform} size={32} />
                <div className={styles.grow}>
                  <Text weight="semibold" block>{item.name}</Text>
                  <Text size={200} block>
                    {look(PLATFORMS, item.platform).label}
                    {item.platform !== "file" && (
                      <>
                        {" · "}
                        <span>{item.key_hint ? `Key ending ${item.key_hint}` : "Key saved"}</span>
                      </>
                    )}
                  </Text>
                </div>
                <Badge color={look(STATUS, item.status).color}>{look(STATUS, item.status).label}</Badge>
              </div>
              {item.reason && <Text size={200} block className={styles.grow}>{item.reason}</Text>}
              <div className={styles.row}>
                <Switch label={`Send to ${item.name}`} checked={item.enabled} disabled={!idle || busy}
                  onChange={(_, data) => void run(() => setDestinationEnabled(item, data.checked))} />
                <span className={styles.grow} />
                <Tooltip content="Remove" relationship="description">
                  <Button size="small" appearance="subtle" icon={<DeleteRegular />} disabled={!idle || busy} aria-label={`Remove ${item.name}`}
                    onClick={() => void run(() => removeDestination(item.id))} />
                </Tooltip>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.section} aria-label="Add a destination">
        <div className={styles.destination}>
          <PlatformMark platform={platform} size={24} />
          <Text weight="semibold">Add a destination</Text>
        </div>
        <Field label="Platform">
          <Select value={platform} onChange={(_, data) => {
            setPlatform(data.value as Platform);
            // An address or key typed for one platform must never be sent to another.
            setAddress("");
            setKey("");
          }}>
            {(Object.keys(PLATFORMS) as Platform[]).map((option) => (
              <option key={option} value={option}>{PLATFORMS[option].label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Name">
          <Input value={name} maxLength={40} placeholder={PLATFORMS[platform].label} onChange={(_, data) => setName(data.value)} />
        </Field>
        {!toFile && (
          <>
            <Field label="Server address" hint={platform === "x" ? "X shows your address in Media Studio." : undefined}>
              <Input value={address} maxLength={300} placeholder={PLATFORMS[platform].address} onChange={(_, data) => setAddress(data.value)} />
            </Field>
            <Field label="Stream key" hint="Kept on this machine and never shown again.">
              <Input type="password" autoComplete="off" value={key} maxLength={300} onChange={(_, data) => setKey(data.value)} />
            </Field>
          </>
        )}
        <Button icon={<AddRegular />} disabled={!idle || busy} onClick={() => void add()}>Add destination</Button>
      </section>

      {output.recordings.length > 0 && (
        <section className={styles.section} aria-label="Recordings">
          <Text weight="semibold">Recordings</Text>
          <ul className={styles.list}>
            {output.recordings.map((item) => (
              <li key={item.file} className={styles.row}>
                <RecordRegular />
                <Text className={styles.grow}>{item.file}</Text>
                <Text size={200}>{megabytes(item.size_bytes)}</Text>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
