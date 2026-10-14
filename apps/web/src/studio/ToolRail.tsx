import { Button, CounterBadge, makeStyles, Text, ToggleButton, tokens } from "@fluentui/react-components";
import {
  ChatRegular, DismissRegular, FlashRegular, LiveRegular, MegaphoneRegular, PeopleTeamRegular, SettingsRegular, TimerRegular,
} from "@fluentui/react-icons";
import type { ReactElement, ReactNode } from "react";

export const TOOLS = ["Banners", "Comments", "Guests", "Replays", "Timer", "Stream", "Settings"] as const;
export type ToolName = (typeof TOOLS)[number];

const TOOL_ICONS: Record<ToolName, ReactElement> = {
  Banners: <MegaphoneRegular />, Comments: <ChatRegular />, Guests: <PeopleTeamRegular />, Replays: <FlashRegular />,
  Timer: <TimerRegular />, Stream: <LiveRegular />, Settings: <SettingsRegular />,
};

const useStyles = makeStyles({
  root: { display: "flex", alignItems: "stretch", gap: tokens.spacingHorizontalS, height: "100%", minHeight: 0, minWidth: 0 },
  panel: {
    display: "flex", flexDirection: "column", width: "340px", flexShrink: 0, minHeight: 0,
    borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke3}`,
    "@media (max-width: 1100px)": { width: "auto", flexGrow: 1, flexShrink: 1, minWidth: 0, maxWidth: "360px" },
  },
  header: {
    display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS} ${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke3}`,
  },
  title: { flexGrow: 1 },
  body: { flexGrow: 1, minHeight: 0, overflowY: "auto", padding: tokens.spacingHorizontalL },
  rail: {
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, flexShrink: 0, padding: tokens.spacingVerticalXS,
    borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke3}`, overflowY: "auto",
  },
  tool: {
    position: "relative", flexDirection: "column", gap: "2px", width: "64px", minWidth: "64px", height: "56px",
    padding: `${tokens.spacingVerticalXS} 2px`,
    "@media (max-width: 1280px)": { width: "44px", minWidth: "44px", height: "44px" },
  },
  icon: { display: "inline-flex", fontSize: "20px" },
  label: {
    fontSize: tokens.fontSizeBase100, lineHeight: tokens.lineHeightBase100,
    "@media (max-width: 1280px)": { display: "none" },
  },
  badge: { position: "absolute", top: "2px", right: "6px" },
});

interface ToolRailProps {
  /** The tools offered; the studio leaves out Guests when it has no broadcast. */
  tools: readonly ToolName[];
  open: ToolName | null;
  onOpen(tool: ToolName | null): void;
  /** The open tool's panel. */
  children?: ReactNode;
  /** Small counts shown on a tool, e.g. { Comments: 3 } for new comments; optional. */
  badges?: Partial<Record<ToolName, number>>;
}

/** The studio's tools as an icon rail on the right, with the one open tool's panel beside it. */
export function ToolRail({ tools, open, onOpen, children, badges }: ToolRailProps) {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      {open !== null && (
        <section className={styles.panel} aria-label={`${open} tool`}>
          <div className={styles.header}>
            <Text as="h2" weight="semibold" size={400} className={styles.title}>{open}</Text>
            <Button appearance="subtle" size="small" icon={<DismissRegular />} aria-label="Close tool" onClick={() => onOpen(null)} />
          </div>
          <div className={styles.body}>{children}</div>
        </section>
      )}
      <nav className={styles.rail} aria-label="Tools">
        {tools.map((tool) => {
          const count = badges?.[tool] ?? 0;
          return (
            <ToggleButton key={tool} appearance="subtle" checked={open === tool} aria-label={tool} title={tool}
              className={styles.tool} onClick={() => onOpen(open === tool ? null : tool)}>
              <span className={styles.icon} aria-hidden>{TOOL_ICONS[tool]}</span>
              <span className={styles.label} aria-hidden>{tool}</span>
              {count > 0 && <CounterBadge className={styles.badge} size="small" count={count} />}
            </ToggleButton>
          );
        })}
      </nav>
    </div>
  );
}
