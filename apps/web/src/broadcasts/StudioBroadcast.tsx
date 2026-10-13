import { Badge, Button, makeStyles, MessageBar, MessageBarBody, Text, tokens } from "@fluentui/react-components";
import { InfoRegular, LiveRegular, RecordRegular, RecordStopRegular } from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import type { Broadcast, Broadcasts } from "../contracts";
import { Trail } from "../shell/Trail";
import { useLiveDocument } from "../stream/useLiveDocument";
import { BROADCASTS_STREAM, broadcastPath, selectBroadcast, studioPath } from "./api";
import { STATE } from "./format";

const useStyles = makeStyles({
  bar: {
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, margin: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXL} 0`,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`, borderRadius: tokens.borderRadiusXLarge, color: "#FFFFFF", boxShadow: tokens.shadow8,
    backgroundImage: "linear-gradient(135deg, #1C0F33 0%, #3A1A78 60%, #6528CF 100%)",
  },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalM },
  title: { fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightBold, overflowWrap: "anywhere" },
  grow: { flexGrow: 1 },
  ghost: {
    color: "#FFFFFF", backgroundColor: "rgba(255, 255, 255, 0.12)", border: "1px solid rgba(255, 255, 255, 0.3)",
    ":hover": { color: "#FFFFFF", backgroundColor: "rgba(255, 255, 255, 0.22)" },
  },
  red: { color: "#FFFFFF", backgroundColor: "#D92D20", border: "none", ":hover": { color: "#FFFFFF", backgroundColor: "#B42318" } },
});

export interface StudioBroadcast {
  /** Null until the broadcasts arrive. */
  doc: Broadcasts | null;
  /** The broadcast this studio works on; null when it does not exist. */
  broadcast: Broadcast | null;
  /** Another broadcast that is on air, which this studio is sending meanwhile. */
  liveElsewhere: Broadcast | null;
  accept(doc: Broadcasts): void;
  /** Why the broadcast could not be made the current one. */
  refusal: string | null;
}

/** The broadcast a studio works on. Opening its studio makes it the one the next stream belongs to. */
export function useStudioBroadcast(
  broadcastId: string | undefined, eventSource?: new (url: string) => EventSource, retryMs?: number,
): StudioBroadcast {
  const { doc, accept } = useLiveDocument<Broadcasts>(BROADCASTS_STREAM, eventSource, retryMs);
  const [refusal, setRefusal] = useState<string | null>(null);
  const broadcast = (broadcastId !== undefined && doc?.broadcasts.find((item) => item.id === broadcastId)) || null;
  const onAir = doc?.broadcasts.find((item) => item.state === "live") ?? null;
  const liveElsewhere = onAir !== null && onAir.id !== broadcastId ? onAir : null;
  const shouldSelect = broadcast !== null && broadcast.state === "ready" && doc?.current_id !== broadcast.id && onAir === null;

  useEffect(() => {
    if (!shouldSelect || broadcastId === undefined) return;
    let current = true;
    selectBroadcast(broadcastId).then(
      (answer) => current && accept(answer),
      (caught: unknown) => current && setRefusal(caught instanceof Error ? caught.message : "This broadcast could not be opened in the studio."),
    );
    return () => {
      current = false;
    };
  }, [shouldSelect, broadcastId, accept]);

  return { doc, broadcast, liveElsewhere, accept, refusal };
}

/** Across the top of the studio: which broadcast it is working on, and the way back to it. */
export function StudioBroadcastBar({ link, busy, onEnd }: { link: StudioBroadcast; busy: boolean; onEnd(broadcast: Broadcast): void }) {
  const styles = useStyles();
  const { doc, broadcast, liveElsewhere, refusal } = link;
  if (doc === null) return null;
  if (broadcast === null) {
    return (
      <MessageBar intent="warning" style={{ margin: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXL} 0` }}>
        <MessageBarBody>
          This broadcast no longer exists. <a href="/">Choose or create one on Home</a> to use the studio.
        </MessageBarBody>
      </MessageBar>
    );
  }
  const state = STATE[broadcast.state];
  return (
    <section className={styles.bar} aria-label="Studio broadcast">
      <Trail steps={[{ label: "Home", href: "/" }, { label: broadcast.title, href: broadcastPath(broadcast.id) }, { label: "Studio" }]} />
      <div className={styles.row}>
        <Badge appearance="filled" color={state.color} icon={broadcast.state === "live" ? <LiveRegular /> : undefined}>{state.label}</Badge>
        <Text className={styles.title}>{broadcast.title}</Text>
        {broadcast.record && <Badge appearance="tint" color="success" icon={<RecordRegular />}>Recording on</Badge>}
        <span className={styles.grow} />
        {broadcast.state === "live" && (
          <Button icon={<RecordStopRegular />} className={styles.red} disabled={busy} onClick={() => onEnd(broadcast)}>End broadcast</Button>
        )}
        <Button as="a" href={broadcastPath(broadcast.id)} icon={<InfoRegular />} className={styles.ghost}>Broadcast details</Button>
      </div>
      {broadcast.state === "ended" && (
        <MessageBar intent="warning">
          <MessageBarBody>
            This broadcast has ended, so it cannot go live again. <a href="/">Create a new broadcast</a> to go live; it uses these scenes too.
          </MessageBarBody>
        </MessageBar>
      )}
      {liveElsewhere && (
        <MessageBar intent="warning">
          <MessageBarBody>
            {`“${liveElsewhere.title}” is live, and the program you change here is what it is sending. `}
            <a href={studioPath(liveElsewhere.id)}>Open its studio</a>
          </MessageBarBody>
        </MessageBar>
      )}
      {refusal && broadcast.state === "ready" && !liveElsewhere && (
        <MessageBar intent="error"><MessageBarBody>{refusal}</MessageBarBody></MessageBar>
      )}
    </section>
  );
}

/** The broadcast the plain studio address opens: the one on air, or else the current one. */
export function studioTarget(doc: Broadcasts): Broadcast | null {
  return doc.broadcasts.find((item) => item.state === "live")
    ?? doc.broadcasts.find((item) => item.id === doc.current_id && item.state === "ready")
    ?? null;
}
