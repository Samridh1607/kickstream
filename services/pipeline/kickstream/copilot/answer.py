"""Works out what a question is about and answers it from the match and the matches before it.

Every answer here is assembled from recorded numbers and events; nothing is guessed. A question this
module cannot place is answered with what it can help with, or from the web when that was asked for.
"""

import re
from dataclasses import dataclass, field

from kickstream.contracts import (
    CopilotCard,
    CopilotChart,
    CopilotCompare,
    CopilotFact,
    CopilotItem,
    CopilotSeries,
    Highlight,
    PlayerMetrics,
    PlayEvent,
)
from kickstream.copilot.mentions import AgentId
from kickstream.copilot.view import MatchArchive, MatchView
from kickstream.domain.types import SIDES, Side

MAX_ITEMS = 8
_WORD = re.compile(r"[^\W_]+", re.UNICODE)

# What a question is about, by the words in it. The first topic with a match wins, so the more
# particular ones come first: "head to head" before "match", "last goal" before "goals".
_TOPICS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "head_to_head",
        (
            "head to head",
            "head-to-head",
            "h2h",
            " vs ",
            " vs.",
            "versus",
            "compare",
            "comparison",
            "against each other",
            "previous meetings",
            "meetings",
        ),
    ),
    (
        "history",
        (
            "history",
            "timeline",
            "what happened",
            "recent plays",
            "last plays",
            "play by play",
            "events",
            "past matches",
            "previous matches",
            "previous results",
            "last matches",
            "results",
        ),
    ),
    (
        "play",
        (
            "play card",
            "playcard",
            "last goal",
            "latest goal",
            "that goal",
            "best moment",
            "best highlight",
            "top highlight",
            "highlight",
            "hidden",
            "replay",
            "big chance",
            "red card",
            "save",
            "last play",
            "last move",
            "turnover",
        ),
    ),
    (
        "prediction",
        (
            "who will win",
            "who wins",
            "who's going to win",
            "predict",
            "forecast",
            "odds",
            "win probability",
            "chance of",
            "chances",
            "next goal",
            "likely",
        ),
    ),
    (
        "tactics",
        (
            "tactic",
            "pressure",
            "pressing",
            "press",
            "rhythm",
            "tempo",
            "field tilt",
            "pattern",
            "shape",
            "style",
            "counter",
            "build-up",
            "build up",
        ),
    ),
    (
        "player",
        (
            "player record",
            "player card",
            "top scorer",
            "scorer",
            "best player",
            "player of the match",
            "man of the match",
            "rating",
            "ratings",
            "who scored",
            "touches",
            "record of",
            "how is",
            "how has",
            "stats for",
        ),
    ),
    (
        "match",
        (
            "score",
            "minute",
            "stat",
            "possession",
            "shots",
            "xg",
            "expected goals",
            "summary",
            "summarise",
            "summarize",
            "recap",
            "who is winning",
            "who's winning",
            "the match",
            "the game",
            "how is the match",
        ),
    ),
)

FOLLOWUPS = {
    "match": ("Who will win from here?", "Show me the head to head", "Who is the best player so far?"),
    "prediction": ("Why have the odds moved?", "What are the tactics?", "Show the play history"),
    "tactics": ("Who will win from here?", "Show the last goal's play card", "Compare the two sides"),
    "player": ("Compare the two best players", "Who scored?", "Show the play history"),
    "head_to_head": (
        "Show the previous results",
        "Who will win from here?",
        "Who is the best player so far?",
    ),
    "play": ("Show the play history", "Show a hidden highlight", "Who scored?"),
    "history": ("Show the last goal's play card", "Show the head to head", "What are the tactics?"),
    "explanation": ("Why have the odds moved?", "What are the tactics?", "Show a hidden highlight"),
    "pitch": ("What are the tactics?", "Who will win from here?", "Show the recent plays"),
    "web": ("What is the score?", "Show the head to head", "Who is the best player so far?"),
    "help": (
        "What is the score?",
        "Show the head to head",
        "Who is the best player so far?",
        "Show the play history",
    ),
}

HELP = (
    "I can answer from this match and the ones played before it: the score and stats, who is likely to "
    "win, the tactics, a player's numbers and record, the head to head, a play card for a goal or "
    "highlight, and the play history. Turn on web search for anything beyond these matches."
)
NO_MATCH = (
    "No match has been started yet, so there is nothing to answer from. Start one on the Match data page."
)


