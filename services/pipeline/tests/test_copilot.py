import asyncio
import time
from typing import get_args

import pytest
from fastapi.testclient import TestClient

from kickstream.adapters.agent_copilot import copilot_prompt
from kickstream.adapters.clocks import InstantClock
from kickstream.adapters.web_search import (
    TavilySearch,
    WikipediaSearch,
    plain,
    tavily_results,
    wikipedia_results,
)
from kickstream.agents.registry import AGENT_IDS, DECLARED
from kickstream.app import Settings, create_app
from kickstream.contracts import CopilotAnswer
from kickstream.copilot.answer import HELP, NO_MATCH, players_in, sides_in, topic_of
from kickstream.copilot.mentions import AgentId, Mentions
from kickstream.copilot.view import MAX_REMEMBERED, MatchArchive, MatchView
from kickstream.domain.demo import DEMO_SEED
from kickstream.domain.teams import AWAY, HOME
from kickstream.ports.copilot import SearchFailure, SearchResult, Speaker
from tests.test_agents import MemoryRecord

ASK = "/api/copilot/ask"


def status_view() -> MatchView:
    from kickstream.contracts import MatchStatus

    status = MatchStatus(
        match_id="m-1", state="live", minute=10, score_home=0, score_away=0, speed=30, home=HOME, away=AWAY
    )
    return MatchView("m-1", status=status)


# --- placing a question ------------------------------------------------------------------------


@pytest.mark.parametrize(
    "question, topic",
    [
        ("What is the score?", "match"),
        ("Give me a summary of the game", "match"),
        ("Who will win from here?", "prediction"),
        ("What are the tactics?", "tactics"),
        ("Who is the best player so far?", "player"),
        ("Who scored?", "player"),
        ("Show me the head to head", "head_to_head"),
        ("Northbridge vs Harbour City", "head_to_head"),
        ("Compare Marrowby and Bellweather", "head_to_head"),
        ("Show the last goal's play card", "play"),
        ("Show a hidden highlight", "play"),
        ("Show the play history", "history"),
        ("What were the previous results?", "history"),
        ("What's the weather like?", None),
    ],
)
def test_a_question_is_placed_by_the_words_in_it(question, topic):
    assert topic_of(question) == topic


def test_players_and_sides_are_recognised_by_name():
    view = status_view()
    assert players_in("How is Marrowby doing?", view) == [("home", "nbr-9")]
    assert players_in("compare luca marrowby and Evander Quillfeather", view) == [
        ("home", "nbr-9"),
        ("away", "hbc-9"),
    ]
    assert players_in("What is the score?", view) == []
    assert sides_in("How are Harbour City playing?", view) == ["away"]
    assert sides_in("NBR and the away side", view) == ["home", "away"]
    assert sides_in("anything", MatchView("m-1")) == []


# --- tagging an agent --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "question, agent, rest",
    [
        ("@tactical_analyst what now?", "tactical_analyst", "what now?"),
        ("@tactical-analyst what now?", "tactical_analyst", "what now?"),
        ("@TacticalAnalyst what now?", "tactical_analyst", "what now?"),
        ("@TACTICAL_ANALYST", "tactical_analyst", ""),
        ("@Tactical Analyst what now?", "tactical_analyst", "what now?"),
        ("@tactics pressing?", "tactical_analyst", "pressing?"),
        ("who wins @prediction", "prediction", "who wins"),
        ("@PredictionAgent who wins", "prediction", "who wins"),
        ("@highlights best moment", "highlights", "best moment"),
        ("@player how is Marrowby", "player_tracking", "how is Marrowby"),
        ("@PlayerTrackingAgent Marrowby", "player_tracking", "Marrowby"),
        ("@events latest", "event_interpreter", "latest"),
        ("@event_interpreter latest", "event_interpreter", "latest"),
        ("@explain the odds", "explainability", "the odds"),
        ("@visual where is play", "visualization", "where is play"),
        ("@tactics and @prediction", "tactical_analyst", "and"),
        ("mail a@prediction.com please", None, "mail a@prediction.com please"),
        ("@someone   who   wins", None, "@someone who wins"),
        ("no tag at all", None, "no tag at all"),
    ],
)
def test_an_agent_is_tagged_by_its_id_name_or_a_short_name_and_the_tag_is_taken_out(question, agent, rest):
    assert Mentions(declared.spec(True) for declared in DECLARED).find(question) == (agent, rest)


