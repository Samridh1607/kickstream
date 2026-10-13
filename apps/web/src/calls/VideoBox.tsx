import { makeStyles, tokens } from "@fluentui/react-components";
import { useEffect, useRef } from "react";
import type { RoomCall } from "./RoomCall";

const useStyles = makeStyles({
  tile: { position: "relative", margin: 0, aspectRatio: "16 / 9", overflow: "hidden", borderRadius: tokens.borderRadiusLarge, backgroundColor: "#101828" },
  video: { position: "absolute", inset: 0, "& video": { width: "100%", height: "100%", objectFit: "cover" } },
  label: {
    position: "absolute", left: tokens.spacingHorizontalS, bottom: tokens.spacingVerticalS, padding: `2px ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium, color: "#FFFFFF", backgroundColor: "rgba(16, 24, 40, 0.8)", fontSize: tokens.fontSizeBase200,
  },
});

/** One person's video from the call; `acsId` null is this page's own camera. */
export function VideoBox({ call, acsId, label }: { call: RoomCall; acsId: string | null; label: string }) {
  const styles = useStyles();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    return acsId === null ? call.renderLocal(element) : call.renderVideo(acsId, element);
  }, [call, acsId]);
  return (
    <figure className={styles.tile}>
      <div ref={box} className={styles.video} data-testid="video-box" />
      <figcaption className={styles.label}>{label}</figcaption>
    </figure>
  );
}
