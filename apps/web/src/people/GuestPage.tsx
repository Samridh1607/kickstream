import { Button, Field, Input, Link, makeStyles, MessageBar, MessageBarBody, Spinner, Text, tokens } from "@fluentui/react-components";
import { MicOffRegular, MicRegular, VideoOffRegular, VideoRegular } from "@fluentui/react-icons";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { studioPath } from "../broadcasts/api";
import { DevicePickers } from "../calls/DevicePickers";
import { openRoomCall } from "../calls/open";
import type { RoomCall } from "../calls/RoomCall";
import { useCallUpdates } from "../calls/useCallUpdates";
import { useDevices } from "../calls/useDevices";
import { VideoBox } from "../calls/VideoBox";
import type { CallSeat, Guest } from "../contracts";
import { useLiveDocument } from "../stream/useLiveDocument";
import { StudioRequestError } from "../studio/api";
import { getGuest, guestStream, joinAsGuest, refreshGuestSeat, ROLE_NAMES } from "./api";

const useStyles = makeStyles({
  page: { minHeight: "100vh", boxSizing: "border-box", display: "flex", justifyContent: "center", padding: tokens.spacingHorizontalXL, backgroundColor: tokens.colorNeutralBackground2 },
  card: {
    width: "min(960px, 100%)", alignSelf: "flex-start", display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL,
    padding: tokens.spacingHorizontalXL, borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow8,
  },
  preview: { width: "100%", maxWidth: "560px" },
  tiles: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: tokens.spacingHorizontalM },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalM },
});

/** Where the guest is, in words. */
export function guestBanner(doc: Guest): string {
  if (doc.on_stage) return doc.broadcast_state === "live" ? "You're on stage — you're live" : "You're on stage";
  return doc.muted_live ? "You're backstage and muted while the broadcast is live" : "You're backstage";
}

function Shell({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return (
    <main className={styles.page}>
      <div className={styles.card}>{children}</div>
    </main>
  );
}

interface GuestPageProps {
  secret: string;
  eventSource?: new (url: string) => EventSource;
  retryMs?: number;
  newCall?: (service: CallSeat["service"]) => RoomCall;
}

/** What someone opens from an invite link: check the camera, say who they are, and join the broadcast's room. */
export function GuestPage({ secret, eventSource, retryMs, newCall = openRoomCall }: GuestPageProps) {
  const styles = useStyles();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let current = true;
    getGuest(secret).catch((caught: unknown) => {
      if (current && caught instanceof StudioRequestError && caught.status === 404) setMissing(true);
    });
    return () => {
      current = false;
    };
  }, [secret]);
  const { doc } = useLiveDocument<Guest>(missing ? null : guestStream(secret), eventSource, retryMs);
  const valid = !missing && (doc?.valid ?? true);
  const service = valid ? (doc?.service ?? null) : null;
  const call = useMemo(() => (service ? newCall(service) : null), [service, newCall]);
  useCallUpdates(call);
  const currentCall = useRef(call);
  useEffect(() => {
    currentCall.current = call;
    return () => {
      currentCall.current = null;
      void call?.leave();
    };
  }, [call]);
  const devices = useDevices(call);
  const [name, setName] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const mutedLive = doc?.muted_live ?? false;
  useEffect(() => {
    if (call && mutedLive) void call.setMuted(true);
  }, [call, mutedLive]);

  if (!valid) {
    return (
      <Shell>
        <Text as="h1" size={600} weight="semibold">This invite is no longer valid</Text>
        <Text>Ask the streamer for a new link.</Text>
      </Shell>
    );
  }
  if (!doc) return <Shell><Spinner label="Opening your invite…" /></Shell>;
  if (!call) return <Shell><Text>Guests are not set up on this Kickstream yet.</Text></Shell>;

  const shownName = name ?? doc.joined_name ?? doc.name ?? "";
  const joined = call.state === "joined";
  const join = async () => {
    setJoining(true);
    try {
      const seat = await joinAsGuest(secret, shownName);
      await call.setMuted(doc.muted_live);
      await call.join({ roomId: seat.room_id, token: seat.token, name: shownName.trim(), refresh: async () => (await refreshGuestSeat(secret)).token });
      setProblem(null);
    } catch (caught) {
      // Leaving a call rejects its join that is still starting; that is not the guest's problem.
      if (currentCall.current !== call) return;
      setProblem(caught instanceof Error ? caught.message : "You could not join.");
    } finally {
      setJoining(false);
    }
  };

  return (
    <Shell>
      <Text as="h1" size={600} weight="semibold">
        {joined ? `“${doc.broadcast_title}”` : `Join “${doc.broadcast_title}” as ${ROLE_NAMES[doc.role]}`}
      </Text>
      {problem && <MessageBar intent="error"><MessageBarBody>{problem}</MessageBarBody></MessageBar>}
      {devices.problem && <MessageBar intent="warning"><MessageBarBody>{devices.problem}</MessageBarBody></MessageBar>}
      {joined ? (
        <>
          <MessageBar intent={doc.on_stage ? "success" : "info"}><MessageBarBody>{guestBanner(doc)}</MessageBarBody></MessageBar>
          <div className={styles.row}>
            <Button icon={call.muted ? <MicOffRegular /> : <MicRegular />} disabled={call.muted && doc.muted_live}
              onClick={() => void call.setMuted(!call.muted)}>
              {call.muted ? "Unmute" : "Mute"}
            </Button>
            <Button icon={call.cameraOn ? <VideoRegular /> : <VideoOffRegular />}
              onClick={() => void devices.chooseCamera(call.cameraOn ? null : (devices.cameras[0]?.id ?? null))}>
              {call.cameraOn ? "Turn camera off" : "Turn camera on"}
            </Button>
            {doc.role === "cohost" && doc.broadcast_id && <Link href={studioPath(doc.broadcast_id)}>Open studio</Link>}
          </div>
          <div className={styles.tiles}>
            <VideoBox call={call} acsId={null} label={`${shownName} (you)`} />
            {call.participants.map((participant) => (
              <VideoBox key={participant.acsId} call={call} acsId={participant.acsId} label={participant.name} />
            ))}
          </div>
        </>
      ) : (
        <>
          <div className={styles.preview}><VideoBox call={call} acsId={null} label="Preview" /></div>
          <DevicePickers devices={devices} />
          <Field label="Your name">
            <Input value={shownName} maxLength={40} onChange={(_, data) => setName(data.value)} />
          </Field>
          <Button appearance="primary" disabled={joining || shownName.trim() === ""} onClick={() => void join()}>Join</Button>
        </>
      )}
    </Shell>
  );
}
