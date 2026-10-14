import { Button, Field, Input, makeStyles, Text, tokens } from "@fluentui/react-components";
import { useState } from "react";
import type { Studio } from "../../contracts";
import { formatRemaining } from "../format";

const useStyles = makeStyles({
  panel: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  item: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
});

// --- countdown ---------------------------------------------------------------------------------

interface CountdownPanelProps {
  studio: Studio;
  /** The server's clock, Unix seconds. */
  now: number;
  onStart(startsAt: number): void;
  onBreak(minutes: number): void;
  onEnd(): void;
}

export function CountdownPanel({ studio, now, onStart, onBreak, onEnd }: CountdownPanelProps) {
  const styles = useStyles();
  const [startIn, setStartIn] = useState("10");
  const [breakFor, setBreakFor] = useState("5");
  const countdown = studio.countdown;
  const onBreakNow = countdown?.kind === "break";
  return (
    <div className={styles.panel}>
      {countdown && (
        <div className={styles.item}>
          <Text>{`${onBreakNow ? "Break" : "Kick-off"}: ${formatRemaining(countdown.ends_at - now)} left`}</Text>
          <Button size="small" onClick={onEnd}>{onBreakNow ? "End break" : "End countdown"}</Button>
        </div>
      )}
      <Field label="Start in (minutes)" hint="1 to 1440. The match starts and the program cuts to Live when it reaches zero.">
        <Input type="number" min={1} max={1440} value={startIn} onChange={(_, data) => setStartIn(data.value)} />
      </Field>
      <Button onClick={() => onStart(now + Number(startIn) * 60)} disabled={!(Number(startIn) >= 1)}>Start countdown</Button>
      <Field label="Break length (minutes)" hint="1 to 60. The program returns to the scene it left.">
        <Input type="number" min={1} max={60} value={breakFor} onChange={(_, data) => setBreakFor(data.value)} />
      </Field>
      <Button onClick={() => onBreak(Number(breakFor))} disabled={!(Number(breakFor) >= 1)}>Take a break</Button>
    </div>
  );
}

export const TimerTool = CountdownPanel;