def test_the_agents_that_can_be_tagged_are_the_registered_agents():
    assert set(get_args(AgentId)) == set(AGENT_IDS)
    # Without the catalog an agent is still tagged by its id or a short name, and named from its id.
    bare = Mentions([])
    assert bare.find("@tactical_analyst now") == ("tactical_analyst", "now")
    assert bare.find("@TacticalAnalyst now") == ("tactical_analyst", "now")
    assert bare.find("@PredictionAgent now") == (None, "@PredictionAgent now")
    assert bare.name("player_tracking") == "Player tracking"


# --- the archive -------------------------------------------------------------------------------


def result(n, home=1, away=0, players=()) -> dict:
    return {
        "match_id": f"m-{n}",
        "played_at": float(n),
        "home": HOME.name,
        "away": AWAY.name,
        "score_home": home,
        "score_away": away,
        "scorers": [],
        "players": list(players),
    }


def test_finished_matches_are_remembered_once_each_and_saved():
    record = MemoryRecord()
    archive = MatchArchive(record)
    archive.remember(result(1))
    archive.remember(result(2, 0, 0))
    archive.remember(result(1, 3, 2))  # the same match again, with its final numbers
    assert [(m["match_id"], m["score_home"]) for m in archive.matches] == [("m-2", 0), ("m-1", 3)]
    assert [m["match_id"] for m in MatchArchive(record).matches] == ["m-2", "m-1"]
    assert [m["match_id"] for m in archive.before("m-2")] == ["m-1"]


def test_only_the_newest_matches_are_kept_and_an_unusable_file_loads_as_nothing():
    archive = MatchArchive()
    for n in range(MAX_REMEMBERED + 5):
        archive.remember(result(n))
    assert len(archive.matches) == MAX_REMEMBERED and archive.matches[0]["match_id"] == "m-5"
    assert MatchArchive(MemoryRecord({"matches": "all of them"})).matches == []
    assert MatchArchive(MemoryRecord({"matches": [{"match_id": 7}, result(1)]})).matches == [result(1)]
    broken = MatchArchive(MemoryRecord(broken=True))
    broken.remember(result(1))  # not saved, but still answered from until the pipeline stops
    assert len(broken.matches) == 1


def test_a_players_record_is_their_totals_over_the_other_matches():
    line = {
        "player_id": "nbr-9",
        "name": "Luca Marrowby",
        "side": "home",
        "goals": 2,
        "shots": 4,
        "rating": 8.0,
    }
    archive = MatchArchive()
    archive.remember(result(1, players=[line]))
    archive.remember(result(2, players=[{**line, "goals": 0, "rating": 6.0}]))
    assert archive.player_record("nbr-9") == {
        "matches": 2,
        "goals": 2,
        "shots": 8,
        "average_rating": 7.0,
        "best_rating": 8.0,
    }
    assert archive.player_record("nbr-9", except_match="m-1")["matches"] == 1
    assert archive.player_record("hbc-1") == {
        "matches": 0,
        "goals": 0,
        "shots": 0,
        "average_rating": None,
        "best_rating": None,
    }


# --- web search --------------------------------------------------------------------------------

WIKIPEDIA = {
    "query": {
        "search": [
            {
                "title": "Offside (association football)",
                "snippet": '<span class="searchmatch">Offside</span> is one of the laws &amp; rules',
            },
            {"snippet": "no title"},
            "not a result",
        ]
    }
}


def test_search_text_is_made_plain():
    assert plain("<b>Bold</b>  &quot;quoted&quot;\n text") == 'Bold "quoted" text'
    assert plain(None) == "" and len(plain("x" * 900)) == 320 and plain("x" * 900).endswith("…")


