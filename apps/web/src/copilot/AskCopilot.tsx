import { Badge, Button, makeStyles, mergeClasses, Switch, Text, tokens, Tooltip } from "@fluentui/react-components";
import {
  ArrowSwapRegular, ChatAddRegular, DataTrendingRegular, DismissRegular, FlashRegular, GlobeRegular, HistoryRegular, NumberSymbolRegular,
  PersonRunningRegular, SendFilled, SparkleFilled,
} from "@fluentui/react-icons";
import { type KeyboardEvent, type ReactElement, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Swatch } from "../charts/charts";
import type { CopilotAnswer, CopilotCard, CopilotInfo } from "../contracts";
import { EASE, MotionStyles, rise } from "../motion/motion";
import { loadProfile } from "../prefs";
import { askCopilot, fetchCopilotInfo } from "./api";

const SIDE_COLOR = { home: "#0F6CBD", away: "#C50F1F" } as const;
const MAX_QUESTION = 300;

const STARTERS: { text: string; icon: ReactElement }[] = [
  { text: "What is the score?", icon: <NumberSymbolRegular /> },
  { text: "Who will win from here?", icon: <DataTrendingRegular /> },
  { text: "Show me the head to head", icon: <ArrowSwapRegular /> },
  { text: "Who is the best player so far?", icon: <PersonRunningRegular /> },
  { text: "Show the last goal's play card", icon: <FlashRegular /> },
  { text: "Show the play history", icon: <HistoryRegular /> },
];

interface Turn {
  id: number;
  question: string;
  /** Absent while the answer is on its way. */
  answer?: CopilotAnswer;
  /** Why there is no answer, when the request failed. */
  failure?: string;
}

interface CopilotState {
  open: boolean;
  turns: Turn[];
  web: boolean;
  setOpen(open: boolean): void;
  setWeb(web: boolean): void;
  ask(question: string): Promise<void>;
  clear(): void;
}

let nextTurn = 1;

/** The conversation, kept while the page is open so closing the pane does not lose it. */
export const useCopilot = create<CopilotState>((set, get) => ({
  open: false,
  turns: [],
  web: false,
  setOpen: (open) => set({ open }),
  setWeb: (web) => set({ web }),
  clear: () => set({ turns: [] }),
  ask: async (asked) => {
    const question = asked.trim();
    if (question === "" || get().turns.some((turn) => !turn.answer && !turn.failure)) return;
    const id = nextTurn++;
    set((state) => ({ turns: [...state.turns, { id, question }] }));
    const settle = (result: Partial<Turn>) =>
      set((state) => ({ turns: state.turns.map((turn) => (turn.id === id ? { ...turn, ...result } : turn)) }));
    try {
      settle({ answer: await askCopilot(question, { mode: loadProfile().mode, web: get().web }) });
    } catch (caught) {
      settle({ failure: caught instanceof Error ? caught.message : "The question could not be answered." });
    }
  },
}));

