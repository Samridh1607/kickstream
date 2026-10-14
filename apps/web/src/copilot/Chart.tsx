import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { CompareBars, type CompareRow, LineGraph, NEUTRAL, Swatch } from "../charts/charts";
import type { CopilotChart, CopilotSeries } from "../contracts";

const SIDE_COLOR = { home: "#0F6CBD", away: "#C50F1F" } as const;
const PALETTE = ["#0F6CBD", "#8764B8", "#C239B3", "#CA5010"];

const useStyles = makeStyles({
  chart: {
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, margin: 0, padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground2, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground1,
  },
  caption: { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  line: { height: "150px" },
  bars: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  bar: { display: "grid", gridTemplateColumns: "minmax(0, 7em) minmax(0, 1fr) 3.4em", alignItems: "center", columnGap: tokens.spacingHorizontalS },
  track: { height: "10px", borderRadius: tokens.borderRadiusSmall, backgroundColor: tokens.colorNeutralBackground4, overflow: "hidden" },
  value: { textAlign: "right", fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: "tabular-nums" },
  legend: { display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalM, listStyleType: "none", margin: 0, padding: 0 },
  stacked: { flexDirection: "column", gap: tokens.spacingVerticalXS },
  key: { display: "inline-flex", alignItems: "center", gap: tokens.spacingHorizontalXS },
  donut: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalL },
});

const colorOf = (series: CopilotSeries, index: number) => (series.team ? SIDE_COLOR[series.team] : PALETTE[index % PALETTE.length]);
const decimals = (value: number) => (Number.isInteger(value) ? 0 : Math.abs(value * 10 - Math.round(value * 10)) < 1e-9 ? 1 : 2);
const format = (value: number, unit?: string | null) => `${value.toFixed(decimals(value))}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`;

/** Bars per label, one per series, measured against the largest value. */
function Bars({ chart }: { chart: CopilotChart }) {
  const styles = useStyles();
  const peak = Math.max(1e-9, ...chart.series.flatMap((series) => series.values));
  return (
    <div role="img" aria-label={chart.title} className={styles.bars}>
      {chart.labels.map((label, row) => (
        <div key={row}>
          {chart.series.map((series, index) => {
            const value = series.values[row] ?? 0;
            return (
              <div key={index} className={styles.bar}>
                <span>{index === 0 ? label : ""}</span>
                <span className={styles.track}>
                  <span style={{ display: "block", height: "100%", width: `${(Math.max(0, value) / peak) * 100}%`, backgroundColor: colorOf(series, index) }} />
                </span>
                <span className={styles.value}>{format(value, chart.unit)}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** A ring of the parts of a whole, one part per label, with each part's value beside it. */
function Ring({ chart }: { chart: CopilotChart }) {
  const styles = useStyles();
  const values = chart.series[0]?.values ?? [];
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
  const colors = chart.labels.length === 3 ? [SIDE_COLOR.home, NEUTRAL, SIDE_COLOR.away] : chart.labels.map((_, index) => PALETTE[index % PALETTE.length]);
  const radius = 40;
  const around = 2 * Math.PI * radius;
  const lengths = values.map((value) => (Math.max(0, value) / total) * around);
  const starts = lengths.map((_, index) => lengths.slice(0, index).reduce((sum, length) => sum + length, 0));
  return (
    <div className={styles.donut}>
      <svg viewBox="0 0 100 100" role="img" aria-label={chart.title} style={{ width: "96px", height: "96px", flexShrink: 0 }}>
        <g transform="rotate(-90 50 50)" fill="none" strokeWidth={14}>
          {lengths.map((length, index) => (
            <circle key={index} cx={50} cy={50} r={radius} stroke={colors[index]} strokeDasharray={`${Math.max(0, length - 1.5)} ${around}`} strokeDashoffset={-starts[index]} />
          ))}
        </g>
      </svg>
      <ul className={mergeClasses(styles.legend, styles.stacked)}>
        {chart.labels.map((label, index) => (
          <li key={index} className={styles.key}><Swatch color={colors[index]} />{label} <b>{format(values[index] ?? 0, chart.unit)}</b></li>
        ))}
      </ul>
    </div>
  );
}

/** One chart of an answer: home against away as compared bars, a ring of shares, lines over time, or plain bars. */
export function CopilotChartView({ chart }: { chart: CopilotChart }) {
  const styles = useStyles();
  const home = chart.series.find((series) => series.team === "home");
  const away = chart.series.find((series) => series.team === "away");
  const paired = chart.kind === "bar" && chart.series.length === 2 && home && away;
  let body;
  if (paired) {
    const rows: CompareRow[] = chart.labels.map((label, index) => {
      const values = [home.values[index] ?? 0, away.values[index] ?? 0];
      return { id: `${index}`, label, home: values[0], away: values[1], digits: Math.max(...values.map(decimals)), suffix: chart.unit === "%" ? "%" : "" };
    });
    body = <CompareBars rows={rows} colors={SIDE_COLOR} names={{ home: home.name, away: away.name }} />;
  } else if (chart.kind === "donut") {
    body = <Ring chart={chart} />;
  } else if (chart.kind === "line") {
    const all = chart.series.flatMap((series) => series.values);
    const xs = chart.labels.map((_, index) => index);
    body = (
      <div className={styles.line}>
        <LineGraph
          lines={chart.series.map((series, index) => ({ id: `${index}`, label: series.name, color: colorOf(series, index), values: series.values }))}
          xs={xs} xMax={Math.max(1, xs.length - 1)} yMin={Math.min(0, ...all)} yMax={Math.max(1, ...all) * 1.1} label={chart.title}
          format={(value) => format(value, chart.unit)} xLabel={(x) => chart.labels[x] ?? ""} surface={tokens.colorNeutralBackground2}
        />
      </div>
    );
  } else {
    body = <Bars chart={chart} />;
  }
  const legend = !paired && chart.kind === "bar" && chart.series.length > 1;
  return (
    <figure className={styles.chart} data-testid="copilot-chart" data-kind={chart.kind}>
      {/* A line graph captions itself. */}
      {chart.kind !== "line" && <figcaption className={styles.caption}>{chart.title}</figcaption>}
      {body}
      {legend && (
        <ul className={styles.legend}>
          {chart.series.map((series, index) => <li key={index} className={styles.key}><Swatch color={colorOf(series, index)} />{series.name}</li>)}
        </ul>
      )}
    </figure>
  );
}