def test_wikipedia_results_become_titles_links_and_plain_snippets():
    [found] = wikipedia_results(WIKIPEDIA)
    assert found == SearchResult(
        "Offside (association football)",
        "https://en.wikipedia.org/wiki/Offside_%28association_football%29",
        "Offside is one of the laws & rules",
    )
    assert wikipedia_results({}) == [] and wikipedia_results({"query": None}) == []


def test_only_web_links_are_kept_from_a_general_search():
    body = {
        "results": [
            {
                "title": "Laws of the Game",
                "url": "https://example.org/laws",
                "content": "Law 11 is <i>offside</i>.",
            },
            {"title": "Bad link", "url": "javascript:alert(1)", "content": "x"},
            {"url": "https://example.org/untitled", "content": "y"},
        ]
    }
    assert tavily_results(body) == [
        SearchResult("Laws of the Game", "https://example.org/laws", "Law 11 is offside."),
        SearchResult("https://example.org/untitled", "https://example.org/untitled", "y"),
    ]


async def test_each_search_asks_its_service_for_the_question_and_keeps_the_key_out_of_the_address():
    asked = []

    def wikipedia(url, **extra):
        asked.append((url, extra))
        return WIKIPEDIA

    def tavily(url, **extra):
        asked.append((url, extra))
        return {"results": [{"title": "T", "url": "https://t.example", "content": "c"}] * 9}

    assert len(await WikipediaSearch(get=wikipedia).search("offside rule", 3)) == 1
    assert len(await TavilySearch("tvly-secret", post=tavily).search("offside rule", 3)) == 3
    (wiki_url, _), (tavily_url, sent) = asked
    assert wiki_url.startswith("https://en.wikipedia.org/w/api.php?") and "srsearch=offside+rule" in wiki_url
    assert tavily_url == "https://api.tavily.com/search" and sent["body"] == {
        "query": "offside rule",
        "max_results": 3,
    }
    assert sent["headers"] == {"Authorization": "Bearer tvly-secret"}


def test_the_writer_is_given_the_question_the_facts_and_the_web_results_and_nothing_else():
    prompt = copilot_prompt(
        "Who scored?", ["Goals: Marrowby 23'"], [SearchResult("T", "https://t.example", "snip")]
    )
    assert prompt.splitlines() == [
        "Question: Who scored?",
        "Facts from the match and the matches before it:",
        "- Goals: Marrowby 23'",
        "Web results:",
        "- T (https://t.example): snip",
    ]
    assert copilot_prompt("Hi", [], []).splitlines()[-1] == "- none"


def test_the_writer_is_told_which_agent_is_answering():
    speaker = Speaker("Tactical Analyst", "Detects pressure, rhythm, and tactical patterns.")
    lines = copilot_prompt("What now?", ["Pressure: 4-2"], [], speaker).splitlines()
    assert lines[:2] == [
        "Answering as: Tactical Analyst, who detects pressure, rhythm, and tactical patterns.",
        "Question: What now?",
    ]


# --- asking, end to end ------------------------------------------------------------------------


class FakeSearch:
    name = "Wikipedia"

    def __init__(self, results=(), fail: str | None = None) -> None:
        self.results, self.fail, self.asked = list(results), fail, []

    async def search(self, query, limit):
        self.asked.append((query, limit))
        if self.fail:
            raise SearchFailure(self.fail)
        return self.results


class FakeWriter:
    model = "fake-model"

    def __init__(self, text="Worded by the model.", fail=False) -> None:
        self.text, self.fail, self.calls, self.speakers = text, fail, [], []

    async def write(self, question, facts, sources, speaker=None):
        self.calls.append((question, facts, sources))
        self.speakers.append(speaker)
        if self.fail:
            raise RuntimeError("down")
        return self.text


OFFSIDE = SearchResult("Offside", "https://en.wikipedia.org/wiki/Offside", "Offside is one of the laws.")


