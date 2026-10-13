import { Badge, Button, makeStyles, Spinner, Text, tokens, Tooltip } from "@fluentui/react-components";
import { ArrowDownloadRegular, BotSparkleRegular, CopyRegular, DeleteRegular, DocumentTextRegular, ErrorCircleRegular } from "@fluentui/react-icons";
import { useState } from "react";
import type { Reel } from "../contracts";
import { reelUrl } from "./api";
import { clock, post } from "./format";

const useStyles = makeStyles({
  card: {
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground3,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke3}`, minWidth: 0,
  },
  frame: {
    position: "relative", aspectRatio: "9 / 16", width: "100%", borderRadius: tokens.borderRadiusLarge, overflow: "hidden",
    backgroundColor: "#0B0B12", display: "flex", alignItems: "center", justifyContent: "center", color: "#FFFFFF",
    boxShadow: tokens.shadow8,
  },
  video: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  waiting: { display: "flex", flexDirection: "column", alignItems: "center", gap: tokens.spacingVerticalS, padding: tokens.spacingHorizontalL, textAlign: "center" },
  failed: { color: "#FDA29B", fontSize: "32px" },
  body: { display: "flex", flexDirection: "column", gap: "4px", padding: `0 ${tokens.spacingHorizontalXS}` },
  caption: { color: tokens.colorNeutralForeground2, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" },
  tags: { display: "flex", flexWrap: "wrap", gap: "4px" },
  meta: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground3 },
  actions: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalXXS, marginTop: "auto" },
  grow: { flexGrow: 1 },
});

interface Props {
  broadcastId: string;
  reel: Reel;
  busy: boolean;
  onDelete: () => void;
}

/** One vertical reel: the clip, the post to go with it, and the ways to take it away. */
export function ReelCard({ broadcastId, reel, busy, onDelete }: Props) {
  const styles = useStyles();
  const [copied, setCopied] = useState(false);
  const ai = reel.agent !== "template";
  return (
    <article className={styles.card} aria-label={`Reel: ${reel.title}`}>
      <div className={styles.frame}>
        {reel.state === "ready" ? (
          <video className={styles.video} src={reelUrl(broadcastId, reel.id)} controls preload="metadata" playsInline aria-label={`Play ${reel.title}`} />
        ) : reel.state === "rendering" ? (
          <div className={styles.waiting}>
            <Spinner size="small" appearance="inverted" />
            <Text size={200} style={{ color: "#FFFFFF" }}>Cutting the clip…</Text>
          </div>
        ) : (
          <div className={styles.waiting}>
            <ErrorCircleRegular className={styles.failed} />
            <Text size={200} style={{ color: "#FFFFFF" }}>{reel.reason ?? "The clip could not be made."}</Text>
          </div>
        )}
      </div>
      <div className={styles.body}>
        <Text weight="semibold">{reel.title}</Text>
        {reel.caption && <Text size={200} className={styles.caption}>{reel.caption}</Text>}
        {reel.hashtags.length > 0 && (
          <div className={styles.tags}>
            {reel.hashtags.map((tag) => <Badge key={tag} size="small" appearance="tint" color="brand">{tag}</Badge>)}
          </div>
        )}
        <span className={styles.meta}>
          <Badge size="small" appearance="outline" color={ai ? "important" : "informative"} icon={ai ? <BotSparkleRegular /> : <DocumentTextRegular />}>
            {ai ? "AI agents" : "Template"}
          </Badge>
          <Text size={200}>{`${Math.round(reel.duration_s)} s from ${clock(reel.start_s)}`}</Text>
        </span>
      </div>
      <div className={styles.actions}>
        <Tooltip content={copied ? "Copied" : "Copy title, caption and hashtags"} relationship="label">
          <Button size="small" appearance="subtle" icon={<CopyRegular />}
            onClick={() => void navigator.clipboard?.writeText(post(reel)).then(() => setCopied(true), () => undefined)} />
        </Tooltip>
        {reel.state === "ready" && (
          <Tooltip content="Download the MP4" relationship="label">
            <Button as="a" size="small" appearance="subtle" icon={<ArrowDownloadRegular />} href={reelUrl(broadcastId, reel.id)} download={`${reel.title}.mp4`} />
          </Tooltip>
        )}
        <span className={styles.grow} />
        <Tooltip content="Delete this reel" relationship="label">
          <Button size="small" appearance="subtle" icon={<DeleteRegular />} disabled={busy || reel.state === "rendering"} onClick={onDelete} />
        </Tooltip>
      </div>
    </article>
  );
}