const useStyles = makeStyles({
  launcher: {
    backgroundImage: `linear-gradient(120deg, ${tokens.colorBrandBackground} 0%, #B14AED 100%)`, color: tokens.colorNeutralForegroundOnBrand,
    border: "none", transitionProperty: "transform, box-shadow, filter", transitionDuration: "180ms",
    ":hover": { color: tokens.colorNeutralForegroundOnBrand, transform: "translateY(-1px)", boxShadow: tokens.shadow8, filter: "brightness(1.08)" },
    ":hover:active": { color: tokens.colorNeutralForegroundOnBrand, transform: "none" },
  },
  pane: {
    position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 40, width: "min(440px, 100vw)", display: "flex", flexDirection: "column",
    backgroundColor: tokens.colorNeutralBackground1, borderLeft: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow64, animationName: "ks-slide", animationDuration: "320ms", animationTimingFunction: EASE, animationFillMode: "both",
  },
  header: {
    display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS, padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  mark: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", width: "32px", height: "32px", flexShrink: 0, fontSize: "18px",
    borderRadius: tokens.borderRadiusLarge, color: "#FFFFFF", backgroundImage: `linear-gradient(135deg, ${tokens.colorBrandBackground} 0%, #B14AED 60%, #F0569A 100%)`,
  },
  small: { width: "24px", height: "24px", fontSize: "14px", borderRadius: tokens.borderRadiusMedium },
  titles: { display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0, lineHeight: 1.2 },
  muted: { color: tokens.colorNeutralForeground3 },
  thread: { flexGrow: 1, overflowY: "auto", padding: tokens.spacingHorizontalL, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
  welcome: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalXXL },
  starters: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: tokens.spacingHorizontalS },
  starter: {
    display: "flex", flexDirection: "column", alignItems: "flex-start", gap: tokens.spacingVerticalXS, minHeight: "76px", textAlign: "left",
    padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusLarge, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1, fontFamily: "inherit", fontSize: tokens.fontSizeBase300, cursor: "pointer",
    transitionProperty: "transform, box-shadow, border-color", transitionDuration: "160ms",
    ":hover": { transform: "translateY(-2px)", boxShadow: tokens.shadow8, border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke1}` },
    ":focus-visible": { outline: `${tokens.strokeWidthThick} solid ${tokens.colorStrokeFocus2}` },
    "& svg": { fontSize: "20px", color: tokens.colorBrandForeground1 },
  },
  asked: {
    alignSelf: "flex-end", maxWidth: "85%", padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, overflowWrap: "anywhere",
    borderRadius: `${tokens.borderRadiusXLarge} ${tokens.borderRadiusXLarge} ${tokens.borderRadiusSmall} ${tokens.borderRadiusXLarge}`,
    color: tokens.colorNeutralForegroundOnBrand, backgroundColor: tokens.colorBrandBackground,
  },
  reply: { display: "grid", gridTemplateColumns: "24px minmax(0, 1fr)", columnGap: tokens.spacingHorizontalS, alignItems: "start" },
  replyBody: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, minWidth: 0 },
  answer: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: tokens.lineHeightBase400 },
  dots: { display: "inline-flex", gap: "4px", padding: `${tokens.spacingVerticalS} 0` },
  dot: {
    width: "7px", height: "7px", borderRadius: "50%", backgroundColor: tokens.colorBrandForeground1,
    animationName: "ks-pulse", animationDuration: "1s", animationIterationCount: "infinite",
  },
  card: {
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderLeft: `${tokens.strokeWidthThickest} solid ${tokens.colorBrandStroke1}`,
  },
  facts: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: tokens.spacingHorizontalS, margin: 0 },
  fact: { display: "flex", flexDirection: "column-reverse", minWidth: 0 },
  factValue: { margin: 0, fontWeight: tokens.fontWeightSemibold, overflowWrap: "anywhere" },
  table: {
    width: "100%", borderCollapse: "collapse", fontSize: tokens.fontSizeBase200,
    "& th, & td": { padding: `${tokens.spacingVerticalXXS} 0`, borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke3}` },
    "& thead th": { fontWeight: tokens.fontWeightSemibold, borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}` },
    "& tbody th": { textAlign: "center", fontWeight: tokens.fontWeightRegular, color: tokens.colorNeutralForeground3 },
    "& td:first-child, & thead th:first-child": { textAlign: "left" },
    "& td:last-child, & thead th:last-child": { textAlign: "right" },
    "& td": { fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: "tabular-nums" },
  },
  items: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS },
  item: { display: "grid", gridTemplateColumns: "44px minmax(0, 1fr)", columnGap: tokens.spacingHorizontalS, fontSize: tokens.fontSizeBase200 },
  when: { color: tokens.colorNeutralForeground3, fontVariantNumeric: "tabular-nums" },
  sources: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS },
  source: {
    display: "flex", flexDirection: "column", padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, textDecorationLine: "none",
    color: tokens.colorNeutralForeground1, backgroundColor: tokens.colorNeutralBackground3, transitionProperty: "background-color", transitionDuration: "160ms",
    ":hover": { backgroundColor: tokens.colorNeutralBackground3Hover },
  },
  chips: { display: "flex", flexWrap: "wrap", gap: tokens.spacingHorizontalXS },
  composer: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, padding: tokens.spacingHorizontalL, borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}` },
  box: {
    display: "flex", alignItems: "flex-end", gap: tokens.spacingHorizontalXS, padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusXLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`, backgroundColor: tokens.colorNeutralBackground1,
    transitionProperty: "border-color, box-shadow", transitionDuration: "160ms",
    ":focus-within": { border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke1}`, boxShadow: `0 0 0 2px ${tokens.colorBrandBackground2}` },
  },
  input: {
    flexGrow: 1, minHeight: "40px", maxHeight: "120px", resize: "none", border: "none", outline: "none", backgroundColor: "transparent",
    padding: tokens.spacingVerticalS, color: tokens.colorNeutralForeground1, fontFamily: "inherit", fontSize: tokens.fontSizeBase300,
  },
  row: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS },
  grow: { flexGrow: 1 },
});

