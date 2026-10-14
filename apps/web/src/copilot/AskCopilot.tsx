import { Badge, Button, makeStyles, mergeClasses, MessageBar, MessageBarBody, Switch, Text, tokens, Tooltip } from "@fluentui/react-components";
import {
  ArrowSwapRegular, BotRegular, ChatAddRegular, DataTrendingRegular, DismissRegular, FlashRegular, GlobeRegular, HistoryRegular, MentionRegular,
  NumberSymbolRegular, PersonRunningRegular, SendFilled, SparkleFilled,
} from "@fluentui/react-icons";
import { type ChangeEvent, type KeyboardEvent, type ReactElement, useEffect, useId, useRef, useState } from "react";
import { create } from "zustand";
import { type AgentId, fetchAgents } from "../agents/api";
import { Swatch } from "../charts/charts";
import type { CopilotAnswer, CopilotCard, CopilotInfo } from "../contracts";
import { EASE, MotionStyles, rise } from "../motion/motion";
import { StudioRequestError } from "../studio/api";
import { AGENT_OPTIONS, type AgentOption, agentName, matchAgents } from "./agents";
import { askCopilot, fetchCopilotInfo } from "./api";
import { CopilotChartView } from "./Chart";
import { CopilotMarkdown } from "./Markdown";
import { sampleAnswer } from "./sample";

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
  /** The agent the question was put to, if any. */
  agent: AgentId | null;
  /** Absent while the answer is on its way. A sample answer when the request failed. */
  answer?: CopilotAnswer;
  /** Why Ask Copilot could not be reached, when the request failed. */
  failure?: string;
}

interface CopilotState {
  open: boolean;
  turns: Turn[];
  web: boolean;
  setOpen(open: boolean): void;
  setWeb(web: boolean): void;
  ask(question: string, agent?: AgentId | null): Promise<void>;
  clear(): void;
}

let nextTurn = 1;

function reasonOf(caught: unknown): string {
  if (caught instanceof StudioRequestError) return caught.message;
  if (caught instanceof SyntaxError) return "the reply was not valid JSON.";
  if (caught instanceof TypeError) return "the network request failed.";
  return caught instanceof Error && caught.message ? caught.message : "the request failed.";
}

