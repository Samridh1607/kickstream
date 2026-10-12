import { makeStyles, Select, Text, tokens } from "@fluentui/react-components";
import { useMemo, useState } from "react";
import type { Audience } from "../contracts";
import { LANGUAGE_NAMES, LANGUAGES, type Language, t } from "../i18n";
import { loadProfile, saveProfile } from "../prefs";
import { useLiveDocument } from "../stream/useLiveDocument";
import { askQuestion, AUDIENCE_STREAM, upvoteQuestion, votePoll } from "./api";
import { JoinPanel } from "./JoinPanel";
import { type Choices, getVoter, loadChoices, saveChoices, withAsked, withPollVote, withUpvoteToggled } from "./voter";

const useStyles = makeStyles({
  page: { minHeight: "100vh", display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL, padding: tokens.spacingHorizontalL, backgroundColor: tokens.colorNeutralBackground2 },
  bar: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: tokens.spacingHorizontalM, width: "100%", maxWidth: "640px", margin: "0 auto" },
});

interface LiveProps {
  language: Language;
  /** Injected by tests; the browser's EventSource is used otherwise. */
  eventSource?: new (url: string) => EventSource;
  retryMs?: number;
}

/** The fan panel wired to the server: the fan stream, this browser's ID, and what it has chosen. */
export function JoinLive({ language, eventSource, retryMs }: LiveProps) {
  const { doc, accept } = useLiveDocument<Audience>(AUDIENCE_STREAM, eventSource, retryMs);
  const voter = useMemo(() => getVoter(), []);
  const [choices, setChoices] = useState(loadChoices);
  const [problem, setProblem] = useState<string | null>(null);

  /** Runs one request. On success records the choice; on failure shows why and records nothing. */
  const attempt = async <T,>(request: () => Promise<T>, record: (current: Choices, result: T) => Choices, view: (result: T) => Audience) => {
    try {
      const result = await request();
      accept(view(result));
      // Built from the latest choices, not the ones captured when the button was pressed.
      setChoices((current) => {
        const next = record(current, result);
        saveChoices(next);
        return next;
      });
      setProblem(null);
      return true;
    } catch (caught) {
      // A refusal carries the server's reason. Anything else never reached it.
      setProblem(caught instanceof Error && "status" in caught ? caught.message : t(language, "sendFailed"));
      return false;
    }
  };

  const poll = doc?.poll;
  return (
    <JoinPanel
      audience={doc}
      choices={choices}
      remembered={voter.remembered}
      language={language}
      problem={problem}
      onVote={(optionId) => poll && void attempt(() => votePoll(voter.id, optionId), (current) => withPollVote(current, poll.id, optionId), (view) => view)}
      onUpvote={(questionId) => void attempt(() => upvoteQuestion(voter.id, questionId), (current) => withUpvoteToggled(current, questionId), (view) => view)}
      onAsk={(text, nickname) => attempt(() => askQuestion(voter.id, text, nickname), (current, asked) => withAsked(current, asked.id), (asked) => asked.audience)}
    />
  );
}

/** The page a streamer shares with viewers: /join. */
export function JoinPage({ eventSource, retryMs }: Omit<LiveProps, "language">) {
  const styles = useStyles();
  const [language, setLanguage] = useState<Language>(() => loadProfile().language);
  const choose = (next: Language) => {
    setLanguage(next);
    saveProfile({ ...loadProfile(), language: next });
  };
  return (
    <main className={styles.page}>
      <div className={styles.bar}>
        <Text as="h1" size={500} weight="semibold">{t(language, "appTitle")}</Text>
        <Select aria-label={t(language, "language")} value={language} onChange={(_, data) => choose(data.value as Language)}>
          {LANGUAGES.map((option) => (
            <option key={option} value={option}>{LANGUAGE_NAMES[option]}</option>
          ))}
        </Select>
      </div>
      <JoinLive language={language} eventSource={eventSource} retryMs={retryMs} />
    </main>
  );
}
