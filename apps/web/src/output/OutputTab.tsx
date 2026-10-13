import { Badge, Button, Field, Input, makeStyles, MessageBar, MessageBarBody, Select, Switch, Text, tokens } from "@fluentui/react-components";
import { useState } from "react";
import type { Destination, Output } from "../contracts";
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

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
  section: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalS },
  grow: { flexGrow: 1, minWidth: 0, overflowWrap: "anywhere" },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
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
}

/** Where the program is sent, and the button that sends it. */
export function OutputTab({ output, now, onRun }: OutputTabProps) {
  const styles = useStyles();
  const [platform, setPlatform] = useState<Platform>("youtube");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [key, setKey] = useState("");

  if (!output) return <Text>Connecting to the output…</Text>;

  const idle = output.state === "idle";
  const toFile = platform === "file";
  const add = async () => {
    const added = { name: name.trim() || PLATFORMS[platform].label, platform, url: toFile ? "" : address.trim(), key: toFile ? "" : key };
    if (await onRun(() => addDestination(added))) {
      setName("");
      setAddress("");
      setKey("");
    }
  };

  return (
    <div className={styles.root}>
      <section className={styles.section} aria-label="Stream">
        <div className={styles.row}>
          <Badge color={STATE[output.state].color}>{STATE[output.state].label}</Badge>
          {output.state === "live" && typeof output.started_at === "number" && <Text>{elapsed(now - output.started_at)}</Text>}
          <span className={styles.grow} />
          {idle ? (
            <Button appearance="primary" disabled={!output.destinations.some((item) => item.enabled)} onClick={() => void onRun(goLive)}>Go live</Button>
          ) : (
            <Button disabled={output.state === "stopping"} onClick={() => void onRun(stopOutput)}>Stop</Button>
          )}
        </div>
        {output.problem && (
          <MessageBar intent="error">
            <MessageBarBody>{output.problem}</MessageBarBody>
          </MessageBar>
        )}
        <Field label="Quality">
          <Select value={output.quality} disabled={!idle} onChange={(_, data) => void onRun(() => setQuality(data.value as Output["quality"]))}>
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
              <div className={styles.row}>
                <Text weight="semibold" className={styles.grow}>{item.name}</Text>
                <Badge color={STATUS[item.status].color}>{STATUS[item.status].label}</Badge>
              </div>
              <Text size={200} block>
                {PLATFORMS[item.platform].label}
                {item.platform !== "file" && (
                  <>
                    {" · "}
                    <span>{item.key_hint ? `Key ending ${item.key_hint}` : "Key saved"}</span>
                  </>
                )}
              </Text>
              {item.reason && <Text size={200} block className={styles.grow}>{item.reason}</Text>}
              <div className={styles.row}>
                <Switch label={`Send to ${item.name}`} checked={item.enabled} disabled={!idle}
                  onChange={(_, data) => void onRun(() => setDestinationEnabled(item, data.checked))} />
                <Button size="small" disabled={!idle} aria-label={`Remove ${item.name}`} onClick={() => void onRun(() => removeDestination(item.id))}>Remove</Button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.section} aria-label="Add a destination">
        <Text weight="semibold">Add a destination</Text>
        <Field label="Platform">
          <Select value={platform} onChange={(_, data) => setPlatform(data.value as Platform)}>
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
        <Button disabled={!idle} onClick={() => void add()}>Add destination</Button>
      </section>

      {output.recordings.length > 0 && (
        <section className={styles.section} aria-label="Recordings">
          <Text weight="semibold">Recordings</Text>
          <ul className={styles.list}>
            {output.recordings.map((item) => (
              <li key={item.file} className={styles.row}>
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
