import { Badge, Button, Field, Input, makeStyles, Select, Switch, Text, Textarea, tokens } from "@fluentui/react-components";
import {
  ChatMultipleRegular, DismissRegular, EyeOffRegular, EyeRegular, HistoryRegular, LiveFilled, PollRegular, SparkleRegular,
} from "@fluentui/react-icons";
import { type ReactNode, useEffect, useState } from "react";
import type { Audience } from "../contracts";
import {
  airDraft, askExpert, clearQa, closePoll, createPoll, discardDraft, hideQuestion, presetPoll, restorePoll, saveDraft,
  setPollOnAir, unhideQuestion,
} from "./api";

const TIME_LIMITS = [["", "No time limit"], ["30", "30 seconds"], ["60", "1 minute"], ["120", "2 minutes"], ["300", "5 minutes"], ["600", "10 minutes"]];
const DRAFT_NOTES = {
  writing: "The expert is writing…",
  unavailable: "No expert answer. Write your own.",
  ready: "Check the answer, edit it if you like, then put it on air.",
};

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
  section: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalS },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  wrap: { overflowWrap: "anywhere" },
  title: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS, "& svg": { fontSize: "18px", color: tokens.colorBrandForeground1 } },
});

function Title({ icon, children }: { icon: ReactNode; children: string }) {
  const styles = useStyles();
  return (
    <div className={styles.title}>
      {icon}
      <Text weight="semibold">{children}</Text>
    </div>
  );
}

interface AudienceTabProps {
  audience: Audience | null;
  /** Sends one change and applies the answer. Resolves to true when it was accepted. */
  onRun(request: () => Promise<Audience>): Promise<boolean>;
}