@dataclass
class Draft:
    intent: str
    answer: str
    cards: list[CopilotCard] = field(default_factory=list)
    # Every fact the answer rests on, for a model that words it. Nothing else may be stated.
    facts: list[str] = field(default_factory=list)
    # False when the question could not be placed, so the web's answer should lead if there is one.
    placed: bool = True
    charts: list[CopilotChart] = field(default_factory=list)


def _words(text: str) -> list[str]:
    return [word.lower() for word in _WORD.findall(text)]


def topic_of(question: str) -> str | None:
    padded = f" {' '.join(question.lower().split())} "
    return next((topic for topic, phrases in _TOPICS if any(phrase in padded for phrase in phrases)), None)


def players_in(question: str, view: MatchView) -> list[tuple[Side, str]]:
    """The players a question names, by full name, surname, or shirt number with the side."""
    words = _words(question)
    joined = " ".join(words)
    found: list[tuple[Side, str]] = []
    for side, player in view.sheet_players():
        parts = _words(player.name)
        surname = parts[-1] if parts else ""
        named = " ".join(parts) in joined or (len(surname) >= 4 and surname in words)
        if named and (side, player.id) not in found:
            found.append((side, player.id))
    return found


def sides_in(question: str, view: MatchView) -> list[Side]:
    if view.status is None:
        return []
    joined = f" {' '.join(_words(question))} "
    found = []
    for side in SIDES:
        sheet = getattr(view.status, side)
        names = (" ".join(_words(sheet.name)), sheet.short_name.lower(), _words(sheet.name)[0], side)
        if any(f" {name} " in joined for name in names if name):
            found.append(side)
    return found


def _count(number: int, one: str, many: str) -> str:
    return f"{number} {one if number == 1 else many}"


def _percent(value: float) -> str:
    return f"{value * 100:.0f}%"


def _fact(label: str, value) -> CopilotFact:
    return CopilotFact(label=label, value=str(value))


def _sides_chart(
    view: MatchView, title: str, rows: list[tuple[str, float, float]], unit: str | None = None
) -> CopilotChart:
    """Bars for each measure, the home side's value beside the away side's."""
    return CopilotChart(
        kind="bar",
        title=title,
        unit=unit,
        labels=[label for label, _, _ in rows],
        series=[
            CopilotSeries(name=view.name(side), team=side, values=[row[index] for row in rows])
            for index, side in ((1, "home"), (2, "away"))
        ],
    )


def _score_line(view: MatchView) -> str:
    status = view.status
    return f"{status.home.name} {status.score_home}-{status.score_away} {status.away.name}"


def _state(view: MatchView) -> str:
    return {
        "live": f"in minute {view.minute}",
        "half_time": "at half-time",
        "finished": "at full time",
        "abandoned": "when it was abandoned",
    }[view.status.state]


# --- the match ---------------------------------------------------------------------------------


def _compare_rows(view: MatchView) -> list[CopilotCompare]:
    stats = view.stats
    if stats is None:
        return []
    rows = [
        ("Goals", stats.home.goals, stats.away.goals),
        ("Possession %", stats.home.possession, stats.away.possession),
        ("Shots", stats.home.shots, stats.away.shots),
        ("Shots on target", stats.home.shots_on_target, stats.away.shots_on_target),
        ("Expected goals", stats.home.xg, stats.away.xg),
        ("Pass accuracy %", stats.home.pass_accuracy, stats.away.pass_accuracy),
        ("Fouls", stats.home.fouls, stats.away.fouls),
    ]
    return [CopilotCompare(label=label, home=f"{home:g}", away=f"{away:g}") for label, home, away in rows]