function Mark({ small = false }: { small?: boolean }) {
  const styles = useStyles();
  return <span className={mergeClasses(styles.mark, small && styles.small)} aria-hidden><SparkleFilled /></span>;
}

/** One card of an answer: labelled facts, a side-by-side comparison, and a list of moments, whichever it has. */
export function CopilotCardView({ card }: { card: CopilotCard }) {
  const styles = useStyles();
  const accent = card.team ? SIDE_COLOR[card.team] : undefined;
  return (
    <article className={styles.card} data-testid="copilot-card" data-kind={card.kind} style={{ animation: rise(80), borderLeftColor: accent }}>
      <div>
        <Text weight="semibold" block>{card.title}</Text>
        {card.subtitle && <Text size={200} className={styles.muted}>{card.subtitle}</Text>}
      </div>
      {card.compare.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col"><Swatch color={SIDE_COLOR.home} /> {card.home}</th>
              <td />
              <th scope="col">{card.away} <Swatch color={SIDE_COLOR.away} /></th>
            </tr>
          </thead>
          <tbody>
            {card.compare.map((row) => (
              <tr key={row.label}><td>{row.home}</td><th scope="row">{row.label}</th><td>{row.away}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {card.facts.length > 0 && (
        <dl className={styles.facts}>
          {card.facts.map((fact) => (
            <div key={fact.label} className={styles.fact}>
              <dt><Text size={100} className={styles.muted}>{fact.label}</Text></dt>
              <dd className={styles.factValue}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {card.items.length > 0 && (
        <ol className={styles.items}>
          {card.items.map((item, index) => (
            <li key={`${item.when}-${index}`} className={styles.item}>
              <span className={styles.when}>{item.when}</span>
              <span>
                <Text size={200} weight="semibold">{item.team && <Swatch color={SIDE_COLOR[item.team]} />} {item.title}</Text>
                <Text size={200} block className={styles.muted}>{item.detail}</Text>
              </span>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

function Reply({ turn, search, onAsk }: { turn: Turn; search: string; onAsk(question: string): void }) {
  const styles = useStyles();
  const { answer } = turn;
  return (
    <div className={styles.reply} data-testid="copilot-reply" style={{ animation: rise() }}>
      <Mark small />
      <div className={styles.replyBody}>
        {!answer && !turn.failure && (
          <span className={styles.dots} role="status" aria-label="Copilot is answering">
            {[0, 160, 320].map((delay) => <span key={delay} className={styles.dot} style={{ animationDelay: `${delay}ms` }} />)}
          </span>
        )}
        {turn.failure && <Text className={styles.answer} data-testid="copilot-failure">{turn.failure}</Text>}
        {answer && (
          <>
            <Text className={styles.answer} data-testid="copilot-answer">{answer.answer}</Text>
            {answer.problem && <Badge appearance="tint" color="warning">{answer.problem}</Badge>}
            {answer.cards.map((card, index) => <CopilotCardView key={`${card.kind}-${index}`} card={card} />)}
            {answer.sources.length > 0 && (
              <ul className={styles.sources} aria-label="Sources">
                {answer.sources.map((source, index) => (
                  <li key={source.url}>
                    {/* A link out of the studio: opened apart from it, and told nothing about where it came from. */}
                    <a className={styles.source} href={source.url} target="_blank" rel="noopener noreferrer">
                      <Text size={200} weight="semibold">{index + 1}. {source.title}</Text>
                      <Text size={200} className={styles.muted}>{source.snippet}</Text>
                    </a>
                  </li>
                ))}
              </ul>
            )}
            <div className={styles.chips}>
              <Badge appearance="outline" size="small">{answer.source === "agent" ? "Written by a model" : "From the match data"}</Badge>
              {answer.searched && <Badge appearance="outline" size="small" icon={<GlobeRegular />}>Searched {search || "the web"}</Badge>}
            </div>
            <div className={styles.chips} aria-label="Suggested questions">
              {answer.followups.map((followup) => (
                <Button key={followup} size="small" appearance="outline" shape="circular" onClick={() => onAsk(followup)}>{followup}</Button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The pane: the conversation so far, and where the next question is typed. */
export function CopilotPane() {
  const styles = useStyles();
  const { turns, web, setOpen, setWeb, ask, clear } = useCopilot();
  const [draft, setDraft] = useState("");
  const [info, setInfo] = useState<CopilotInfo | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const waiting = turns.some((turn) => !turn.answer && !turn.failure);
  const search = info?.search ?? "";

  useEffect(() => {
    fetchCopilotInfo().then(setInfo).catch(() => setInfo(null));
    input.current?.focus();
  }, []);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const submit = (question: string) => {
    if (question.trim() === "" || waiting) return;
    setDraft("");
    void ask(question);
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit(draft);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <aside className={mergeClasses(styles.pane, "ks-motion")} aria-label="Ask Copilot">
      <MotionStyles />
      <header className={styles.header}>
        <Mark />
        <div className={styles.titles}>
          <Text weight="semibold" size={400}>Ask Copilot</Text>
          <Text size={200} className={styles.muted}>
            {info ? `Answers from the match${info.matches_remembered ? ` and ${info.matches_remembered} on record` : ""}` : "Answers from the match"}
          </Text>
        </div>
        <Tooltip content="New chat" relationship="label">
          <Button appearance="subtle" icon={<ChatAddRegular />} disabled={turns.length === 0} onClick={clear} />
        </Tooltip>
        <Tooltip content="Close" relationship="label">
          <Button appearance="subtle" icon={<DismissRegular />} onClick={() => setOpen(false)} />
        </Tooltip>
      </header>

      <div className={styles.thread} role="log" aria-live="polite" aria-label="Conversation">
        {turns.length === 0 && (
          <div className={styles.welcome} style={{ animation: rise(60) }}>
            <Text size={600} weight="semibold">What would you like to know?</Text>
            <Text className={styles.muted}>Ask about the match, a player's record, the head to head, a play card or the play history.</Text>
            <div className={styles.starters}>
              {STARTERS.map((starter, index) => (
                <button key={starter.text} type="button" className={styles.starter} style={{ animation: rise(90 + index * 50) }} onClick={() => submit(starter.text)}>
                  {starter.icon}
                  {starter.text}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((turn) => (
          <div key={turn.id} style={{ display: "contents" }}>
            <Text className={styles.asked} data-testid="copilot-question" style={{ animation: rise() }}>{turn.question}</Text>
            <Reply turn={turn} search={search} onAsk={submit} />
          </div>
        ))}
        <div ref={end} />
      </div>

      <div className={styles.composer}>
        <div className={styles.box}>
          <textarea ref={input} className={styles.input} rows={1} maxLength={MAX_QUESTION} aria-label="Ask a question" placeholder="Ask about the match…"
            value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKey} />
          <Tooltip content="Send" relationship="label">
            <Button appearance="primary" shape="circular" icon={<SendFilled />} disabled={draft.trim() === "" || waiting} onClick={() => submit(draft)} />
          </Tooltip>
        </div>
        <div className={styles.row}>
          <Switch label="Search the web" checked={web} disabled={info !== null && search === ""} onChange={(_, data) => setWeb(data.checked)} />
          <span className={styles.grow} />
        </div>
        <Text size={100} className={styles.muted}>
          {web && search ? `Your question is sent to ${search}. ` : ""}Answers come from recorded match data; check anything important.
        </Text>
      </div>
    </aside>
  );
}

/** The button that opens Ask Copilot, and the pane while it is open. */
export function AskCopilot() {
  const styles = useStyles();
  const open = useCopilot((state) => state.open);
  const setOpen = useCopilot((state) => state.setOpen);
  return (
    <>
      <Button className={styles.launcher} icon={<SparkleFilled />} aria-expanded={open} onClick={() => setOpen(!open)}>Ask Copilot</Button>
      {open && <CopilotPane />}
    </>
  );
}
