import {
  Badge, Button, Field, Input, makeStyles, mergeClasses, MessageBar, MessageBarBody, Select, Switch, Text, Textarea, tokens, Tooltip,
} from "@fluentui/react-components";
import {
  ChatRegular, DeleteRegular, DismissRegular, FlashRegular, MegaphoneRegular, MoneyRegular, PollRegular, SparkleRegular,
  StarFilled, StarRegular, TrophyRegular, TvRegular,
} from "@fluentui/react-icons";
import { type ReactNode, useState } from "react";
import { Swatch } from "../charts/charts";
import type { FanComment, FanSettings, FanZone } from "../contracts";
import { EASE, MotionStyles, SETTLE, slide } from "../motion/motion";
import { PlatformMark, platformLabel } from "../shell/PlatformMark";
import {
  addSuperchat, announcePoll, clearFans, clearSpotlight, closePoll, likeComment, openPoll, pickWinner, removePoll,
  saveFanSettings, setPollOnAir, showMessage, spotlightComment, spotlightSuperchat, type WinnerPool,
} from "./api";

const MOOD_COLOR = { positive: "#107C10", neutral: "#8A8F98", negative: "#C50F1F" } as const;
const MOOD_LABEL = { positive: "Positive", neutral: "Neutral", negative: "Negative" } as const;
const SOURCE_BADGE: Record<FanZone["source_state"], { text: string; color: "success" | "warning" | "informative" | "danger" }> = {
  off: { text: "Source off", color: "informative" },
  demo: { text: "Demo feed", color: "warning" },
  live: { text: "X connected", color: "success" },
  failing: { text: "Source failing", color: "danger" },
};
const POLL_PRESETS: { label: string; question: string; options: string[] }[] = [
  { label: "Who wins?", question: "Who wins from here?", options: ["Home", "Draw", "Away"] },
  { label: "Player of the match", question: "Who is your player of the match?", options: ["A forward", "A midfielder", "A defender", "The keeper"] },
  { label: "Next goal", question: "Will there be another goal?", options: ["Yes", "No"] },
];
const SHOWN_COMMENTS = 40;

const useStyles = makeStyles({
  panel: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
  section: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  heading: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  icon: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", width: "24px", height: "24px", borderRadius: tokens.borderRadiusMedium,
    fontSize: "16px", color: tokens.colorBrandForeground1, backgroundColor: tokens.colorBrandBackground2,
  },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalXS },
  grow: { flexGrow: 1 },
  card: {
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground3,
  },
  onAir: { border: `${tokens.strokeWidthThick} solid #D92D20`, backgroundColor: tokens.colorNeutralBackground1 },
  quick: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: tokens.spacingHorizontalS },
  quickButton: { justifyContent: "flex-start", transitionProperty: "transform, box-shadow", transitionDuration: "160ms", ":hover": { transform: "translateY(-2px)", boxShadow: tokens.shadow8 } },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, maxHeight: "340px", overflowY: "auto" },
  comment: {
    display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", alignItems: "start", columnGap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3,
  },
  liked: { backgroundColor: tokens.colorPaletteYellowBackground1 },
  text: { overflowWrap: "anywhere" },
  moodBar: { display: "flex", gap: "2px", height: "8px" },
  chips: { display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalXS },
  option: { position: "relative", overflow: "hidden", padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground4 },
  optionFill: { position: "absolute", top: 0, bottom: 0, left: 0, backgroundColor: tokens.colorBrandBackground2, transitionProperty: "width", transitionDuration: "600ms", transitionTimingFunction: EASE },
  optionText: { position: "relative", display: "flex", justifyContent: "space-between", gap: tokens.spacingHorizontalS },
  two: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: tokens.spacingHorizontalS },
});

function Section({ icon, title, extra, children }: { icon: ReactNode; title: string; extra?: ReactNode; children: ReactNode }) {
  const styles = useStyles();
  return (
    <section className={styles.section} aria-label={title}>
      <div className={styles.heading}>
        <span className={styles.icon} aria-hidden>{icon}</span>
        <Text as="h3" weight="semibold">{title}</Text>
        <span className={styles.grow} />
        {extra}
      </div>
      {children}
    </section>
  );
}