def match_answer(view: MatchView) -> Draft:
    line = _score_line(view)
    answer = f"It is {line} {_state(view)}."
    stats = view.stats
    facts = [f"Score: {line} ({_state(view)})"]
    if stats is not None:
        answer += (
            f" Shots are {stats.home.shots}-{stats.away.shots}, possession "
            f"{stats.home.possession:g}%-{stats.away.possession:g}% and expected goals "
            f"{stats.home.xg:g}-{stats.away.xg:g}."
        )
        facts += [
            f"{row.label}: {row.home}-{row.away} ({view.name('home')} first)" for row in _compare_rows(view)
        ]
    goals = [play for play in view.plays if play.type == "goal"]
    if goals:
        scorers = ", ".join(f"{view.player_name(g.player_id) or 'unknown'} {g.minute}'" for g in goals)
        answer += f" Goals: {scorers}."
        facts.append(f"Goals: {scorers}")
    charts = []
    if stats is not None:
        rows = [
            ("Possession %", stats.home.possession, stats.away.possession),
            ("Shots", stats.home.shots, stats.away.shots),
            ("Shots on target", stats.home.shots_on_target, stats.away.shots_on_target),
            ("Expected goals", stats.home.xg, stats.away.xg),
        ]
        charts.append(_sides_chart(view, "The two sides", rows))
    charted = {label for chart in charts for label in chart.labels}
    card = CopilotCard(
        kind="match",
        title=line,
        subtitle=_state(view).capitalize(),
        home=view.name("home"),
        away=view.name("away"),
        facts=[],
        compare=[row for row in _compare_rows(view) if row.label not in charted],
        items=[],
    )
    return Draft("match", answer, [card], facts, charts=charts)


def prediction_answer(view: MatchView) -> Draft:
    prediction = view.prediction
    if view.status is not None and view.status.state == "finished":
        line = _score_line(view)
        return Draft("prediction", f"The match is over. It finished {line}.", facts=[f"Final score: {line}"])
    if prediction is None:
        return Draft(
            "prediction", "The Prediction Agent has not forecast this match yet. Ask again in a minute."
        )
    home, away = view.name("home"), view.name("away")
    odds = {home: prediction.win_home, "a draw": prediction.draw, away: prediction.win_away}
    favourite = max(odds, key=odds.get)
    answer = (
        f"The Prediction Agent makes {favourite} the most likely result at {_percent(odds[favourite])}: "
        f"{home} {_percent(prediction.win_home)}, draw {_percent(prediction.draw)}, {away} "
        f"{_percent(prediction.win_away)}. In the next ten minutes {home} have a "
        f"{_percent(prediction.next_goal_home)} chance of scoring and {away} {_percent(prediction.next_goal_away)}."
    )
    facts = [
        f"Win probability: {home} {_percent(prediction.win_home)}, draw {_percent(prediction.draw)}, {away} {_percent(prediction.win_away)}",
        f"Chance to score in the next ten minutes: {home} {_percent(prediction.next_goal_home)}, {away} {_percent(prediction.next_goal_away)}",
    ]
    explained = view.explanations.get(prediction.id) or next(
        (e for e in reversed(list(view.explanations.values())) if e.subject_kind == "prediction"), None
    )
    if explained is not None:
        # An older forecast's explanation quotes older odds, so it is dated rather than read as current.
        current = explained.subject_id == prediction.id
        answer += (
            f" {explained.why}"
            if current
            else f" When the odds last moved, in minute {explained.minute}: {explained.why}"
        )
        facts.append(f"Why the odds moved ({explained.minute}'): {explained.why}")
    card = CopilotCard(
        kind="match",
        title="Win probability",
        subtitle=f"Forecast at {prediction.minute}'",
        home=home,
        away=away,
        facts=[],
        compare=[
            CopilotCompare(
                label="Scores in the next 10 minutes",
                home=_percent(prediction.next_goal_home),
                away=_percent(prediction.next_goal_away),
            ),
        ],
        items=[],
    )
    odds_chart = CopilotChart(
        kind="donut",
        title="Win probability",
        unit="%",
        labels=[home, "Draw", away],
        series=[
            CopilotSeries(
                name="Win probability",
                values=[
                    round(p * 100, 1) for p in (prediction.win_home, prediction.draw, prediction.win_away)
                ],
            )
        ],
    )
    return Draft("prediction", answer, [card], facts, charts=[odds_chart])


