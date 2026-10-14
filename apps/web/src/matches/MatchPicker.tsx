import {
  Badge, Button, Caption1, Field, makeStyles, MessageBar, MessageBarBody, Radio, RadioGroup, Select, Text, ToggleButton, tokens,
} from "@fluentui/react-components";
import { ArrowClockwiseRegular } from "@fluentui/react-icons";
import { useEffect, useId, useRef, useState } from "react";
import type { Competition, Fixture, MatchListing, SourceInfo, Sources } from "../contracts";
import { type Language, type StringKey, t } from "../i18n";
import {
  fetchCompetitions, fetchFixtures, fetchReplayMatches, fetchSources, type LiveSourceId, localDay, type SourceId, SPEEDS, speedLabel,
  type StartRequest, startMatchFrom,
} from "./api";

const useStyles = makeStyles({
  panel: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  option: { display: "flex", flexDirection: "column" },
  note: { paddingLeft: "32px", color: tokens.colorNeutralForeground3 },
  row: { display: "flex", alignItems: "flex-end", gap: tokens.spacingHorizontalS },
  grow: { flexGrow: 1, minWidth: 0 },
  list: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS },
  item: { width: "100%", justifyContent: "space-between", gap: tokens.spacingHorizontalS, textAlign: "start" },
  itemText: { display: "flex", flexDirection: "column", minWidth: 0 },
  itemSide: { display: "flex", alignItems: "center", gap: tokens.spacingHorizontalS, flexShrink: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
});

export const sourceName = (language: Language, id: SourceId) => t(language, `source_${id}` as const);

const pad = (value: number) => String(value).padStart(2, "0");

