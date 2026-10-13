import { Button, makeStyles, mergeClasses, Text, tokens, Tooltip } from "@fluentui/react-components";
import {
  DataTrendingRegular, HomeRegular, OpenRegular, PeopleCommunityRegular, VideoClipMultipleRegular,
  WeatherMoonRegular, WeatherSunnyRegular,
} from "@fluentui/react-icons";
import type { ReactNode } from "react";
import type { Output } from "../contracts";
import { LiveStatus } from "../output/OutputTab";
import { useIsDark, useThemeChoice } from "../theme";
import { BrandLogo } from "./BrandLogo";

export type NavPage = "home" | "studio" | "match";

const LINKS: { page: NavPage | null; href: string; label: string; icon: ReactNode; newTab?: boolean }[] = [
  { page: "home", href: "/", label: "Home", icon: <HomeRegular /> },
  { page: "studio", href: "/studio", label: "Studio", icon: <VideoClipMultipleRegular /> },
  { page: "match", href: "/match", label: "Match data", icon: <DataTrendingRegular /> },
  { page: null, href: "/join", label: "Fan page", icon: <PeopleCommunityRegular />, newTab: true },];

const useStyles = makeStyles({
  nav: {
    position: "sticky", top: 0, zIndex: 10, display: "flex", flexWrap: "wrap", alignItems: "center",
    gap: tokens.spacingHorizontalL, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXL}`,
    backgroundColor: tokens.colorNeutralBackground1, borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
  },
  brand: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS, color: "inherit", textDecorationLine: "none" },
  brandText: { display: "flex", flexDirection: "column", lineHeight: 1.1 },
  links: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalXXS },
  link: {
    display: "inline-flex", alignItems: "center", gap: tokens.spacingHorizontalXS, padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium, color: tokens.colorNeutralForeground2, textDecorationLine: "none",
    fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300,
    ":hover": { backgroundColor: tokens.colorNeutralBackground1Hover, color: tokens.colorNeutralForeground1 },
    "& svg": { fontSize: "18px" },
  },
  current: {
    color: tokens.colorBrandForeground1, backgroundColor: tokens.colorBrandBackground2,
    ":hover": { color: tokens.colorBrandForeground1, backgroundColor: tokens.colorBrandBackground2Hover },
  },
  extras: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalM },
  end: { marginLeft: "auto", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: tokens.spacingHorizontalS },
});

interface AppNavProps {
  current: NavPage;
  /** The output document; the stream status shows while it is on. */
  output?: Output | null;
  /** Server time, in seconds. */
  now?: number;
  /** What the page adds to the bar, such as the scene on air. */
  children?: ReactNode;
}

/** The bar across the top of every streamer page: where to go, and whether the stream is on. */
export function AppNav({ current, output = null, now = Date.now() / 1000, children }: AppNavProps) {
  const styles = useStyles();
  const dark = useIsDark();
  const setChoice = useThemeChoice((state) => state.setChoice);
  return (
    <header className={styles.nav}>
      <a href="/" className={styles.brand} aria-label="Kickstream home">
        <BrandLogo />
        <span className={styles.brandText}>
          <Text weight="bold" size={400}>Kickstream</Text>
          <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>Live studio</Text>
        </span>
      </a>
      <nav aria-label="Main" className={styles.links}>
        {LINKS.map((link) => (
          <a key={link.href} href={link.href} className={mergeClasses(styles.link, link.page === current && styles.current)}
            aria-current={link.page === current ? "page" : undefined}
            {...(link.newTab ? { target: "_blank", rel: "noreferrer" } : {})}>
            {link.icon}
            {link.label}
            {link.newTab && <OpenRegular style={{ fontSize: 12, opacity: 0.6 }} />}
          </a>
        ))}
      </nav>
      {children && <div className={styles.extras}>{children}</div>}
      <div className={styles.end}>
        <LiveStatus output={output} now={now} />
        <Tooltip content={dark ? "Light theme" : "Dark theme"} relationship="label">
          <Button appearance="subtle" icon={dark ? <WeatherSunnyRegular /> : <WeatherMoonRegular />} onClick={() => setChoice(dark ? "light" : "dark")} />
        </Tooltip>
      </div>
    </header>
  );
}