interface FanPanelProps {
  fans: FanZone | null;
  /** Sends one change and applies the fan zone it answers with. True when it was accepted. */
  onRun(request: () => Promise<FanZone>): Promise<boolean>;
}

/** The studio's fan zone: what fans are saying, the poll, superchats, and what to put on air. */
export function FanPanel({ fans, onRun }: FanPanelProps) {
  const styles = useStyles();
  if (!fans) return <Text size={200}>Connecting to the fan zone…</Text>;
  const run = (request: () => Promise<FanZone>) => void onRun(request);
  const badge = SOURCE_BADGE[fans.source_state];
  return (
    <div className={mergeClasses(styles.panel, "ks-motion")}>
      <MotionStyles />
      <Section icon={<FlashRegular />} title="Quick actions" extra={<Badge appearance="tint" color={badge.color}>{badge.text}</Badge>}>
        {fans.problem && (
          <MessageBar intent="warning">
            <MessageBarBody>{fans.problem}</MessageBarBody>
          </MessageBar>
        )}
        <OnAir fans={fans} run={run} />
        <QuickActions fans={fans} run={run} onRun={onRun} />
      </Section>
      <Summary fans={fans} />
      <PollBox fans={fans} run={run} onRun={onRun} />
      <Superchats fans={fans} run={run} onRun={onRun} />
      <Comments fans={fans} run={run} />
      <Source fans={fans} run={run} />
    </div>
  );
}

type Run = (request: () => Promise<FanZone>) => void;

function OnAir({ fans, run }: { fans: FanZone; run: Run }) {
  const styles = useStyles();
  const spotlight = fans.spotlight;
  if (!spotlight) return <Text size={200}>Nothing from the fan zone is on screen.</Text>;
  return (
    <div className={mergeClasses(styles.card, styles.onAir)} data-testid="fan-on-air" style={{ animation: slide() }}>
      <div className={styles.row}>
        <Badge color="danger" icon={<TvRegular />}>On screen</Badge>
        <Text size={200}>{spotlight.kind.replace("_", " ")}</Text>
        <span className={styles.grow} />
        {fans.spotlight_queue.length > 0 && <Text size={200}>{fans.spotlight_queue.length} waiting</Text>}
      </div>
      <Text weight="semibold">{[spotlight.name, spotlight.detail].filter(Boolean).join(" · ") || spotlight.title}</Text>
      {spotlight.text && <Text size={200} className={styles.text}>{spotlight.text}</Text>}
      <Button size="small" icon={<DismissRegular />} onClick={() => run(clearSpotlight)}>{fans.spotlight_queue.length > 0 ? "Next" : "Take off screen"}</Button>
    </div>
  );
}

function QuickActions({ fans, run, onRun }: { fans: FanZone; run: Run; onRun: FanPanelProps["onRun"] }) {
  const styles = useStyles();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [pool, setPool] = useState<WinnerPool>("commenters");
  const send = async () => {
    if (await onRun(() => showMessage({ title: title.trim(), text, duration_s: 10 }))) {
      setTitle("");
      setText("");
    }
  };
  return (
    <>
      <div className={styles.quick}>
        <Button className={styles.quickButton} icon={<TrophyRegular />} onClick={() => run(() => pickWinner(pool))}>Pick a winner</Button>
        <Button className={styles.quickButton} icon={<PollRegular />} disabled={!fans.poll} onClick={() => run(announcePoll)}>Show poll result</Button>
        <Button className={styles.quickButton} icon={<MoneyRegular />} disabled={fans.superchats.length === 0}
          onClick={() => run(() => spotlightSuperchat(fans.superchats[fans.superchats.length - 1].id))}>
          Thank last supporter
        </Button>
        <Button className={styles.quickButton} icon={<DismissRegular />} disabled={!fans.spotlight} onClick={() => run(clearSpotlight)}>Clear screen</Button>
      </div>
      <Field label="Pick the winner from">
        <Select value={pool} onChange={(_, data) => setPool(data.value as WinnerPool)}>
          <option value="commenters">Everyone who commented</option>
          <option value="voters">Everyone who voted in the poll</option>
          <option value="supporters">Everyone who sent a superchat</option>
        </Select>
      </Field>
      <Field label="Custom message">
        <Textarea value={text} maxLength={280} placeholder="Welcome to everyone joining from…" onChange={(_, data) => setText(data.value)} />
      </Field>
      <div className={styles.row}>
        <Input className={styles.grow} aria-label="Message title" placeholder="Title (optional)" maxLength={80} value={title} onChange={(_, data) => setTitle(data.value)} />
        <Button appearance="primary" icon={<MegaphoneRegular />} disabled={text.trim() === ""} onClick={() => void send()}>Show message</Button>
      </div>
    </>
  );
}