function fixtureState(language: Language, fixture: Fixture): string {
  switch (fixture.state) {
    case "pre_match": {
      const at = new Date(fixture.kickoff_at * 1000);
      return `${t(language, "notStarted")} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
    }
    case "live":
      return fixture.minute === null || fixture.minute === undefined ? t(language, "live") : `${t(language, "live")} ${fixture.minute}'`;
    case "half_time":
      return t(language, "stateHalfTime");
    case "finished":
      return t(language, "stateFullTime");
    case "postponed":
      return t(language, "postponed");
  }
}

/** What to read under a source: how to make it available, its budget, or how far to trust it. */
function sourceNote(language: Language, source: SourceInfo): string | null {
  if (!source.available) return source.setup ?? null;
  if (source.id === "api_football" && source.budget_limit !== null && source.budget_limit !== undefined) {
    return t(language, "requestsUsed").replace("{used}", String(source.budget_used ?? 0)).replace("{limit}", String(source.budget_limit));
  }
  if (source.id === "openligadb") return t(language, "openLigaDbNote");
  return null;
}

interface MatchPickerProps {
  /** Called with the new match's id once the server has started it. */
  onStarted(matchId: string): void;
  /** One more speed to offer, e.g. 600× from `?speed=` for the end-to-end run. */
  extraSpeed?: number;
  /** The language of the page the picker is on. */
  language?: Language;
  /** The sources as the caller already reads them; read once here when not given. */
  sources?: Sources | null;
}

/** Chooses a match from any source (simulated, a StatsBomb replay or a live fixture) and starts it. */
export function MatchPicker({ onStarted, extraSpeed, language = "en", sources: given }: MatchPickerProps) {
  const styles = useStyles();
  const say = (key: StringKey) => t(language, key);
  const noteId = useId();
  const reads = given === undefined;
  const [read, setRead] = useState<Sources | null>(null);
  const sources = reads ? read : given;
  const [source, setSource] = useState<SourceId>("simulated");
  const [chosenSpeed, setChosenSpeed] = useState({ simulated: 30, statsbomb: 1 });
  const paced = source === "simulated" ? "simulated" : "statsbomb";
  const speed = chosenSpeed[paced];
  const setSpeed = (value: number) => setChosenSpeed((current) => ({ ...current, [paced]: value }));
  const [competitions, setCompetitions] = useState<Competition[] | null>(null);
  const [competition, setCompetition] = useState("");
  const [replays, setReplays] = useState<MatchListing[] | null>(null);
  const [replay, setReplay] = useState<string | null>(null);
  const [fixtures, setFixtures] = useState<{ source: LiveSourceId; list: Fixture[] } | null>(null);
  const [filter, setFilter] = useState("");
  const [fixture, setFixture] = useState<{ source: LiveSourceId; ref: string } | null>(null);
  const [loading, setLoading] = useState<StringKey | null>(null);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Only the latest list asked for is shown, so switching sources quickly never shows another source's list.
  const latest = useRef(0);

  const fail = (caught: unknown) => setProblem(caught instanceof Error ? caught.message : say("requestFailed"));

  useEffect(() => {
    if (!reads) return;
    fetchSources().then(setRead, fail);
  }, [reads]);

  async function load<T>(key: StringKey, request: () => Promise<T>, apply: (value: T) => void) {
    const token = ++latest.current;
    setLoading(key);
    setProblem(null);
    try {
      const value = await request();
      if (token === latest.current) apply(value);
    } catch (caught) {
      if (token === latest.current) fail(caught);
    } finally {
      if (token === latest.current) setLoading(null);
    }
  }

  const loadFixtures = (live: LiveSourceId) =>
    load("loadingFixtures", () => fetchFixtures(live, localDay()), (list) => {
      if (fixtures?.source !== live) setFilter("");
      setFixtures({ source: live, list });
    });

  const choose = (next: SourceId) => {
    setSource(next);
    if (next === "statsbomb" && competitions === null) void load("loadingCompetitions", fetchCompetitions, setCompetitions);
    if ((next === "api_football" || next === "openligadb") && fixtures?.source !== next) void loadFixtures(next);
  };

  const chooseCompetition = (value: string) => {
    setCompetition(value);
    setReplay(null);
    setReplays(null);
    const [competitionId, seasonId] = value.split("/").map(Number);
    void load("loadingMatches", () => fetchReplayMatches(competitionId, seasonId), setReplays);
  };

  const available = sources?.sources.some((item) => item.id === source && item.available) ?? false;
  const request: StartRequest | null = !available
    ? null
    : source === "simulated"
      ? { source, speed }
      : source === "statsbomb"
        ? replay === null ? null : { source, ref: replay, speed }
        : fixture?.source === source ? { source, ref: fixture.ref, speed: 1 } : null;

  const start = async () => {
    if (request === null) return;
    setStarting(true);
    setProblem(null);
    try {
      onStarted(await startMatchFrom(request));
    } catch (caught) {
      fail(caught);
    } finally {
      setStarting(false);
    }
  };

  const speeds = [...new Set<number>(extraSpeed === undefined ? SPEEDS : [...SPEEDS, extraSpeed])].sort((a, b) => a - b);
  const speedField = (
    <Field label={say("speed")}>
      <Select value={String(speed)} onChange={(_, data) => setSpeed(Number(data.value))}>
        {speeds.map((item) => <option key={item} value={item}>{item === 1 ? say("realTime") : speedLabel(item)}</option>)}
      </Select>
    </Field>
  );
  const waiting = (key: StringKey) => loading === key && <Text>{say(key)}</Text>;

  const replayChoice = (
    <>
      {competitions === null ? waiting("loadingCompetitions") : (
        <Field label={say("competition")}>
          <Select value={competition} onChange={(_, data) => chooseCompetition(data.value)}>
            <option value="" disabled>{say("chooseCompetition")}</option>
            {competitions.map((item) => (
              <option key={`${item.competition_id}/${item.season_id}`} value={`${item.competition_id}/${item.season_id}`}>
                {`${item.competition_name} · ${item.season_name}`}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {waiting("loadingMatches")}
      {replays !== null && (replays.length === 0 ? <Text>{say("noReplayMatches")}</Text> : (
        <div role="list" aria-label={say("replayMatches")} className={styles.list}>
          {replays.map((item) => (
            <div role="listitem" key={item.ref}>
              <ToggleButton className={styles.item} checked={replay === item.ref} aria-label={`${item.home} vs ${item.away}`}
                onClick={() => setReplay(item.ref)}>
                <span className={styles.itemText}>
                  <Text weight="semibold">{`${item.home} vs ${item.away}`}</Text>
                  <Caption1 className={styles.muted}>{[item.date, item.stage].filter(Boolean).join(" · ")}</Caption1>
                </span>
              </ToggleButton>
            </div>
          ))}
        </div>
      ))}
      {speedField}
    </>
  );

  const live = source === "api_football" || source === "openligadb" ? source : null;
  const today = live !== null && fixtures?.source === live ? fixtures.list : null;
  const liveChoice = live !== null && (
    <>
      <div className={styles.row}>
        <Field label={say("competition")} className={styles.grow}>
          <Select value={filter} onChange={(_, data) => setFilter(data.value)}>
            <option value="">{say("allCompetitions")}</option>
            {[...new Set(today?.map((item) => item.competition))].map((name) => <option key={name} value={name}>{name}</option>)}
          </Select>
        </Field>
        <Button icon={<ArrowClockwiseRegular />} disabled={loading === "loadingFixtures"} onClick={() => void loadFixtures(live)}>
          {say("refresh")}
        </Button>
      </div>
      {waiting("loadingFixtures")}
      {today !== null && (today.length === 0 ? <Text>{say("noFixtures")}</Text> : (
        <div role="list" aria-label={say("fixtures")} className={styles.list}>
          {today.filter((item) => filter === "" || item.competition === filter).map((item) => {
            const scored = item.score_home !== null && item.score_home !== undefined && item.score_away !== null && item.score_away !== undefined;
            return (
              <div role="listitem" key={item.ref}>
                <ToggleButton className={styles.item} checked={fixture?.source === live && fixture.ref === item.ref}
                  disabled={item.state === "postponed"} aria-label={`${item.home} vs ${item.away}`}
                  onClick={() => setFixture({ source: live, ref: item.ref })}>
                  <span className={styles.itemText}>
                    <Text weight="semibold">{`${item.home} vs ${item.away}`}</Text>
                    <Caption1 className={styles.muted}>{item.competition}</Caption1>
                  </span>
                  <span className={styles.itemSide}>
                    {scored && <Text weight="semibold">{`${item.score_home} - ${item.score_away}`}</Text>}
                    <Badge appearance={item.state === "live" ? "filled" : "tint"} color={item.state === "live" ? "danger" : "informative"}>
                      {fixtureState(language, item)}
                    </Badge>
                  </span>
                </ToggleButton>
              </div>
            );
          })}
        </div>
      ))}
    </>
  );

  return (
    <div className={styles.panel}>
      {sources === null ? <Text>{say("loadingSources")}</Text> : (
        <Field label={say("source")}>
          <RadioGroup value={source} onChange={(_, data) => choose(data.value as SourceId)}>
            {sources.sources.map((item) => {
              const note = sourceNote(language, item);
              return (
                <div key={item.id} className={styles.option}>
                  <Radio value={item.id} label={sourceName(language, item.id)} disabled={!item.available}
                    aria-describedby={note === null ? undefined : `${noteId}-${item.id}`} />
                  {note !== null && <Caption1 id={`${noteId}-${item.id}`} className={styles.note}>{note}</Caption1>}
                </div>
              );
            })}
          </RadioGroup>
        </Field>
      )}
      {source === "simulated" && speedField}
      {source === "statsbomb" && replayChoice}
      {liveChoice}
      {problem && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>{problem}</MessageBarBody>
        </MessageBar>
      )}
      <Button appearance="primary" disabled={request === null || starting} onClick={() => void start()}>
        {starting ? say("starting") : say("start")}
      </Button>
    </div>
  );
}