def tactics_answer(view: MatchView) -> Draft:
    tactics = view.tactics
    if tactics is None:
        return Draft(
            "tactics", "The Tactical Analyst has not reported on this match yet. Ask again in a minute."
        )
    home, away = view.name("home"), view.name("away")
    rows = [
        ("Pressure", tactics.home.pressure, tactics.away.pressure),
        ("Passes a minute", tactics.home.tempo, tactics.away.tempo),
        ("Field tilt %", tactics.home.field_tilt, tactics.away.field_tilt),
        ("Touches per move", tactics.home.avg_sequence, tactics.away.avg_sequence),
    ]

    def patterns(side: Side) -> str:
        found = getattr(tactics, side).patterns
        return ", ".join(pattern.replace("_", " ") for pattern in found) or "no pattern yet"

    card = CopilotCard(
        kind="match",
        title="Tactics",
        subtitle=f"Last ten minutes, at {tactics.minute}' · rhythm {tactics.rhythm}",
        home=home,
        away=away,
        facts=[_fact(f"{home} patterns", patterns("home")), _fact(f"{away} patterns", patterns("away"))],
        compare=[],
        items=[],
    )
    facts = [f"Tactical summary: {tactics.summary}"]
    facts += [f"{label}: {h:g}-{a:g} ({home} first)" for label, h, a in rows]
    facts += [f"{view.name(side)} patterns: {patterns(side)}" for side in SIDES]
    chart = _sides_chart(view, f"Tactics at {tactics.minute}'", rows)
    return Draft("tactics", tactics.summary, [card], facts, charts=[chart])


# --- players -----------------------------------------------------------------------------------


def _player_card(
    view: MatchView, line: PlayerMetrics, archive: MatchArchive
) -> tuple[CopilotCard, list[str]]:
    record = archive.player_record(line.player_id, except_match=view.match_id)
    facts = [
        _fact("Rating", f"{line.rating:.1f}"),
        _fact("Touches", line.touches),
        _fact("Passes", f"{line.passes} ({line.pass_accuracy:.0f}% accurate)"),
        _fact("Shots", f"{line.shots} ({line.shots_on_target} on target)"),
        _fact("Goals", line.goals),
        _fact("Expected goals", f"{line.xg:.2f}"),
        _fact("Fouls", line.fouls),
        _fact("Cards", f"{line.yellow_cards} yellow, {line.red_cards} red"),
    ]
    if record["matches"]:
        facts += [
            _fact("Earlier matches", record["matches"]),
            _fact("Goals in them", record["goals"]),
            _fact("Average rating", record["average_rating"]),
        ]
    card = CopilotCard(
        kind="player",
        title=f"{line.number}. {line.name}",
        subtitle=f"{view.name(line.team)} · {line.position}{'' if line.on_pitch else ' · off the pitch'}",
        team=line.team,
        facts=facts,
        compare=[],
        items=[],
    )
    told = [
        f"{line.name} ({view.name(line.team)}, {line.position}): "
        + ", ".join(f"{f.label} {f.value}" for f in facts)
    ]
    return card, told


def _sentence(view: MatchView, line: PlayerMetrics, archive: MatchArchive) -> str:
    text = (
        f"{line.name} of {view.name(line.team)} has a rating of {line.rating:.1f}: {line.touches} touches, "
        f"{line.pass_accuracy:.0f}% passing, {line.shots} shots and {line.goals} goals in this match."
    )
    record = archive.player_record(line.player_id, except_match=view.match_id)
    if record["matches"]:
        text += (
            f" Over {_count(record['matches'], 'earlier match', 'earlier matches')}: "
            f"{_count(record['goals'], 'goal', 'goals')} and an average rating of {record['average_rating']}."
        )
    else:
        text += " There is no earlier match on record for this player."
    return text


def player_answer(
    view: MatchView, archive: MatchArchive, named: list[tuple[Side, str]], question: str
) -> Draft:
    if not view.players:
        return Draft(
            "player", "The Player Tracking Agent has not reported on this match yet. Ask again in a minute."
        )
    asked = question.lower()
    if not named and ("scorer" in asked or "who scored" in asked):
        scorers = sorted((line for line in view.players if line.goals > 0), key=lambda line: -line.goals)
        if not scorers:
            return Draft("player", "No one has scored in this match yet.", facts=["No goals yet"])
        lines = scorers[:3]
        names = ", ".join(f"{line.name} ({line.goals})" for line in scorers)
        answer = f"The scorers so far: {names}."
    elif named:
        lines = [line for _, player_id in named[:3] if (line := view.line(player_id)) is not None]
        if not lines:
            return Draft("player", "That player has not been involved in this match yet.")
        answer = " ".join(_sentence(view, line, archive) for line in lines)
    else:
        best = max(view.players, key=lambda line: (line.rating, line.touches))
        lines = [best]
        answer = f"The best player so far is {best.name}. {_sentence(view, best, archive)}"
    cards, facts = [], []
    for line in lines:
        card, told = _player_card(view, line, archive)
        cards.append(card)
        facts += told
    return Draft("player", answer, cards, facts)