function Summary({ fans }: { fans: FanZone }) {
  const styles = useStyles();
  const { summary } = fans;
  const moods = (["positive", "neutral", "negative"] as const).map((mood) => ({ mood, share: summary.mood[mood] }));
  const mixed = moods.some(({ share }) => share > 0);
  return (
    <Section icon={<SparkleRegular />} title="Quick summary" extra={<Text size={200}>{summary.total} comments</Text>}>
      <Text data-testid="fan-summary">{summary.text}</Text>
      {mixed && (
        <>
          <div className={styles.moodBar} role="img" aria-label={moods.map(({ mood, share }) => `${MOOD_LABEL[mood]} ${Math.round(share)}%`).join(", ")}>
            {moods.map(({ mood, share }) => (
              <div key={mood} style={{ width: `${share}%`, minWidth: share > 0 ? 4 : 0, borderRadius: 4, backgroundColor: MOOD_COLOR[mood], transition: `width ${SETTLE}` }} />
            ))}
          </div>
          <div className={styles.chips}>
            {moods.map(({ mood, share }) => (
              <Text key={mood} size={200} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Swatch color={MOOD_COLOR[mood]} />{MOOD_LABEL[mood]} {Math.round(share)}%</Text>
            ))}
          </div>
        </>
      )}
      {summary.topics.length > 0 && (
        <div className={styles.chips} aria-label="Topics">
          {summary.topics.map((topic) => <Badge key={topic.label} appearance="tint" color="brand">{topic.label} · {topic.count}</Badge>)}
        </div>
      )}
      {(summary.platforms.length > 0 || summary.raised.length > 0) && (
        <div className={styles.chips}>
          {summary.platforms.map((share) => (
            <Text key={share.platform} size={200} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <PlatformMark platform={share.platform === "other" ? "custom" : share.platform} size={16} />{share.count}
            </Text>
          ))}
          {summary.raised.map((raised) => <Badge key={raised.currency} appearance="tint" color="success">{raised.currency} {raised.amount.toFixed(2)} raised</Badge>)}
        </div>
      )}
    </Section>
  );
}

