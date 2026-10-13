import { Badge, Button, Field, Input, makeStyles, MessageBar, MessageBarBody, Text, Textarea, tokens } from "@fluentui/react-components";
import { ArrowUpFilled, ChatMultipleRegular, PollRegular, QuestionCircleRegular, SendRegular, SparkleRegular } from "@fluentui/react-icons";
import { type ReactNode, useState } from "react";
import type { Audience, Poll, Question } from "../contracts";
import { type Language, t } from "../i18n";
import type { Choices } from "./voter";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXL, width: "100%", maxWidth: "640px", margin: "0 auto" },
  card: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM, padding: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow2 },
  heading: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  icon: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", width: "32px", height: "32px", flexShrink: 0, fontSize: "18px",
    borderRadius: tokens.borderRadiusMedium, color: tokens.colorBrandForeground1, backgroundColor: tokens.colorBrandBackground2,
  },
  title: { margin: 0 },
  option: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXXS },
  bar: { height: "8px", borderRadius: tokens.borderRadiusCircular, backgroundColor: tokens.colorNeutralBackground4, overflow: "hidden" },
  fill: { height: "100%", backgroundColor: tokens.colorBrandBackground },
  row: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  grow: { flexGrow: 1, minWidth: 0, overflowWrap: "anywhere" },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  question: { display: "flex", gap: tokens.spacingHorizontalM, alignItems: "flex-start" },
  answer: { padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorBrandBackground2 },
});

interface JoinPanelProps {
  audience: Audience | null;
  choices: Choices;
  /** False when this browser cannot store the fan's ID and choices. */
  remembered: boolean;
  language: Language;
  /** Why the last vote or question was not accepted, if it was not. */
  problem: string | null;
  onVote(optionId: string): void;
  /** Resolves to true when the question was accepted. */
  onAsk(text: string, nickname: string): Promise<boolean>;
  onUpvote(questionId: string): void;
}

function PollCard({ poll, chosen, language, onVote }: { poll: Poll | null | undefined; chosen: string | undefined; language: Language; onVote(optionId: string): void }) {
  const styles = useStyles();
  if (!poll) return <Text>{t(language, "noPoll")}</Text>;
  const open = poll.state === "open";
  const total = poll.options.reduce((sum, option) => sum + option.votes, 0);
  const showResults = !open || chosen !== undefined;
  return (
    <>
      <div className={styles.heading}>
        <Text weight="semibold" size={400} className={styles.grow}>{poll.question}</Text>
        <Badge color={open ? "success" : "subtle"}>{t(language, open ? "pollOpen" : "pollClosed")}</Badge>
      </div>
      {poll.options.map((option) => {
        const percent = total === 0 ? 0 : Math.round((option.votes / total) * 100);
        return (
          <div key={option.id} className={styles.option} data-testid={`poll-option-${option.id}`}>
            <div className={styles.row}>
              {open ? (
                <Button className={styles.grow} appearance={chosen === option.id ? "primary" : "secondary"} onClick={() => onVote(option.id)}>
                  {option.text}
                </Button>
              ) : (
                <Text className={styles.grow}>{option.text}</Text>
              )}
              {chosen === option.id && <Badge appearance="tint">{t(language, "yourVote")}</Badge>}
            </div>
            {showResults && (
              <>
                <div className={styles.bar}>
                  <div className={styles.fill} style={{ width: `${percent}%` }} />
                </div>
                <Text size={200}>{`${option.votes} ${t(language, "votes")} · ${percent}%`}</Text>
              </>
            )}
          </div>
        );
      })}
      {!showResults && <Text size={200}>{t(language, "voteToSee")}</Text>}
    </>
  );
}

function QuestionItem({ question, mine, upvoted, language, onUpvote }: { question: Question; mine: boolean; upvoted: boolean; language: Language; onUpvote(): void }) {
  const styles = useStyles();
  return (
    <li className={styles.question} data-testid={`question-${question.id}`}>
      <Button aria-label={`${t(language, "upvote")}: ${question.text}`} aria-pressed={upvoted || mine} icon={<ArrowUpFilled />}
        appearance={upvoted || mine ? "primary" : "secondary"} disabled={mine || question.state !== "open"} onClick={onUpvote}>
        {question.votes}
      </Button>
      <div className={styles.grow}>
        <div className={styles.row}>
          <Text size={200} weight="semibold">{question.nickname}</Text>
          {mine && <Badge appearance="tint">{t(language, "yours")}</Badge>}
        </div>
        <Text block>{question.text}</Text>
        {question.answer && (
          <div className={styles.answer}>
            <div className={styles.row}>
              <SparkleRegular />
              <Text size={200} weight="semibold">{t(language, "expertAnswer")}</Text>
            </div>
            <Text block>{question.answer}</Text>
          </div>
        )}
      </div>
    </li>
  );
}

function CardTitle({ icon, children }: { icon: ReactNode; children: string }) {
  const styles = useStyles();
  return (
    <div className={styles.heading}>
      <span className={styles.icon}>{icon}</span>
      <Text as="h2" size={400} weight="semibold" className={styles.title}>{children}</Text>
    </div>
  );
}

/** What a fan sees: the current poll, a box to ask the expert, and the questions others have asked. */
export function JoinPanel({ audience, choices, remembered, language, problem, onVote, onAsk, onUpvote }: JoinPanelProps) {
  const styles = useStyles();
  const [text, setText] = useState("");
  const [nickname, setNickname] = useState("");
  const [sending, setSending] = useState(false);
  const poll = audience?.poll;
  const questions = audience?.questions ?? [];

  const ask = async () => {
    setSending(true);
    const accepted = await onAsk(text.trim(), nickname.trim());
    setSending(false);
    if (accepted) setText("");
  };

  return (
    <div className={styles.root}>
      {!remembered && (
        <MessageBar intent="warning">
          <MessageBarBody>{t(language, "notRemembered")}</MessageBarBody>
        </MessageBar>
      )}
      {problem && (
        <MessageBar intent="error">
          <MessageBarBody>{problem}</MessageBarBody>
        </MessageBar>
      )}
      <section className={styles.card} aria-label={t(language, "pollTitle")}>
        <CardTitle icon={<PollRegular />}>{t(language, "pollTitle")}</CardTitle>
        <PollCard poll={poll} chosen={poll ? choices.polls[poll.id] : undefined} language={language} onVote={onVote} />
      </section>
      <section className={styles.card} aria-label={t(language, "askTitle")}>
        <CardTitle icon={<QuestionCircleRegular />}>{t(language, "askTitle")}</CardTitle>
        <Field label={t(language, "yourQuestion")}>
          <Textarea value={text} maxLength={200} onChange={(_, data) => setText(data.value)} />
        </Field>
        <Field label={t(language, "nickname")}>
          <Input value={nickname} maxLength={24} onChange={(_, data) => setNickname(data.value)} />
        </Field>
        <Button appearance="primary" icon={<SendRegular />} disabled={sending || text.trim() === ""} onClick={() => void ask()}>{t(language, "send")}</Button>
      </section>
      <section className={styles.card} aria-label={t(language, "questionsTitle")}>
        <CardTitle icon={<ChatMultipleRegular />}>{t(language, "questionsTitle")}</CardTitle>
        {questions.length === 0 ? (
          <Text>{t(language, "noQuestions")}</Text>
        ) : (
          <ul className={styles.list}>
            {questions.map((question) => (
              <QuestionItem key={question.id} question={question} language={language} mine={choices.asked.includes(question.id)}
                upvoted={choices.upvoted.includes(question.id)} onUpvote={() => onUpvote(question.id)} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
