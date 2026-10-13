import asyncio
import time

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
from kickstream.app import Settings, create_app
from kickstream.contracts import CopilotAnswer
from kickstream.copilot.answer import HELP, players_in, sides_in, topic_of
from kickstream.copilot.view import MAX_REMEMBERED, MatchArchive, MatchView
from kickstream.domain.demo import DEMO_SEED
from kickstream.domain.teams import AWAY, HOME
from kickstream.ports.copilot import SearchFailure, SearchResult
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
        self.text, self.fail, self.calls = text, fail, []

    async def write(self, question, facts, sources):
        self.calls.append((question, facts, sources))
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
    ],
    ids=["empty", "blank", "long", "mode", "extra", "missing", "unknown match"],
)
def test_a_malformed_question_is_refused(client, body, status):
    assert client.post(ASK, json=body).status_code == status


def test_the_match_is_answered_with_its_score_stats_and_scorers(played):
    answer = ask(played, "  What   is the score? ")
    assert answer.question == "What is the score?" and (answer.intent, answer.source) == ("match", "scripted")
    assert answer.answer.startswith("It is Northbridge FC ") and "at full time" in answer.answer
    [card] = answer.cards
    assert (card.kind, card.home, card.away) == ("match", "Northbridge FC", "Harbour City")
    assert [row.label for row in card.compare][:3] == ["Goals", "Possession %", "Shots"]
    assert answer.followups and answer.sources == [] and answer.searched is False


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
        assert answer.cards[0].title == "Win probability" and answer.cards[0].compare[0].label == "Win"
        assert ask(live, "What are the tactics?").cards[0].title == "Tactics"
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