# --- head to head ------------------------------------------------------------------------------


def _result_item(match: dict) -> CopilotItem:
    scorers = ", ".join(f"{s.get('name', '?')} {s.get('minute', '?')}'" for s in match.get("scorers", []))
    lead = (
        "home"
        if match["score_home"] > match["score_away"]
        else "away"
        if match["score_away"] > match["score_home"]
        else None
    )
    return CopilotItem(
        when="Full time",
        title=f"{match['home']} {match['score_home']}-{match['score_away']} {match['away']}",
        detail=scorers or "No goals",
        team=lead,
    )


def _meetings(view: MatchView, archive: MatchArchive) -> tuple[list[dict], dict[str, int]]:
    earlier = archive.before(view.match_id if view.status and view.status.state != "finished" else None)
    home = view.name("home")
    tally = {"home": 0, "draw": 0, "away": 0}
    for match in earlier:
        # A remembered match may have had the sides the other way round.
        ours = match["score_home"] if match["home"] == home else match["score_away"]
        theirs = match["score_away"] if match["home"] == home else match["score_home"]
        tally["home" if ours > theirs else "away" if theirs > ours else "draw"] += 1
    return earlier, tally


def head_to_head_answer(
    view: MatchView, archive: MatchArchive, named: list[tuple[Side, str]], question: str = ""
) -> Draft:
    if len(named) < 2 and "player" in question.lower() and len(view.players) >= 2:
        # "Compare the two best players": no names given, so the two highest rated.
        best = sorted(view.players, key=lambda line: (-line.rating, -line.touches))[:2]
        named = [(line.team, line.player_id) for line in best]
    if len(named) >= 2 and view.players:
        first, second = (view.line(player_id) for _, player_id in named[:2])
        if first is not None and second is not None:
            rows = [
                ("Rating", f"{first.rating:.1f}", f"{second.rating:.1f}"),
                ("Touches", first.touches, second.touches),
                ("Pass accuracy %", f"{first.pass_accuracy:.0f}", f"{second.pass_accuracy:.0f}"),
                ("Shots", first.shots, second.shots),
                ("Goals", first.goals, second.goals),
                ("Expected goals", f"{first.xg:.2f}", f"{second.xg:.2f}"),
                ("Fouls", first.fouls, second.fouls),
            ]
            ahead = first if (first.rating, first.touches) >= (second.rating, second.touches) else second
            card = CopilotCard(
                kind="head_to_head",
                title=f"{first.name} and {second.name}",
                subtitle="This match",
                home=first.name,
                away=second.name,
                facts=[],
                compare=[CopilotCompare(label=label, home=str(a), away=str(b)) for label, a, b in rows],
                items=[],
            )
            answer = (
                f"{ahead.name} has had the better match so far: a rating of {first.rating:.1f} for {first.name} "
                f"against {second.rating:.1f} for {second.name}."
            )
            facts = [f"{label}: {first.name} {a}, {second.name} {b}" for label, a, b in rows]
            return Draft("head_to_head", answer, [card], facts)

    home, away = view.name("home"), view.name("away")
    earlier, tally = _meetings(view, archive)
    if earlier:
        answer = (
            f"In {_count(len(earlier), 'match', 'matches')} on record, {home} won "
            f"{tally['home']}, {away} won {tally['away']} and {tally['draw']} were drawn."
        )
    else:
        answer = f"There is no earlier match between {home} and {away} on record: this is the first Kickstream has seen."
    facts = [answer]
    if view.status is not None and view.status.state != "finished":
        answer += f" Today it is {_score_line(view)} {_state(view)}."
        facts.append(f"Today: {_score_line(view)} ({_state(view)})")
    compare = [
        CopilotCompare(label="Wins on record", home=str(tally["home"]), away=str(tally["away"])),
        *_compare_rows(view),
    ]
    card = CopilotCard(
        kind="head_to_head",
        title=f"{home} and {away}",
        subtitle=f"{len(earlier)} on record · {tally['draw']} drawn",
        home=home,
        away=away,
        facts=[],
        compare=compare[:10],
        items=[_result_item(match) for match in reversed(earlier[-5:])],
    )
    facts += [f"{row.label}: {row.home}-{row.away} ({home} first)" for row in compare]
    return Draft("head_to_head", answer, [card], facts)


