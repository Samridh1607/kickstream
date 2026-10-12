import { Button, makeStyles, Tab, TabList, Text, tokens } from "@fluentui/react-components";
import { useState } from "react";
import type { LowerThirdData, Overlay, PressureMapData, RecapCardData, StatCardData } from "../contracts";
import { type Language, type StringKey, t } from "../i18n";
import { latestOverlays } from "../stream/store";

type Kind = Overlay["kind"];
const KINDS: Kind[] = ["lower_third", "stat_card", "pressure_map", "recap_card"];

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM, padding: tokens.spacingHorizontalXL },
  columns: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: tokens.spacingHorizontalXL, alignItems: "start" },
  stage: { display: "flex", alignItems: "flex-end", minHeight: "220px", padding: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusLarge, backgroundColor: "#1B1B1B" },
  graphic: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, width: "100%", padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusMedium, color: "#FFFFFF", backgroundColor: "rgba(15, 108, 189, 0.92)" },
  table: { width: "100%", borderCollapse: "collapse", textAlign: "center" },
  heat: { display: "grid", gap: "2px", width: "100%", aspectRatio: "100 / 64" },
  json: { margin: 0, padding: tokens.spacingHorizontalM, maxHeight: "360px", overflow: "auto", borderRadius: tokens.borderRadiusMedium, fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, backgroundColor: tokens.colorNeutralBackground3 },
  side: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, alignItems: "flex-start" },
});

/** Draws an overlay from its JSON document and nothing else. */
export function OverlayGraphic({ overlay }: { overlay: Overlay }) {
  const styles = useStyles();
  switch (overlay.kind) {
    case "lower_third": {
      const data = overlay.data as LowerThirdData;
      return (
        <div className={styles.graphic} data-testid="overlay-graphic">
          <Text weight="bold" size={500}>{data.headline}</Text>
          <Text size={200}>{data.team} · {data.minute}'</Text>
          <Text>{data.subline}</Text>
        </div>
      );
    }
    case "stat_card": {
      const data = overlay.data as StatCardData;
      return (
        <div className={styles.graphic} data-testid="overlay-graphic">
          <table className={styles.table}>
            <tbody>
              {data.stat_rows.map((row) => (
                <tr key={row.label}>
                  <td>{row.home}</td>
                  <th scope="row">{row.label}</th>
                  <td>{row.away}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "pressure_map": {
      const data = overlay.data as PressureMapData;
      const peak = Math.max(1, ...data.home, ...data.away);
      return (
        <div className={styles.graphic} data-testid="overlay-graphic">
          <div className={styles.heat} style={{ gridTemplateColumns: `repeat(${data.cols}, 1fr)` }}>
            {data.home.map((home, index) => {
              const net = home - (data.away[index] ?? 0);
              const color = net >= 0 ? "255, 255, 255" : "255, 184, 0";
              return <div key={index} data-testid="pressure-cell" style={{ backgroundColor: `rgba(${color}, ${Math.abs(net) / peak})` }} />;
            })}
          </div>
        </div>
      );
    }
    case "recap_card": {
      const data = overlay.data as RecapCardData;
      return (
        <div className={styles.graphic} data-testid="overlay-graphic">
          <Text weight="bold" size={500}>{data.title}</Text>
          <Text size={700} weight="bold">{data.score}</Text>
          <ul>
            {data.bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
        </div>
      );
    }
  }
}

export function OverlayTab({ overlays, language }: { overlays: Overlay[]; language: Language }) {
  const styles = useStyles();
  const [chosen, setChosen] = useState<Kind | null>(null);
  const [copied, setCopied] = useState(false);
  const latest = latestOverlays(overlays);
  const available = KINDS.filter((kind) => latest[kind]);
  const newest = overlays[overlays.length - 1];

  if (!newest) {
    return (
      <div className={styles.root}>
        <Text>{t(language, "overlayEmpty")}</Text>
      </div>
    );
  }
  // Until the viewer picks a kind, follow whatever was broadcast most recently.
  const kind = chosen && latest[chosen] ? chosen : newest.kind;
  const overlay = latest[kind] as Overlay;
  const json = JSON.stringify(overlay, null, 2);

  const copy = async () => {
    await navigator.clipboard.writeText(json);
    setCopied(true);
  };

  return (
    <div className={styles.root}>
      <TabList selectedValue={kind} onTabSelect={(_, data) => { setChosen(data.value as Kind); setCopied(false); }}>
        {available.map((option) => (
          <Tab key={option} value={option}>{t(language, `overlay_${option}` as StringKey)}</Tab>
        ))}
      </TabList>
      <div className={styles.columns}>
        <div className={styles.stage}>
          <OverlayGraphic overlay={overlay} />
        </div>
        <div className={styles.side}>
          <Button onClick={copy}>{t(language, copied ? "copied" : "copy")}</Button>
          <pre className={styles.json} data-testid="overlay-json">{json}</pre>
        </div>
      </div>
    </div>
  );
}
