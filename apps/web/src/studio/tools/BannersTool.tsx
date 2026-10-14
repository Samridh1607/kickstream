import { Button, Field, Input, makeStyles, Switch, Text, Textarea, tokens } from "@fluentui/react-components";
import { useEffect, useState } from "react";
import type { Studio, Ticker } from "../../contracts";

const useStyles = makeStyles({
  tool: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
  panel: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  item: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
});

// --- banner ------------------------------------------------------------------------------------

interface BannerPanelProps {
  studio: Studio;
  onShow(text: string): Promise<boolean>;
  onClear(): void;
  onAuto(enabled: boolean): void;
}

export function BannerPanel({ studio, onShow, onClear, onAuto }: BannerPanelProps) {
  const styles = useStyles();
  const [text, setText] = useState("");
  const show = async () => {
    if (await onShow(text)) setText("");
  };
  return (
    <div className={styles.panel}>
      <Field label="Banner text">
        <Input value={text} maxLength={200} onChange={(_, data) => setText(data.value)} />
      </Field>
      <Button appearance="primary" disabled={text.trim() === ""} onClick={() => void show()}>Show banner</Button>
      {studio.banner ? (
        <div className={styles.item}>
          <Text size={200}>On screen</Text>
          <Text>{studio.banner.text}</Text>
          <Button size="small" onClick={onClear}>Clear banner</Button>
        </div>
      ) : (
        <Text size={200}>No banner on screen.</Text>
      )}
      {studio.banner_queue.length > 0 && <Text size={200}>{studio.banner_queue.length} waiting</Text>}
      <Switch label="Automatic banners for goals and red cards" checked={studio.settings.auto_banner} onChange={(_, data) => onAuto(data.checked)} />
    </div>
  );
}

// --- ticker ------------------------------------------------------------------------------------

export function TickerPanel({ ticker, onSave }: { ticker: Ticker; onSave(ticker: Ticker): void }) {
  const styles = useStyles();
  const [draft, setDraft] = useState(ticker);
  const [lines, setLines] = useState(ticker.messages.join("\n"));
  const saved = JSON.stringify(ticker);
  useEffect(() => {
    const current = JSON.parse(saved) as Ticker;
    setDraft(current);
    setLines(current.messages.join("\n"));
  }, [saved]);
  const messages = lines.split("\n").map((line) => line.trim()).filter(Boolean);
  return (
    <div className={styles.panel}>
      <Switch label="Ticker on" checked={draft.enabled} onChange={(_, data) => setDraft({ ...draft, enabled: data.checked })} />
      <Field label="Messages, one per line" hint="Up to 20 messages of 120 characters">
        <Textarea rows={5} value={lines} onChange={(_, data) => setLines(data.value)} />
      </Field>
      <Field label="Speed" hint="40 (slow) to 400 (fast)">
        <Input type="number" min={40} max={400} value={String(draft.speed)} onChange={(_, data) => setDraft({ ...draft, speed: Number(data.value) })} />
      </Field>
      <Switch label="Show the score" checked={draft.show_score} onChange={(_, data) => setDraft({ ...draft, show_score: data.checked })} />
      <Switch label="Show match stats" checked={draft.show_stats} onChange={(_, data) => setDraft({ ...draft, show_stats: data.checked })} />
      <Button appearance="primary" onClick={() => onSave({ ...draft, messages })}>Save ticker</Button>
    </div>
  );
}

// --- tool --------------------------------------------------------------------------------------

interface BannersToolProps extends BannerPanelProps {
  onSaveTicker(ticker: Ticker): void;
}

/** The banner and the ticker, one under the other. */
export function BannersTool({ studio, onShow, onClear, onAuto, onSaveTicker }: BannersToolProps) {
  const styles = useStyles();
  return (
    <div className={styles.tool}>
      <section className={styles.panel} aria-label="Banner">
        <Text as="h3" weight="semibold">Banner</Text>
        <BannerPanel studio={studio} onShow={onShow} onClear={onClear} onAuto={onAuto} />
      </section>
      <section className={styles.panel} aria-label="Ticker">
        <Text as="h3" weight="semibold">Ticker</Text>
        <TickerPanel ticker={studio.ticker} onSave={onSaveTicker} />
      </section>
    </div>
  );
}