# --- play cards and history --------------------------------------------------------------------

_WANTED = (
    (("hidden",), lambda h: h.kind == "hidden"),
    (("goal",), lambda h: h.category == "goal"),
    (("red card",), lambda h: h.category == "red_card"),
    (("chance",), lambda h: h.category == "big_chance"),
    (("save",), lambda h: h.category == "big_save"),
    (("turnover", "won the ball"), lambda h: h.category == "dangerous_turnover"),
    (("move", "passing"), lambda h: h.category == "long_sequence"),
    (("foul",), lambda h: h.category == "tactical_foul"),
)


def _pick_highlight(view: MatchView, question: str) -> Highlight | None:
    asked = question.lower()
    pool = view.highlights
    for phrases, wanted in _WANTED:
        if any(phrase in asked for phrase in phrases):
            pool = [highlight for highlight in pool if wanted(highlight)]
            break
    if not pool:
        return None
    if any(word in asked for word in ("last", "latest", "recent", "that")):
        return pool[-1]
    return max(pool, key=lambda highlight: (highlight.score, highlight.minute))


def play_answer(view: MatchView, question: str) -> Draft:
    highlight = _pick_highlight(view, question)
    if highlight is None:
        return Draft("play", "There is no play like that in this match yet.", facts=["No matching highlight"])
    narrative = view.narratives.get(highlight.moment_id or "")
    explanation = view.explanations.get(highlight.id)
    told = narrative.text if narrative else explanation.why if explanation else highlight.reason
    player = view.player_name(highlight.player_id)
    facts = [
        _fact("Minute", f"{highlight.minute}'"),
        _fact("Side", view.name(highlight.team)),
        _fact(
            "Kind",
            ("Hidden event" if highlight.kind == "hidden" else "Key moment")
            + f": {highlight.category.replace('_', ' ')}",
        ),
        _fact("Highlight score", f"{highlight.score:.0f} out of 100"),
        _fact("Why it was chosen", highlight.reason),
    ]
    if player:
        facts.insert(2, _fact("Player", player))
    wanted = set(highlight.event_ids)
    build_up = [play for play in view.plays if play.event_id in wanted][-MAX_ITEMS:]
    card = CopilotCard(
        kind="play",
        title=highlight.title,
        subtitle=f"{highlight.minute}' · {view.name(highlight.team)}",
        team=highlight.team,
        facts=facts,
        compare=[],
        items=[_play_item(view, play) for play in build_up],
    )
    answer = f"{highlight.minute}': {highlight.title}. {told}"
    return Draft("play", answer, [card], [f"{f.label}: {f.value}" for f in facts] + [f"Commentary: {told}"])


def _play_item(view: MatchView, play: PlayEvent) -> CopilotItem:
    who = view.player_name(play.player_id)
    where = f"{play.zone.replace('_', ' ')}, {play.lane}"
    outcome = f", {play.outcome.replace('_', ' ')}" if play.outcome else ""
    return CopilotItem(
        when=f"{play.minute}:{play.second:02d}",
        title=f"{play.type.replace('_', ' ').capitalize()}{f' by {who}' if who else ''}{outcome}",
        detail=f"{where} · {play.phase.replace('_', ' ')}",
        team=play.team,
    )