/** The conversation, kept while the page is open so closing the pane does not lose it. */
export const useCopilot = create<CopilotState>((set, get) => ({
  open: false,
  turns: [],
  web: false,
  setOpen: (open) => set({ open }),
  setWeb: (web) => set({ web }),
  clear: () => set({ turns: [] }),
  ask: async (asked, agent = null) => {
    const question = asked.trim();
    if ((question === "" && agent === null) || get().turns.some((turn) => !turn.answer && !turn.failure)) return;
    const id = nextTurn++;
    set((state) => ({ turns: [...state.turns, { id, question, agent }] }));
    const settle = (result: Partial<Turn>) =>
      set((state) => ({ turns: state.turns.map((turn) => (turn.id === id ? { ...turn, ...result } : turn)) }));
    try {
      settle({ answer: await askCopilot(question, { web: get().web, agent }) });
    } catch (caught) {
      settle({ answer: sampleAnswer(question, agent), failure: reasonOf(caught) });
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
  askedTo: { alignSelf: "flex-end", marginBottom: `calc(-1 * ${tokens.spacingVerticalS})` },
  reply: { display: "grid", gridTemplateColumns: "24px minmax(0, 1fr)", columnGap: tokens.spacingHorizontalS, alignItems: "start" },
  replyBody: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, minWidth: 0 },
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
  composer: {
    position: "relative", display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, padding: tokens.spacingHorizontalL,
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  picker: {
    position: "absolute", left: tokens.spacingHorizontalL, right: tokens.spacingHorizontalL, bottom: "100%", zIndex: 1, maxHeight: "300px", overflowY: "auto",
    display: "flex", flexDirection: "column", gap: "2px", padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`, boxShadow: tokens.shadow16,
  },
  option: {
    display: "flex", flexDirection: "column", padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`, borderRadius: tokens.borderRadiusMedium, cursor: "pointer",
    ":hover": { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  active: { backgroundColor: tokens.colorSubtleBackgroundSelected, ":hover": { backgroundColor: tokens.colorSubtleBackgroundSelected } },
  none: { padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`, color: tokens.colorNeutralForeground3 },
  chip: {
    alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: tokens.spacingHorizontalXXS, paddingLeft: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusCircular, backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground2,
    fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold,
  },
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

function Reply({ turn, search, agents, onAsk }: { turn: Turn; search: string; agents: AgentOption[]; onAsk(question: string): void }) {
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
        {turn.failure && (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <strong>Sample answer</strong> — Ask Copilot could not be reached: <span data-testid="copilot-failure">{turn.failure}</span>
            </MessageBarBody>
          </MessageBar>
        )}
        {answer && (
          <>
            <CopilotMarkdown text={answer.answer} testId="copilot-answer" />
            {answer.problem && <Badge appearance="tint" color="warning">{answer.problem}</Badge>}
            {(answer.charts ?? []).map((chart, index) => <CopilotChartView key={`${chart.title}-${index}`} chart={chart} />)}
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
              {answer.sample
                ? <Badge appearance="filled" color="warning" size="small">Sample — not live data</Badge>
                : <Badge appearance="outline" size="small">{answer.source === "agent" ? "Written by a model" : "From the match data"}</Badge>}
              {answer.agent && <Badge appearance="tint" color="brand" size="small" icon={<BotRegular />}>Answered by {agentName(agents, answer.agent)}</Badge>}
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

/** The mention picker, while open: what was typed after the @ and where that @ is, if it was typed. */
interface Picker {
  query: string;
  /** Where the typed @ is in the draft; null when the picker was opened with the button. */
  at: number | null;
  active: number;
}

// An @ being typed: at the start or after a space, followed by what has been typed of a name so far.
const TYPING_TAG = /(^|\s)@([\w-]*)$/;

/** The pane: the conversation so far, and where the next question is typed. */
export function CopilotPane() {
  const styles = useStyles();
  const { turns, web, setOpen, setWeb, ask, clear } = useCopilot();
  const [draft, setDraft] = useState("");
  const [info, setInfo] = useState<CopilotInfo | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>(AGENT_OPTIONS);
  const [agent, setAgent] = useState<AgentId | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const waiting = turns.some((turn) => !turn.answer && !turn.failure);
  const search = info?.search ?? "";
  const options = picker ? matchAgents(agents, picker.query) : [];
  const active = picker && options.length > 0 ? Math.min(picker.active, options.length - 1) : -1;

  useEffect(() => {
    fetchCopilotInfo().then(setInfo).catch(() => setInfo(null));
    fetchAgents()
      .then((catalog) => {
        if (catalog.agents.length > 0) setAgents(catalog.agents.map(({ id, name, description }) => ({ id, name, description })));
      })
      .catch(() => undefined);
    input.current?.focus();
  }, []);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const submit = (question: string) => {
    if ((question.trim() === "" && agent === null) || waiting) return;
    setDraft("");
    setAgent(null);
    setPicker(null);
    void ask(question, agent);
  };
  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const { value } = event.target;
    setDraft(value);
    const caret = event.target.selectionStart ?? value.length;
    const typed = TYPING_TAG.exec(value.slice(0, caret));
    setPicker(typed ? { query: typed[2], at: caret - typed[2].length - 1, active: 0 } : null);
  };
  const pick = (option: AgentOption) => {
    if (picker?.at != null) {
      const before = draft.slice(0, picker.at);
      const after = draft.slice(picker.at + 1 + picker.query.length);
      setDraft(before === "" || before.endsWith(" ") ? before + after.trimStart() : before + after);
    }
    setAgent(option.id);
    setPicker(null);
    input.current?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (picker) {
      const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };
      if (event.key === "Escape") {
        event.preventDefault();
        setPicker(null);
        return;
      }
      if (options.length > 0 && event.key in moves) {
        event.preventDefault();
        setPicker({ ...picker, active: (active + moves[event.key] + options.length) % options.length });
        return;
      }
      if (options.length > 0 && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
        event.preventDefault();
        pick(options[active]);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit(draft);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };
  const optionId = (index: number) => `${listId}-${index}`;

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
            <Text className={styles.muted}>
              Ask about the match, a player's record, the head to head, a play card or the play history, or type @ to put a question to one of the agents.
            </Text>
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
            {turn.agent && (
              <Text size={200} className={mergeClasses(styles.muted, styles.askedTo)} data-testid="copilot-asked-agent">
                Asked @{agentName(agents, turn.agent)}
              </Text>
            )}
            <Text className={styles.asked} data-testid="copilot-question" style={{ animation: rise() }}>
              {turn.question || (turn.agent && `@${agentName(agents, turn.agent)}`)}
            </Text>
            <Reply turn={turn} search={search} agents={agents} onAsk={submit} />
          </div>
        ))}
        <div ref={end} />
      </div>

      <div className={styles.composer}>
        {picker && (
          <div className={styles.picker} id={listId} role="listbox" aria-label="Agents">
            {options.map((option, index) => (
              // Pressing an option keeps the focus in the question box, so typing carries on.
              <div key={option.id} id={optionId(index)} role="option" aria-selected={index === active}
                className={mergeClasses(styles.option, index === active && styles.active)}
                onMouseDown={(event) => event.preventDefault()} onClick={() => pick(option)}>
                <Text weight="semibold" size={300}>{option.name}</Text>
                <Text size={200} className={styles.muted}>{option.description}</Text>
              </div>
            ))}
            {options.length === 0 && <Text size={200} className={styles.none}>No agent matches “{picker.query}”</Text>}
          </div>
        )}
        {agent && (
          <span className={styles.chip} data-testid="copilot-tagged">
            @{agentName(agents, agent)}
            <Button size="small" appearance="transparent" shape="circular" icon={<DismissRegular />} aria-label={`Remove ${agentName(agents, agent)}`}
              onClick={() => { setAgent(null); input.current?.focus(); }} />
          </span>
        )}
        <div className={styles.box}>
          <textarea ref={input} className={styles.input} rows={1} maxLength={MAX_QUESTION} aria-label="Ask a question"
            placeholder={agent ? `Ask the ${agentName(agents, agent)}…` : "Ask about the match, or type @ to tag an agent…"}
            aria-controls={picker ? listId : undefined} aria-activedescendant={active >= 0 ? optionId(active) : undefined} aria-autocomplete="list"
            value={draft} onChange={onChange} onKeyDown={onKey} />
          <Tooltip content="Send" relationship="label">
            <Button appearance="primary" shape="circular" icon={<SendFilled />} disabled={(draft.trim() === "" && agent === null) || waiting} onClick={() => submit(draft)} />
          </Tooltip>
        </div>
        <div className={styles.row}>
          <Switch label="Search the web" checked={web} disabled={info !== null && search === ""} onChange={(_, data) => setWeb(data.checked)} />
          <span className={styles.grow} />
          <Button size="small" appearance="subtle" icon={<MentionRegular />} aria-haspopup="listbox" aria-expanded={picker !== null}
            onClick={() => { setPicker(picker ? null : { query: "", at: null, active: 0 }); input.current?.focus(); }}>
            Tag an agent
          </Button>
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