def make_client(tmp_path, **extra):
    settings = Settings(None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data")
    app = create_app(
        settings,
        clock_factory=lambda speed: InstantClock(),
        match_prefix="m",
        feeds={},
        **{"search": FakeSearch(), **extra},
    )
    return TestClient(app)


def play_match(client, seed=DEMO_SEED) -> str:
    """Plays a whole match and returns once the agents have finished with it and it is in the archive."""
    remembered = client.get("/api/copilot").json()["matches_remembered"]
    match_id = client.post("/api/matches", json={"seed": seed, "speed": 600}).json()["match_id"]
    for _ in range(300):
        body = client.get(f"/api/matches/{match_id}/intelligence").json()
        if body["minute"] >= 90 and body["player"] and body["runs"]:
            break
        time.sleep(0.05)
    for _ in range(100):
        if client.get("/api/copilot").json()["matches_remembered"] > remembered:
            break
        time.sleep(0.05)
    return match_id


def ask(client, question, **extra) -> CopilotAnswer:
    response = client.post(ASK, json={"question": question, **extra})
    assert response.status_code == 200, response.text
    return CopilotAnswer.model_validate(response.json())


@pytest.fixture
def client(tmp_path):
    with make_client(tmp_path) as test_client:
        yield test_client


@pytest.fixture
def played(client):
    play_match(client)
    return client


def test_before_any_match_it_says_so_and_says_what_it_can_do(client):
    answer = ask(client, "hello there")
    assert (
        answer.intent == "help" and "No match has been started yet" in answer.answer and HELP in answer.answer
    )
    assert ask(client, "What is the score?").answer.startswith("No match has been started yet")
    assert ask(client, "Show the head to head").answer == "No finished match is on record yet."
    info = client.get("/api/copilot").json()
    assert info == {"model": False, "search": "Wikipedia", "matches_remembered": 0}


@pytest.mark.parametrize("agent", AGENT_IDS)
def test_before_any_match_a_tagged_agent_says_there_is_no_match(client, agent):
    answer = ask(client, "", agent=agent)
    assert (answer.intent, answer.answer, answer.agent, answer.charts) == ("help", NO_MATCH, agent, [])
    assert answer.question.startswith("What has the ") and answer.question.endswith(" found?")


@pytest.mark.parametrize(
    "body, status",
    [
        ({"question": ""}, 422),
        ({"question": "   "}, 422),
        ({"question": "x" * 301}, 422),
        ({"question": "Hi", "mode": "coach"}, 422),
        ({"question": "Hi", "extra": 1}, 422),
        ({}, 422),
        ({"question": "Hi", "match_id": "m-99"}, 404),
        ({"question": "Hi", "agent": "coach"}, 422),
        ({"question": "Hi", "agent": "Tactical Analyst"}, 422),
        ({"question": "", "agent": None}, 422),
    ],
    ids=[
        "empty",
        "blank",
        "long",
        "mode",
        "extra",
        "missing",
        "unknown match",
        "agent",
        "agent name",
        "no agent",
    ],
)
def test_a_malformed_question_is_refused(client, body, status):
    assert client.post(ASK, json=body).status_code == status


def test_the_match_is_answered_with_its_score_stats_and_scorers(played):
    answer = ask(played, "  What   is the score? ")
    assert answer.question == "What is the score?" and (answer.intent, answer.source) == ("match", "scripted")
    assert answer.answer.startswith("It is Northbridge FC ") and "at full time" in answer.answer
    [card] = answer.cards
    assert (card.kind, card.home, card.away) == ("match", "Northbridge FC", "Harbour City")
    assert [row.label for row in card.compare] == ["Goals", "Pass accuracy %", "Fouls"]
    assert answer.followups and answer.sources == [] and answer.searched is False
    assert answer.agent is None and answer.sample is False
    [chart] = answer.charts
    assert (chart.kind, chart.labels) == (
        "bar",
        ["Possession %", "Shots", "Shots on target", "Expected goals"],
    )
    assert [(s.name, s.team) for s in chart.series] == [("Northbridge FC", "home"), ("Harbour City", "away")]
    assert f"Shots are {chart.series[0].values[1]:g}-{chart.series[1].values[1]:g}" in answer.answer


def test_a_live_feed_match_is_answered_only_with_what_its_source_measured():
    from kickstream.contracts import StatsSnapshot, TeamStats
    from kickstream.copilot.answer import match_answer, pitch_answer, tactics_answer

    view = status_view()
    view.status = view.status.model_copy(update={"detail": "key_events", "score_home": 1})
    zero = dict.fromkeys(
        ("shots", "shots_on_target", "xg", "possession", "passes", "pass_accuracy", "fouls", "red_cards"), 0
    )
    home = TeamStats(goals=1, yellow_cards=0, **zero)
    away = TeamStats(goals=0, yellow_cards=1, **zero)
    view.stats = StatsSnapshot(
        id="m-1-ls1", match_id="m-1", minute=10, home=home, away=away, momentum=0, provided=["goals"]
    )
    match = match_answer(view)
    assert match.answer == "It is Northbridge FC 1-0 Harbour City in minute 10."
    assert match.charts == [] and [row.label for row in match.cards[0].compare] == ["Goals"]
    for answer in (tactics_answer(view), pitch_answer(view)):
        assert answer.answer.startswith("This match comes from a live score feed")
        assert answer.cards == [] and answer.charts == []


def test_each_tagged_agent_answers_from_its_own_part_of_the_match(played):
    def put(agent: str, question: str = "What can you tell me?") -> CopilotAnswer:
        answer = ask(played, question, agent=agent)
        assert answer.agent == agent and answer.question == question
        return answer

    events = put("event_interpreter")
    assert (events.intent, events.cards[0].title) == ("history", "The latest plays")
    assert ":" in events.cards[0].items[0].when
    assert put("event_interpreter", "Bellweather?").cards[0].title == "Ignatius Bellweather's plays"

    tactics = put("tactical_analyst")
    assert (tactics.intent, tactics.cards[0].title) == ("tactics", "Tactics")
    [chart] = tactics.charts
    assert chart.kind == "bar" and chart.labels[0] == "Pressure" and len(chart.series) == 2
    assert tactics.cards[0].compare == [] and len(tactics.cards[0].facts) == 2

    forecast = put("prediction")
    assert forecast.intent == "prediction" and forecast.answer.startswith("The match is over.")

    player = put("player_tracking")
    assert player.intent == "player" and player.answer.startswith("The best player so far is ")
    assert put("player_tracking", "And Bellweather?").cards[0].title == "7. Ignatius Bellweather"

    highlight = put("highlights")
    assert (highlight.intent, highlight.cards[0].kind) == ("play", "play")

    why = put("explainability")
    [card] = why.cards
    assert (why.intent, card.title) == ("explanation", "Why it matters") and card.items
    assert why.answer.startswith("The latest, from minute ")
    assert why.followups

    pitch = put("visualization")
    [chart] = pitch.charts
    assert (pitch.intent, pitch.cards[0].title) == ("pitch", "Where the play is")
    assert (chart.kind, chart.unit, chart.labels) == (
        "bar",
        "%",
        ["Own third", "Middle third", "Attacking third"],
    )
    assert all(abs(sum(series.values) - 100) < 0.5 for series in chart.series)
    assert "% of their plays in the attacking third" in pitch.answer


def test_an_agent_tagged_in_the_question_answers_unless_the_request_names_another(played):
    tagged = ask(played, "@tactics what is happening?")
    assert (tagged.agent, tagged.intent, tagged.question) == (
        "tactical_analyst",
        "tactics",
        "what is happening?",
    )
    only = ask(played, "@TacticalAnalyst")
    assert only.agent == "tactical_analyst" and only.question == "What has the Tactical Analyst found?"
    named = ask(played, "@prediction show me something", agent="highlights")
    assert (named.agent, named.intent, named.question) == ("highlights", "play", "show me something")
    untagged = ask(played, "mail a@prediction.com: what are the tactics?")
    assert untagged.agent is None and untagged.question.startswith("mail a@prediction.com")


def test_an_older_forecasts_explanation_is_dated_so_its_odds_are_not_read_as_current():
    from kickstream.contracts import Explanation, Prediction
    from kickstream.copilot.answer import prediction_answer

    def forecast(minute: int, home: float) -> Prediction:
        return Prediction(
            id=f"m-1-p{minute}",
            match_id="m-1",
            minute=minute,
            win_home=home,
            draw=0.2,
            win_away=0.8 - home,
            next_goal_home=0.1,
            next_goal_away=0.1,
            next_actions=[],
            cols=1,
            rows=1,
            danger=[0],
        )

    def why(minute: int) -> Explanation:
        return Explanation(
            id=f"x{minute}",
            match_id="m-1",
            minute=minute,
            subject_id=f"m-1-p{minute}",
            subject_kind="prediction",
            mode="analyst",
            headline="Odds moved",
            why="The odds swung.",
            evidence=[],
            source="scripted",
            agent="a",
        )

    view = status_view()
    view.prediction, view.explanations = forecast(25, 0.5), {"m-1-p20": why(20)}
    assert prediction_answer(view).answer.endswith(" When the odds last moved, in minute 20: The odds swung.")
    view.explanations["m-1-p25"] = why(25)
    assert prediction_answer(view).answer.endswith("chance of scoring and Harbour City 10%. The odds swung.")


def test_a_forecast_is_given_while_the_match_is_live_and_the_result_once_it_is_over(tmp_path):
    # A match that never ends by itself, so the forecast is asked for while it is live.
    class Frozen:
        def __init__(self) -> None:
            self.left = 400

        async def sleep(self, seconds):
            self.left -= 1
            await asyncio.sleep(0 if self.left > 0 else 3600)

    settings = Settings(None, None, None, cache_dir=tmp_path / "c", data_dir=tmp_path / "d")
    app = create_app(
        settings, clock_factory=lambda speed: Frozen(), match_prefix="m", feeds={}, search=FakeSearch()
    )
    with TestClient(app) as live:
        live.post("/api/matches", json={"speed": 600})
        for _ in range(200):
            answer = ask(live, "Who will win?")
            if answer.cards:
                break
            time.sleep(0.05)
        assert answer.intent == "prediction" and "most likely result" in answer.answer
        [card] = answer.cards
        assert card.title == "Win probability"
        assert [row.label for row in card.compare] == ["Scores in the next 10 minutes"]
        [odds] = answer.charts
        assert (odds.kind, odds.unit, odds.labels) == (
            "donut",
            "%",
            ["Northbridge FC", "Draw", "Harbour City"],
        )
        assert abs(sum(odds.series[0].values) - 100) < 0.5
        tactics = ask(live, "What are the tactics?")
        assert tactics.cards[0].title == "Tactics" and tactics.charts[0].series[1].team == "away"
        head = ask(live, "Show the head to head")
        assert "There is no earlier match between Northbridge FC and Harbour City on record" in head.answer
        assert "Today it is Northbridge FC " in head.answer
    with make_client(tmp_path / "over") as over:
        play_match(over)
        assert ask(over, "Who will win?").answer.startswith("The match is over. It finished Northbridge FC ")


def test_a_player_is_answered_with_this_match_and_their_record(played):
    best = ask(played, "Who is the best player so far?")
    assert best.intent == "player" and best.answer.startswith("The best player so far is ")
    assert best.cards[0].kind == "player" and best.cards[0].facts[0].label == "Rating"

    named = ask(played, "Tell me about Bellweather")
    [card] = named.cards
    assert card.title == "7. Ignatius Bellweather" and card.subtitle.startswith("Harbour City · MF")
    assert "Ignatius Bellweather of Harbour City has a rating of" in named.answer
    assert "no earlier match on record" in named.answer

    scorers = ask(played, "Who scored?")
    assert scorers.answer.startswith("The scorers so far: ") and 1 <= len(scorers.cards) <= 3


def test_after_a_second_match_a_player_has_a_record_and_the_sides_a_head_to_head(played):
    play_match(played, seed=4)
    assert played.get("/api/copilot").json()["matches_remembered"] == 2
    record = ask(played, "Tell me about Bellweather")
    assert "Over 1 earlier match:" in record.answer
    assert "Earlier matches" in [fact.label for fact in record.cards[0].facts]

    head = ask(played, "Show me the head to head")
    assert head.intent == "head_to_head" and head.answer.startswith(
        "In 2 matches on record, Northbridge FC won "
    )
    [card] = head.cards
    assert card.compare[0].label == "Wins on record" and len(card.items) == 2
    wins = int(card.compare[0].home) + int(card.compare[0].away)
    assert wins + int(card.subtitle.split("· ")[1].split()[0]) == 2

    results = ask(played, "What were the previous results?")
    assert results.answer.startswith("2 finished matches are on record.") and len(results.cards[0].items) == 2


def test_with_no_names_the_two_best_players_are_compared(played):
    answer = ask(played, "Compare the two best players")
    [card] = answer.cards
    best = ask(played, "Who is the best player so far?").cards[0].title.split(". ", 1)[1]
    assert card.kind == "head_to_head" and card.home == best and card.away != best
    assert float(card.compare[0].home) >= float(card.compare[0].away)


def test_two_named_players_are_compared_side_by_side(played):
    answer = ask(played, "Compare Bellweather and Marrowby")
    [card] = answer.cards
    assert (answer.intent, card.kind) == ("head_to_head", "head_to_head")
    assert {card.home, card.away} == {"Ignatius Bellweather", "Luca Marrowby"}
    assert [row.label for row in card.compare][:2] == ["Rating", "Touches"]
    assert "has had the better match so far" in answer.answer


def test_a_play_card_tells_one_moment_with_its_build_up(played):
    goal = ask(played, "Show the last goal's play card")
    [card] = goal.cards
    assert (goal.intent, card.kind) == ("play", "play") and card.title.startswith("Goal for ")
    assert (
        goal.answer.split(": ", 1)[1].startswith("Goal for ") and "GOAL!" in goal.answer
    )  # the fan commentary
    assert [fact.label for fact in card.facts][:2] == ["Minute", "Side"]

    analyst = ask(played, "Show the last goal's play card", mode="analyst")
    assert "GOAL!" not in analyst.answer

    hidden = ask(played, "Show a hidden highlight")
    assert any(fact.value.startswith("Hidden event") for fact in hidden.cards[0].facts)


def test_the_play_history_is_the_match_a_players_plays_or_the_latest_plays(played):
    match = ask(played, "Show the play history")
    [card] = match.cards
    assert (match.intent, card.kind, card.title) == ("history", "history", "The match so far")
    assert card.items and card.items == sorted(card.items, key=lambda item: int(item.when.rstrip("'")))

    player = ask(played, "Bellweather play history")
    assert player.cards[0].title == "Ignatius Bellweather's plays" and player.cards[0].team == "away"
    assert "Ignatius Bellweather has made" in player.answer and len(player.cards[0].items) <= 8

    recent = ask(played, "Show the recent plays")
    assert recent.cards[0].title == "The latest plays" and ":" in recent.cards[0].items[0].when


def test_a_question_it_cannot_place_gets_help_unless_the_web_is_searched(tmp_path):
    search = FakeSearch([OFFSIDE])
    with make_client(tmp_path, search=search) as client:
        play_match(client)
        without = ask(client, "What is the offside rule?")
        assert (without.intent, without.answer, without.searched) == (
            "help",
            HELP,
            False,
        ) and search.asked == []

        found = ask(client, "What is the offside rule?", web=True)
        assert (found.intent, found.searched) == ("web", True)
        assert found.answer == "From Wikipedia: Offside is one of the laws."
        assert [(s.title, s.url) for s in found.sources] == [
            ("Offside", "https://en.wikipedia.org/wiki/Offside")
        ]
        assert search.asked == [("What is the offside rule?", 4)]

        # What the match can answer is answered from the match, and the web is left alone.
        placed = ask(client, "What is the score?", web=True)
        assert placed.intent == "match" and placed.sources == [] and placed.searched is False
        assert len(search.asked) == 1


def test_a_search_that_fails_or_finds_nothing_is_said_plainly(tmp_path):
    with make_client(tmp_path / "a", search=FakeSearch(fail="The web could not be reached.")) as client:
        failed = ask(client, "What is the offside rule?", web=True)
        assert (failed.problem, failed.sources, failed.searched) == (
            "The web could not be reached.",
            [],
            True,
        )
    with make_client(tmp_path / "b", search=FakeSearch([])) as client:
        play_match(client)
        empty = ask(client, "What is the offside rule?", web=True)
        assert empty.answer.startswith("The web search found nothing for that.") and empty.problem is None


def test_with_web_search_off_asking_for_it_says_it_is_not_set_up(tmp_path):
    settings = Settings(None, None, None, cache_dir=tmp_path / "c", data_dir=tmp_path / "d", web_search="off")
    with TestClient(create_app(settings, clock_factory=lambda speed: InstantClock(), feeds={})) as client:
        assert client.get("/api/copilot").json()["search"] == ""
        answer = ask(client, "What is the offside rule?", web=True)
        assert (answer.problem, answer.searched) == ("Web search is not set up.", False)
    keyed = Settings.from_env(
        {"KICKSTREAM_TAVILY_API_KEY": "tvly-9f3-secret", "KICKSTREAM_WEB_SEARCH": "off"}
    )
    assert keyed.web_search == "off" and "tvly-9f3-secret" not in repr(keyed)


def test_with_a_model_the_answer_is_worded_from_the_facts_and_a_failure_falls_back(tmp_path):
    writer = FakeWriter()
    with make_client(tmp_path / "a", copilot_writer=writer, search=FakeSearch([OFFSIDE])) as client:
        play_match(client)
        assert client.get("/api/copilot").json()["model"] is True
        answer = ask(client, "What is the score?")
        assert (answer.answer, answer.source) == ("Worded by the model.", "agent") and answer.cards
        question, facts, sources = writer.calls[0]
        assert question == "What is the score?" and facts[0].startswith("Score: Northbridge FC ")
        assert sources == []
        # Nothing to word: the model is not asked.
        assert ask(client, "hello there").source == "scripted" and len(writer.calls) == 1
        # A question for the web is worded from what the search found.
        assert ask(client, "What is the offside rule?", web=True).source == "agent"
        assert writer.calls[1] == ("What is the offside rule?", [], [OFFSIDE])
        assert writer.speakers == [None, None]
        # A question put to an agent is worded as that agent.
        tagged = ask(client, "@tactics what is happening?")
        assert (tagged.source, tagged.agent) == ("agent", "tactical_analyst")
        assert writer.calls[2][0] == "what is happening?" and writer.calls[2][1][0].startswith(
            "Tactical summary"
        )
        assert writer.speakers[2] == Speaker(
            "Tactical Analyst", "Detects pressure, rhythm, and tactical patterns."
        )
    with make_client(tmp_path / "b", copilot_writer=FakeWriter(fail=True)) as client:
        play_match(client)
        fallen = ask(client, "What is the score?")
        assert fallen.source == "scripted" and fallen.answer.startswith("It is Northbridge FC ")
    with make_client(tmp_path / "c", copilot_writer=FakeWriter(text="   ")) as client:
        play_match(client)
        assert ask(client, "What is the score?").source == "scripted"


def test_a_finished_match_is_kept_across_a_restart(tmp_path):
    with make_client(tmp_path) as first:
        play_match(first)
        assert (tmp_path / "data" / "matches.json").exists()
    with make_client(tmp_path) as second:
        assert second.get("/api/copilot").json()["matches_remembered"] == 1
        answer = ask(second, "What were the previous results?")
        assert answer.answer.startswith("1 finished match is on record.")