def history_answer(
    view: MatchView | None, archive: MatchArchive, named: list[tuple[Side, str]], question: str
) -> Draft:
    asked = question.lower()
    past = any(
        phrase in asked for phrase in ("past match", "previous", "last match", "results", "earlier match")
    )
    if view is None or view.status is None or past:
        earlier = archive.before(None)
        if not earlier:
            return Draft("history", "No finished match is on record yet.", facts=["No finished matches"])
        card = CopilotCard(
            kind="history",
            title="Results on record",
            subtitle=f"{len(earlier)} finished {'match' if len(earlier) == 1 else 'matches'}",
            facts=[],
            compare=[],
            items=[_result_item(match) for match in reversed(earlier[-MAX_ITEMS:])],
        )
        latest = earlier[-1]
        answer = (
            f"{len(earlier)} finished {'match is' if len(earlier) == 1 else 'matches are'} on record. The latest "
            f"ended {latest['home']} {latest['score_home']}-{latest['score_away']} {latest['away']}."
        )
        return Draft("history", answer, [card], [f"{item.title} ({item.detail})" for item in card.items])

    if named:
        side, player_id = named[0]
        name = view.player_name(player_id) or "That player"
        plays = [play for play in view.plays if play.player_id == player_id]
        if not plays:
            return Draft("history", f"{name} has not been on the ball in this match yet.")
        card = CopilotCard(
            kind="history",
            title=f"{name}'s plays",
            subtitle=f"{len(plays)} in this match · the latest {min(len(plays), MAX_ITEMS)}",
            team=side,
            facts=[],
            compare=[],
            items=[_play_item(view, play) for play in reversed(plays[-MAX_ITEMS:])],
        )
        kinds = {kind: sum(play.type == kind for play in plays) for kind in ("pass", "shot", "goal", "foul")}
        answer = (
            f"{name} has made {len(plays)} plays: {kinds['pass']} passes, {kinds['shot']} shots, "
            f"{kinds['goal']} goals and {kinds['foul']} fouls. The latest was a {plays[-1].type.replace('_', ' ')} "
            f"in minute {plays[-1].minute}."
        )
        return Draft("history", answer, [card], [answer])

    if any(word in asked for word in ("recent", "last plays", "play by play", "events", "moves")):
        return latest_plays_answer(view)
    key = sorted(view.highlights, key=lambda highlight: highlight.minute)
    key = [highlight for highlight in key if highlight.kind == "key"] or key
    items = [
        CopilotItem(when=f"{h.minute}'", title=h.title, detail=h.reason, team=h.team)
        for h in key[-MAX_ITEMS:]
    ]
    answer = (
        f"{_score_line(view)} {_state(view)}, with {len(key)} key moments so far."
        if items
        else f"{_score_line(view)} {_state(view)}. Nothing has stood out yet."
    )
    return _history_draft(view, "The match so far", answer, items)


def _history_draft(view: MatchView, title: str, answer: str, items: list[CopilotItem]) -> Draft:
    card = CopilotCard(
        kind="history", title=title, subtitle=_score_line(view), facts=[], compare=[], items=items
    )
    return Draft("history", answer, [card], [f"{item.when} {item.title}: {item.detail}" for item in items])


def latest_plays_answer(view: MatchView) -> Draft:
    plays = [play for play in view.plays if play.team is not None][-MAX_ITEMS:]
    if not plays:
        return Draft("history", "No play has been recorded in this match yet.", facts=["No plays yet"])
    items = [_play_item(view, play) for play in reversed(plays)]
    answer = f"Here are the last {len(items)} plays, newest first."
    return _history_draft(view, "The latest plays", answer, items)


# --- explanations and where play is ------------------------------------------------------------


def explanations_answer(view: MatchView) -> Draft:
    explained = sorted(view.explanations.values(), key=lambda explanation: explanation.minute)[-MAX_ITEMS:]
    if not explained:
        return Draft(
            "explanation",
            "The Explainability Agent has not explained anything in this match yet. Ask again in a minute.",
        )
    latest = explained[-1]
    items = [
        CopilotItem(when=f"{e.minute}'", title=e.headline, detail=e.why, team=e.team)
        for e in reversed(explained)
    ]
    card = CopilotCard(
        kind="history",
        title="Why it matters",
        subtitle=f"The latest {_count(len(items), 'explanation', 'explanations')}",
        facts=[],
        compare=[],
        items=items,
    )
    answer = f"The latest, from minute {latest.minute}: {latest.headline}. {latest.why}"
    facts = [f"{e.minute}' ({e.subject_kind}) {e.headline}: {e.why}" for e in explained]
    return Draft("explanation", answer, [card], facts)


_THIRDS = (
    ("defensive_third", "Own third"),
    ("middle_third", "Middle third"),
    ("attacking_third", "Attacking third"),
)
_LANES = (("left", "Left flank"), ("centre", "Centre"), ("right", "Right flank"))


