import { Badge, Button, makeStyles, Spinner, Text, tokens, ToggleButton, Tooltip } from "@fluentui/react-components";
import {
  ArrowDownloadRegular, BotSparkleRegular, CopyRegular, DeleteRegular, DocumentTextRegular, ErrorCircleRegular, VideoClipRegular,
} from "@fluentui/react-icons";
import { useState } from "react";
import type { Reel } from "../contracts";
import { editedReelUrl, reelUrl } from "./api";
import { ClipchampDialog } from "./ClipchampDialog";
import type { ClipchampDeps } from "./clipchamp";
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
  versions: { display: "flex", gap: tokens.spacingHorizontalXXS },
  clipchamp: { justifyContent: "center" },
});

interface Props {
  broadcastId: string;
  reel: Reel;
  busy: boolean;
  onDelete: () => void;
  clipchamp?: ClipchampDeps;
}

/** One vertical reel: the clip, the post to go with it, and the ways to take it away. */
export function ReelCard({ broadcastId, reel, busy, onDelete, clipchamp }: Props) {
  const styles = useStyles();
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [original, setOriginal] = useState(false);
  const ai = reel.agent !== "template";
  // With an edited version, it is the one shown and downloaded, unless the original is chosen.
  const showEdited = reel.edited != null && !original;
  const src = showEdited && reel.edited ? editedReelUrl(broadcastId, reel.id, reel.edited.added_at) : reelUrl(broadcastId, reel.id);
  return (
    <article className={styles.card} aria-label={`Reel: ${reel.title}`}>
      <div className={styles.frame}>
        {reel.state === "ready" ? (
          <video key={src} className={styles.video} src={src} controls preload="metadata" playsInline
            aria-label={`Play ${reel.title}${showEdited ? " (edited)" : ""}`} />
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
          {reel.edited && <Badge size="small" appearance="filled" color="success" icon={<VideoClipRegular />}>Edited in Clipchamp</Badge>}
        </span>
        {reel.edited && (
          <div className={styles.versions} role="group" aria-label="Version shown">
            <ToggleButton size="small" checked={showEdited} onClick={() => setOriginal(false)}>Edited</ToggleButton>
            <ToggleButton size="small" checked={!showEdited} onClick={() => setOriginal(true)}>Original</ToggleButton>
          </div>
        )}
      </div>
      {reel.state === "ready" && (
        <Button className={styles.clipchamp} size="small" icon={<VideoClipRegular />} onClick={() => setEditing(true)}>
          {reel.edited ? "Edit again in Clipchamp" : "Edit in Clipchamp"}
        </Button>
      )}
      <div className={styles.actions}>
        <Tooltip content={copied ? "Copied" : "Copy title, caption and hashtags"} relationship="label">
          <Button size="small" appearance="subtle" icon={<CopyRegular />}
            onClick={() => void navigator.clipboard?.writeText(post(reel)).then(() => setCopied(true), () => undefined)} />
        </Tooltip>
        {reel.state === "ready" && (
          <Tooltip content={showEdited ? "Download the edited MP4" : "Download the MP4"} relationship="label">
            <Button as="a" size="small" appearance="subtle" icon={<ArrowDownloadRegular />} href={src}
              download={showEdited ? `${reel.title} (edited).mp4` : `${reel.title}.mp4`} />
          </Tooltip>
        )}
        <span className={styles.grow} />
        <Tooltip content="Delete this reel" relationship="label">
          <Button size="small" appearance="subtle" icon={<DeleteRegular />} disabled={busy || reel.state === "rendering"} onClick={onDelete} />
        </Tooltip>
      </div>
      {editing && <ClipchampDialog broadcastId={broadcastId} reel={reel} open onClose={() => setEditing(false)} clipchamp={clipchamp} />}
    </article>
  );
}