function PollBox({ fans, run, onRun }: { fans: FanZone; run: Run; onRun: FanPanelProps["onRun"] }) {
  const styles = useStyles();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState("");
  const [minutes, setMinutes] = useState("");
  const poll = fans.poll;
  const choices = options.split("\n").map((line) => line.trim()).filter(Boolean);
  const start = async () => {
    if (await onRun(() => openPoll(question, choices, minutes === "" ? null : Number(minutes)))) {
      setQuestion("");
      setOptions("");
    }
  };
  const total = poll ? poll.options.reduce((sum, option) => sum + option.votes, 0) : 0;
  return (
    <Section icon={<PollRegular />} title="Poll" extra={poll && <Badge appearance="tint" color={poll.state === "open" ? "success" : "informative"}>{poll.state === "open" ? "Open" : "Closed"}</Badge>}>
      {poll ? (
        <div className={mergeClasses(styles.card, fans.poll_on_air && styles.onAir)} data-testid="fan-poll">
          <Text weight="semibold">{poll.question}</Text>
          {poll.options.map((option, index) => {
            const share = total === 0 ? 0 : (option.votes / total) * 100;
            return (
              <div key={option.id} className={styles.option}>
                <div className={styles.optionFill} style={{ width: `${share}%` }} />
                <div className={styles.optionText}>
                  <Text>{index + 1}. {option.text}</Text>
                  <Text weight="semibold">{option.votes} · {Math.round(share)}%</Text>
                </div>
              </div>
            );
          })}
          <Text size={200}>{total} votes. Fans vote by commenting the option's number.</Text>
          <div className={styles.row}>
            <Switch label="On screen" checked={fans.poll_on_air} onChange={(_, data) => run(() => setPollOnAir(data.checked))} />
            <span className={styles.grow} />
            {poll.state === "open" && <Button size="small" onClick={() => run(closePoll)}>Close voting</Button>}
            <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => run(removePoll)}>Remove</Button>
          </div>
        </div>
      ) : (
        <Text size={200}>No poll is running.</Text>
      )}
      <div className={styles.chips}>
        {POLL_PRESETS.map((preset) => (
          <Button key={preset.label} size="small" appearance="outline" onClick={() => { setQuestion(preset.question); setOptions(preset.options.join("\n")); }}>{preset.label}</Button>
        ))}
      </div>
      <Field label="Question">
        <Input value={question} maxLength={140} onChange={(_, data) => setQuestion(data.value)} />
      </Field>
      <Field label="Options, one per line" hint="2 to 6 options">
        <Textarea rows={3} value={options} onChange={(_, data) => setOptions(data.value)} />
      </Field>
      <div className={styles.row}>
        <Field label="Close after (minutes)" hint="Leave empty to close it by hand" className={styles.grow}>
          <Input type="number" min={1} max={60} value={minutes} onChange={(_, data) => setMinutes(data.value)} />
        </Field>
        <Button appearance="primary" disabled={question.trim() === "" || choices.length < 2} onClick={() => void start()}>{poll ? "Start a new poll" : "Start poll"}</Button>
      </div>
    </Section>
  );
}

function Superchats({ fans, run, onRun }: { fans: FanZone; run: Run; onRun: FanPanelProps["onRun"] }) {
  const styles = useStyles();
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [message, setMessage] = useState("");
  const add = async () => {
    if (await onRun(() => addSuperchat({ name, amount: Number(amount), currency, message }))) {
      setName("");
      setAmount("");
      setMessage("");
    }
  };
  const newest = [...fans.superchats].reverse().slice(0, 8);
  return (
    <Section icon={<MoneyRegular />} title="Superchats" extra={<Text size={200}>{fans.superchats.length}</Text>}>
      <Text size={200}>Fans pay on the platform. Kickstream shows who did; it takes no money itself.</Text>
      <ul className={styles.list} aria-label="Superchats">
        {newest.map((superchat) => (
          <li key={superchat.id} className={styles.comment} style={{ animation: slide() }}>
            <PlatformMark platform={superchat.platform === "other" ? "custom" : superchat.platform} size={20} />
            <span>
              <Text weight="semibold">{superchat.name} · {superchat.currency} {superchat.amount.toFixed(2)}</Text>
              {superchat.demo && <Badge size="small" appearance="outline" style={{ marginLeft: 6 }}>Demo</Badge>}
              {superchat.message && <Text block size={200} className={styles.text}>{superchat.message}</Text>}
            </span>
            <Button size="small" aria-label={`Thank ${superchat.name} on screen`} icon={<TvRegular />} onClick={() => run(() => spotlightSuperchat(superchat.id))}>Thank</Button>
          </li>
        ))}
      </ul>
      <div className={styles.two}>
        <Field label="Supporter's name"><Input value={name} maxLength={60} onChange={(_, data) => setName(data.value)} /></Field>
        <div className={styles.two}>
          <Field label="Amount"><Input type="number" min={0} step="0.01" value={amount} onChange={(_, data) => setAmount(data.value)} /></Field>
          <Field label="Currency"><Input value={currency} maxLength={3} onChange={(_, data) => setCurrency(data.value.toUpperCase())} /></Field>
        </div>
      </div>
      <Field label="Their message"><Input value={message} maxLength={200} onChange={(_, data) => setMessage(data.value)} /></Field>
      <Button disabled={name.trim() === "" || !(Number(amount) > 0) || currency.length !== 3} onClick={() => void add()}>Add superchat</Button>
      <Switch label="Show each new superchat on screen automatically" checked={fans.settings.auto_superchat}
        onChange={(_, data) => run(() => saveFanSettings({ ...fans.settings, auto_superchat: data.checked }))} />
    </Section>
  );
}