def _shares(plays: list[PlayEvent], attribute: str, places: tuple[tuple[str, str], ...]) -> list[float]:
    total = len(plays) or 1
    return [
        round(100 * sum(getattr(play, attribute) == place for play in plays) / total, 1)
        for place, _ in places
    ]


def pitch_answer(view: MatchView) -> Draft:
    """Where each side has had the ball, by third and by flank, as each side attacks."""
    by_side = {side: [play for play in view.plays if play.team == side] for side in SIDES}
    if not any(by_side.values()):
        return Draft("pitch", "No play has been recorded in this match yet.", facts=["No plays yet"])
    thirds = {side: _shares(plays, "zone", _THIRDS) for side, plays in by_side.items()}
    lanes = {side: _shares(plays, "lane", _LANES) for side, plays in by_side.items()}
    rows = [(label, thirds["home"][i], thirds["away"][i]) for i, (_, label) in enumerate(_THIRDS)]
    rows += [(label, lanes["home"][i], lanes["away"][i]) for i, (_, label) in enumerate(_LANES)]
    home, away = view.name("home"), view.name("away")
    attacking = len(_THIRDS) - 1
    answer = (
        f"{home} have made {thirds['home'][attacking]:g}% of their plays in the attacking third and "
        f"{away} {thirds['away'][attacking]:g}%."
    )
    for side in SIDES:
        busiest = max(range(len(_LANES)), key=lambda i, side=side: lanes[side][i])
        answer += f" {view.name(side)} use the {_LANES[busiest][1].lower()} most ({lanes[side][busiest]:g}%)."
    card = CopilotCard(
        kind="match",
        title="Where the play is",
        subtitle="Share of each side's plays, as it attacks",
        home=home,
        away=away,
        facts=[_fact(f"{view.name(side)} plays", len(plays)) for side, plays in by_side.items()],
        compare=[CopilotCompare(label=label, home=f"{h:g}%", away=f"{a:g}%") for label, h, a in rows],
        items=[],
    )
    facts = [f"{label}: {home} {h:g}%, {away} {a:g}% of their own plays" for label, h, a in rows]
    chart = _sides_chart(view, "Share of plays by third", rows[: len(_THIRDS)], unit="%")
    return Draft("pitch", answer, [card], facts, charts=[chart])


# --- putting it together -----------------------------------------------------------------------


def agent_draft(agent: AgentId, question: str, view: MatchView | None, archive: MatchArchive) -> Draft:
    """The answer from one agent's part of the match, for a question put to that agent."""
    if view is None or view.status is None:
        return Draft("help", NO_MATCH)
    named = players_in(question, view)
    if agent == "event_interpreter":
        if named or topic_of(question) == "history":
            return history_answer(view, archive, named, question)
        return latest_plays_answer(view)
    if agent == "tactical_analyst":
        return tactics_answer(view)
    if agent == "prediction":
        return prediction_answer(view)
    if agent == "player_tracking":
        return player_answer(view, archive, named, question)
    if agent == "highlights":
        return play_answer(view, question)
    if agent == "explainability":
        return explanations_answer(view)
    if agent == "visualization":
        return pitch_answer(view)
    raise ValueError(f"no answer for the agent {agent!r}")


def draft(question: str, view: MatchView | None, archive: MatchArchive) -> Draft:
    """The answer from the match and the archive, or a pointer to what can be asked."""
    topic = topic_of(question)
    if view is None or view.status is None:
        if topic in ("head_to_head", "history") or (
            topic is None and archive.matches and "match" in question.lower()
        ):
            return history_answer(None, archive, [], question)
        return Draft("help", NO_MATCH if topic else f"{NO_MATCH} {HELP}", placed=topic is not None)

    named = players_in(question, view)
    if topic is None and named:
        topic = "player"
    if topic == "head_to_head":
        return head_to_head_answer(view, archive, named, question)
    if topic == "history":
        return history_answer(view, archive, named, question)
    if topic == "play":
        return play_answer(view, question)
    if topic == "prediction":
        return prediction_answer(view)
    if topic == "tactics":
        return tactics_answer(view)
    if topic == "player":
        return player_answer(view, archive, named, question)
    if topic == "match" or sides_in(question, view):
        return match_answer(view)
    return Draft("help", HELP, placed=False)
