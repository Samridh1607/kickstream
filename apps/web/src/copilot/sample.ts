import type { AgentId } from "../agents/api";
import type { CopilotAnswer, CopilotChart } from "../contracts";

/**
 * Sample answers, shown when Ask Copilot cannot be reached so the pane still shows what an answer looks like.
 *
 * Every number here is made up. Each answer says so in its first line and each chart title starts with
 * "Sample", so a sample cannot be read as the match.
 */

export type SampleTopic = "match" | "prediction" | "tactics" | "player" | "highlights";

const BY_AGENT: Record<AgentId, SampleTopic> = {
  event_interpreter: "highlights",
  tactical_analyst: "tactics",
  prediction: "prediction",
  explainability: "match",
  visualization: "tactics",
  player_tracking: "player",
  highlights: "highlights",
};

// The first topic whose words appear in the question wins; anything else is a match summary.
const BY_WORDS: [SampleTopic, RegExp][] = [
  ["prediction", /predict|forecast|odds|probabilit|who (will|is going to) win|who wins|chance|likely/i],
  ["tactics", /tactic|press|tempo|rhythm|shape|formation|pattern|tilt|third|flank/i],
  ["player", /player|scorer|scored|rating|best|touches/i],
  ["highlights", /highlight|goal|moment|replay|play card|save|clip/i],
];

export function sampleTopic(question: string, agent: AgentId | null): SampleTopic {
  if (agent) return BY_AGENT[agent];
  return BY_WORDS.find(([, words]) => words.test(question))?.[0] ?? "match";
}

const NOTICE = "This is an **illustrative sample**, not live data: Ask Copilot could not be reached, so the numbers below are made up to show what an answer looks like.";

const sides = (title: string, labels: string[], home: number[], away: number[], unit: string | null = null): CopilotChart => ({
  kind: "bar", title, unit, labels,
  series: [{ name: "Home", team: "home", values: home }, { name: "Away", team: "away", values: away }],
});

interface Sample {
  intent: CopilotAnswer["intent"];
  answer: string;
  charts: CopilotChart[];
  followups: string[];
}

const SAMPLES: Record<SampleTopic, Sample> = {
  match: {
    intent: "match",
    answer: [
      "### Sample match summary", "", NOTICE, "",
      "- **Score:** Home 2–1 Away in minute 64",
      "- **The ball:** Home have had more of it and moved it quicker",
      "- **Chances:** Home lead on shots and on expected goals", "",
      "| Measure | Home | Away |", "| --- | ---: | ---: |",
      "| Possession % | 56 | 44 |", "| Shots | 11 | 7 |", "| Shots on target | 5 | 3 |", "| Expected goals | 1.6 | 0.9 |",
    ].join("\n"),
    charts: [sides("Sample: the two sides", ["Possession %", "Shots", "Shots on target", "Expected goals"], [56, 11, 5, 1.6], [44, 7, 3, 0.9])],
    followups: ["Who will win from here?", "What are the tactics?", "Who is the best player so far?"],
  },
  prediction: {
    intent: "prediction",
    answer: [
      "### Sample forecast", "", NOTICE, "",
      "- **Most likely:** a home win, at 48%",
      "- **Next ten minutes:** Home 31% to score, Away 22%",
      "- **Trend:** the home side's odds have risen since half-time", "",
      "| Result | Probability |", "| --- | ---: |", "| Home win | 48% |", "| Draw | 27% |", "| Away win | 25% |",
    ].join("\n"),
    charts: [
      { kind: "donut", title: "Sample: win probability", unit: "%", labels: ["Home", "Draw", "Away"], series: [{ name: "Win probability", team: null, values: [48, 27, 25] }] },
      {
        kind: "line", title: "Sample: home win probability", unit: "%", labels: ["0'", "15'", "30'", "45'", "60'", "64'"],
        series: [{ name: "Home win", team: "home", values: [38, 36, 41, 40, 46, 48] }],
      },
    ],
    followups: ["Why have the odds moved?", "What are the tactics?", "What is the score?"],
  },
  tactics: {
    intent: "tactics",
    answer: [
      "### Sample tactical read", "", NOTICE, "",
      "- **Pressure:** Home press high and win the ball in the middle third",
      "- **Tempo:** Away slow the game down with longer moves",
      "- **Width:** most home attacks go down the left flank", "",
      "| Measure | Home | Away |", "| --- | ---: | ---: |",
      "| Pressure | 6.2 | 3.8 |", "| Passes a minute | 9.4 | 7.1 |", "| Field tilt % | 61 | 39 |",
    ].join("\n"),
    charts: [
      sides("Sample: tactics, last ten minutes", ["Pressure", "Passes a minute", "Field tilt %"], [6.2, 9.4, 61], [3.8, 7.1, 39]),
      sides("Sample: share of plays by third", ["Own third", "Middle third", "Attacking third"], [24, 44, 32], [37, 41, 22], "%"),
    ],
    followups: ["Who will win from here?", "Show the play history", "What is the score?"],
  },
  player: {
    intent: "player",
    answer: [
      "### Sample player report", "", NOTICE, "",
      "- **Best rated:** Player A, with a goal and three shots",
      "- **Most involved:** Player B, with 58 touches",
      "- **Defensive work:** Player C has won the ball back six times", "",
      "| Player | Rating | Touches | Goals |", "| --- | ---: | ---: | ---: |",
      "| Player A | 8.1 | 41 | 1 |", "| Player B | 7.6 | 58 | 0 |", "| Player C | 7.2 | 37 | 0 |",
    ].join("\n"),
    charts: [{ kind: "bar", title: "Sample: player ratings", unit: null, labels: ["Player A", "Player B", "Player C"], series: [{ name: "Rating", team: null, values: [8.1, 7.6, 7.2] }] }],
    followups: ["Who scored?", "Compare the two best players", "Show the play history"],
  },
  highlights: {
    intent: "play",
    answer: [
      "### Sample highlights", "", NOTICE, "",
      "- **Best moment:** a long passing move that ended in the opening goal",
      "- **Hidden event:** a ball won high up the pitch that set up a big chance",
      "- **Turning point:** a save from close range just before half-time", "",
      "| Minute | Moment | Score |", "| ---: | --- | ---: |",
      "| 23' | Goal after a 12-pass move | 92 |", "| 38' | Ball won in the attacking third | 74 |", "| 44' | Save from close range | 68 |",
    ].join("\n"),
    charts: [{ kind: "bar", title: "Sample: highlight scores", unit: null, labels: ["23'", "38'", "44'"], series: [{ name: "Score", team: null, values: [92, 74, 68] }] }],
    followups: ["Show the last goal's play card", "Show a hidden highlight", "Show the play history"],
  },
};

/** A clearly labelled sample answer for the question, picked by the agent it was put to or by its words. */
export function sampleAnswer(question: string, agent: AgentId | null): CopilotAnswer {
  const topic = sampleTopic(question, agent);
  const sample = SAMPLES[topic];
  return {
    id: `sample-${topic}`, question, intent: sample.intent, answer: sample.answer, cards: [], charts: sample.charts, sources: [],
    followups: sample.followups, source: "scripted", searched: false, problem: null, agent: null, sample: true,
  };
}