/** The streamer's side of polls and AskExpert. */
export function AudienceTab({ audience, onRun }: AudienceTabProps) {
  const styles = useStyles();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState("");
  const [limit, setLimit] = useState("");
  const draft = audience?.draft ?? null;
  const [answer, setAnswer] = useState(draft?.text ?? "");

  // Take the server's text whenever the draft changes there: a new question, or the expert finishing.
  const draftKey = draft ? `${draft.question_id}:${draft.state}:${draft.text}` : "";
  useEffect(() => setAnswer(draft?.text ?? ""), [draftKey]);

  if (!audience) return <Text>Connecting to the audience…</Text>;

  const start = async () => {
    const lines = options.split("\n").map((line) => line.trim()).filter(Boolean);
    const poll = limit === "" ? { question, options: lines } : { question, options: lines, duration_s: Number(limit) };
    if (await onRun(() => createPoll(poll))) {
      setQuestion("");
      setOptions("");
    }
  };

  const air = async () => {
    // Save what the streamer sees before airing it, so the two can never differ.
    if (answer !== draft?.text && !(await onRun(() => saveDraft(answer)))) return;
    await onRun(() => airDraft());
  };

  const poll = audience.poll;
  const drafted = draft ? audience.questions.find((item) => item.id === draft.question_id) : undefined;

  return (
    <div className={styles.root}>
      <section className={styles.section} aria-label="New poll">
        <Title icon={<PollRegular />}>New poll</Title>
        <Field label="Poll question">
          <Input value={question} maxLength={140} onChange={(_, data) => setQuestion(data.value)} />
        </Field>
        <Field label="Options, one per line" hint="2 to 6 options">
          <Textarea rows={4} value={options} onChange={(_, data) => setOptions(data.value)} />
        </Field>
        <Field label="Time limit">
          <Select value={limit} onChange={(_, data) => setLimit(data.value)}>
            {TIME_LIMITS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </Select>
        </Field>
        <div className={styles.row}>
          <Button appearance="primary" disabled={question.trim() === ""} onClick={() => void start()}>Start poll</Button>
          <Button onClick={() => void onRun(() => presetPoll("winner"))}>Who will win?</Button>
          <Button onClick={() => void onRun(() => presetPoll("next_goal"))}>Who scores next?</Button>
        </div>
      </section>

      {poll && (
        <section className={styles.section} aria-label="Current poll">
          <div className={styles.row}>
            <Text weight="semibold" className={styles.wrap}>{poll.question}</Text>
            <Badge color={poll.state === "open" ? "success" : "subtle"}>{poll.state === "open" ? "Open" : "Closed"}</Badge>
          </div>
          <ul className={styles.list}>
            {poll.options.map((option) => (
              <li key={option.id}>
                <Text className={styles.wrap}>{`${option.text}: ${option.votes}`}</Text>
              </li>
            ))}
          </ul>
          <Switch label="Show poll on the program" checked={audience.poll_on_air} onChange={(_, data) => void onRun(() => setPollOnAir(data.checked))} />
          {poll.state === "open" && <Button onClick={() => void onRun(closePoll)}>Close poll</Button>}
        </section>
      )}

      {audience.history.length > 0 && (
        <section className={styles.section} aria-label="Earlier polls">
          <Title icon={<HistoryRegular />}>Earlier polls</Title>
          <ul className={styles.list}>
            {audience.history.map((earlier) => (
              <li key={earlier.id} className={styles.row}>
                <Text className={styles.wrap}>{earlier.question}</Text>
                <Button size="small" aria-label={`Show again: ${earlier.question}`} onClick={() => void onRun(() => restorePoll(earlier.id))}>Show again</Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {audience.qa && (
        <section className={styles.section} aria-label="On air">
          <Title icon={<LiveFilled />}>On air</Title>
          <Text className={styles.wrap}>{audience.qa.question}</Text>
          <Text className={styles.wrap}>{audience.qa.answer}</Text>
          <Button icon={<DismissRegular />} onClick={() => void onRun(clearQa)}>Take off air</Button>
        </section>
      )}

      {draft && (
        <section className={styles.section} aria-label="Answer draft">
          <Text weight="semibold" className={styles.wrap}>{drafted?.text ?? "This question is no longer in the list."}</Text>
          <Text size={200}>{DRAFT_NOTES[draft.state]}</Text>
          <Field label="Answer" hint="Up to 400 characters">
            <Textarea rows={4} value={answer} maxLength={400} onChange={(_, data) => setAnswer(data.value)} />
          </Field>
          <div className={styles.row}>
            <Button appearance="primary" icon={<LiveFilled />} disabled={answer.trim() === ""} onClick={() => void air()}>Put on air</Button>
            <Button onClick={() => void onRun(discardDraft)}>Discard answer</Button>
          </div>
        </section>
      )}

      <section className={styles.section} aria-label="Fan questions">
        <Title icon={<ChatMultipleRegular />}>Fan questions</Title>
        {audience.questions.length === 0 && <Text size={200}>Questions from fans appear here.</Text>}
        <ul className={styles.list}>
          {audience.questions.map((item) => (
            <li key={item.id} data-testid={`studio-question-${item.id}`}>
              <Text block className={styles.wrap} style={{ opacity: item.state === "hidden" ? 0.6 : 1 }}>{item.text}</Text>
              <Text size={200} block>{`${item.votes} votes · ${item.nickname}`}</Text>
              {item.answer && <Text size={200} block className={styles.wrap}>{item.answer}</Text>}
              <div className={styles.row}>
                {item.state === "open" && (
                  <Button size="small" appearance="primary" aria-label={`Ask the expert: ${item.text}`} icon={<SparkleRegular />} onClick={() => void onRun(() => askExpert(item.id))}>Ask the expert</Button>
                )}
                {item.state !== "hidden" && (
                  <Button size="small" aria-label={`Hide: ${item.text}`} icon={<EyeOffRegular />} onClick={() => void onRun(() => hideQuestion(item.id))}>Hide</Button>
                )}
                {item.state === "hidden" && (
                  <Button size="small" aria-label={`Unhide: ${item.text}`} icon={<EyeRegular />} onClick={() => void onRun(() => unhideQuestion(item.id))}>Unhide</Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
