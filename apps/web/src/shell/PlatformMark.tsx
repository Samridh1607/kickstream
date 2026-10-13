import { makeStyles } from "@fluentui/react-components";
import { LinkRegular, PlayFilled, RecordRegular, VideoRegular } from "@fluentui/react-icons";
import type { ReactNode } from "react";
import type { Destination } from "../contracts";

type Platform = Destination["platform"];

const MARKS: Record<Platform, { label: string; color: string; glyph: ReactNode }> = {
  youtube: { label: "YouTube", color: "#FF0033", glyph: <PlayFilled /> },
  x: { label: "X", color: "#000000", glyph: <span style={{ fontWeight: 800 }}>X</span> },
  facebook: { label: "Facebook", color: "#0866FF", glyph: <span style={{ fontWeight: 800, fontFamily: "Arial, sans-serif" }}>f</span> },
  twitch: { label: "Twitch", color: "#9146FF", glyph: <VideoRegular /> },
  custom: { label: "Custom RTMP", color: "#475467", glyph: <LinkRegular /> },
  file: { label: "Record to file", color: "#0E9F6E", glyph: <RecordRegular /> },
};

const useStyles = makeStyles({
  mark: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    borderRadius: "6px", color: "#FFFFFF", lineHeight: 1,
  },
});

export const platformLabel = (platform: string) => (platform in MARKS ? MARKS[platform as Platform].label : platform);

/** A small coloured tile that tells the platforms apart at a glance. */
export function PlatformMark({ platform, size = 24 }: { platform: string; size?: number }) {
  const styles = useStyles();
  const mark = platform in MARKS ? MARKS[platform as Platform] : MARKS.custom;
  return (
    <span className={styles.mark} aria-hidden style={{ width: size, height: size, fontSize: Math.round(size * 0.6), backgroundColor: mark.color }}>
      {mark.glyph}
    </span>
  );
}