function CommentItem({ comment, run }: { comment: FanComment; run: Run }) {
  const styles = useStyles();
  return (
    <li className={mergeClasses(styles.comment, comment.liked && styles.liked)} data-testid="fan-panel-comment" style={{ animation: slide() }}>
      <Tooltip content={platformLabel(comment.platform === "other" ? "custom" : comment.platform)} relationship="label">
        <span><PlatformMark platform={comment.platform === "other" ? "custom" : comment.platform} size={20} /></span>
      </Tooltip>
      <span>
        <Text weight="semibold" size={200}>{comment.author}</Text>
        {comment.demo && <Badge size="small" appearance="outline" style={{ marginLeft: 6 }}>Demo</Badge>}
        <Text block className={styles.text}>{comment.text}</Text>
      </span>
      <span className={styles.row}>
        <Tooltip content={comment.liked ? "Unlike" : "Like: keep it and mark it on screen"} relationship="label">
          <Button size="small" appearance="subtle" aria-pressed={comment.liked} icon={comment.liked ? <StarFilled color="#F5B301" /> : <StarRegular />}
            onClick={() => run(() => likeComment(comment.id, !comment.liked))} />
        </Tooltip>
        <Tooltip content="Show on screen" relationship="label">
          <Button size="small" appearance="subtle" icon={<TvRegular />} onClick={() => run(() => spotlightComment(comment.id))} />
        </Tooltip>
      </span>
    </li>
  );
}

function Comments({ fans, run }: { fans: FanZone; run: Run }) {
  const styles = useStyles();
  const [likedOnly, setLikedOnly] = useState(false);
  const newestFirst = [...fans.comments].reverse().filter((comment) => !likedOnly || comment.liked).slice(0, SHOWN_COMMENTS);
  return (
    <Section icon={<ChatRegular />} title="Comments" extra={<Switch label="Liked only" checked={likedOnly} onChange={(_, data) => setLikedOnly(data.checked)} />}>
      {newestFirst.length === 0 && <Text size={200}>{likedOnly ? "Like a comment to keep it here." : "Comments appear here as fans post them."}</Text>}
      <ul className={styles.list} aria-label="Comments">
        {newestFirst.map((comment) => <CommentItem key={comment.id} comment={comment} run={run} />)}
      </ul>
    </Section>
  );
}

function Source({ fans, run }: { fans: FanZone; run: Run }) {
  const styles = useStyles();
  const choose = (source: FanSettings["source"]) => run(() => saveFanSettings({ ...fans.settings, source }));
  return (
    <Section icon={<ChatRegular />} title="Where comments come from">
      <Field label="Source" hint={fans.x_available ? "X reads recent posts matching KICKSTREAM_X_QUERY." : "To read X, put KICKSTREAM_X_BEARER_TOKEN and KICKSTREAM_X_QUERY in .env and restart. Other platforms can send comments to /api/fans/ingest."}>
        <Select value={fans.settings.source} onChange={(_, data) => choose(data.value as FanSettings["source"])}>
          <option value="demo">Demo feed (made-up fans)</option>
          <option value="x" disabled={!fans.x_available}>X</option>
          <option value="off">Off</option>
        </Select>
      </Field>
      <div className={styles.row}>
        <span className={styles.grow} />
        <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={() => run(clearFans)}>Clear comments, poll and superchats</Button>
      </div>
    </Section>
  );
}
