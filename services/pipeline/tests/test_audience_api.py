import time

import pytest
from fastapi.testclient import TestClient

from kickstream.adapters.clocks import InstantClock
from kickstream.app import Settings, create_app

ANN = {"x-voter": "voter-ann-0000001"}
BEN = {"x-voter": "voter-ben-0000002"}
BASE = "/api/studio/audience"


class FakeNow:
    def __init__(self):
        self.at = 5_000.0

    def __call__(self):
        return self.at


class FakeExpert:
    def __init__(self):
        self.asked = []

    async def answer(self, question, ctx, language):
        self.asked.append((question, ctx, language))
        return "Fresh legs for the press."


def make_app(tmp_path, now, expert=None):
    settings = Settings(None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data")
    return create_app(
        settings, clock_factory=lambda speed: InstantClock(), match_prefix="m", now=now, expert=expert
    )


@pytest.fixture
def now():
    return FakeNow()


@pytest.fixture
def client(tmp_path, now):
    with TestClient(make_app(tmp_path, now)) as test_client:
        yield test_client


def field(response):
    return response.json()["detail"][0]["loc"][-1]


def open_poll(client, **body):
    return client.post(
        f"{BASE}/poll", json={"question": "Who will win?", "options": ["Home", "Draw", "Away"], **body}
    ).json()["poll"]


def ask(client, headers=ANN, text="Why the change?", nickname="Ann"):
    return client.post("/api/audience/questions", headers=headers, json={"text": text, "nickname": nickname})


# --- polls -----------------------------------------------------------------------------------


def test_fans_see_a_new_poll_vote_once_and_can_change_their_vote(client, now):
    assert client.get("/api/audience").json()["poll"] is None
    poll = open_poll(client, duration_s=60)
    assert (poll["state"], poll["closes_at"]) == ("open", now.at + 60)
    home, _, away = (o["id"] for o in poll["options"])

    voted = client.post("/api/audience/poll/vote", headers=ANN, json={"option_id": home})
    assert voted.status_code == 200 and [o["votes"] for o in voted.json()["poll"]["options"]] == [1, 0, 0]
    client.post("/api/audience/poll/vote", headers=ANN, json={"option_id": home})
    client.post("/api/audience/poll/vote", headers=BEN, json={"option_id": home})
    moved = client.post("/api/audience/poll/vote", headers=ANN, json={"option_id": away}).json()
    assert [o["votes"] for o in moved["poll"]["options"]] == [1, 0, 1]
    assert "poll_votes" not in moved, "who voted for what never leaves the server"


def test_vote_refusals(client):
    assert (lambda r: (r.status_code, field(r)))(
        client.post("/api/audience/poll/vote", headers=ANN, json={"option_id": "x"})
    ) == (409, "poll")
    poll = open_poll(client)
    option = poll["options"][0]["id"]
    for headers in ({}, {"x-voter": "short"}, {"x-voter": "has spaces in the id!"}):
        refused = client.post("/api/audience/poll/vote", headers=headers, json={"option_id": option})
        assert (refused.status_code, field(refused)) == (422, "voter")
    assert (
        field(client.post("/api/audience/poll/vote", headers=ANN, json={"option_id": "from-another-poll"}))
        == "option"
    )
    client.post(f"{BASE}/poll/close")
    closed = client.post("/api/audience/poll/vote", headers=ANN, json={"option_id": option})
    assert (closed.status_code, field(closed)) == (409, "poll")
    assert client.get("/api/audience").json()["poll"]["options"][0]["votes"] == 0


def test_the_streamer_closes_shows_and_restores_polls(client):
    first = open_poll(client)
    assert client.put(f"{BASE}/poll/on-air", json={"on": True}).json()["poll_on_air"] is True
    assert client.get("/api/audience").json()["poll_on_air"] is True
    assert client.post(f"{BASE}/poll/close").json()["poll"]["state"] == "closed"
    assert client.post(f"{BASE}/poll/close").status_code == 409
    second = client.post(f"{BASE}/poll", json={"question": "Next goal?", "options": ["A", "B"]}).json()
    assert second["poll_on_air"] is False and [p["id"] for p in second["history"]] == [first["id"]]
    restored = client.post(f"{BASE}/history/{first['id']}/restore").json()
    assert (restored["poll"]["id"], restored["poll"]["state"]) == (first["id"], "closed")
    assert client.post(f"{BASE}/history/nope/restore").status_code == 404


def test_a_timed_poll_closes_by_itself(client, now):
    open_poll(client, duration_s=30)
    now.at += 31
    client.put(f"{BASE}/poll/on-air", json={"on": True})  # any change wakes the deadline loop
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and client.get("/api/audience").json()["poll"]["state"] != "closed":
        time.sleep(0.05)
    assert client.get("/api/audience").json()["poll"]["state"] == "closed"


@pytest.mark.parametrize(
    "body, name",
    [
        ({"question": "", "options": ["A", "B"]}, "question"),
        ({"question": "Q?", "options": ["A"]}, "options"),
        ({"question": "Q?", "options": ["A", "A"]}, "options"),
        ({"question": "Q?", "options": ["A", "B"], "duration_s": 5}, "duration_s"),
        ({"options": ["A", "B"]}, "question"),
        ({"preset": "coin_toss"}, "preset"),
    ],
)
def test_poll_requests_outside_the_limits_are_refused(client, body, name):
    refused = client.post(f"{BASE}/poll", json=body)
    assert (refused.status_code, field(refused)) == (422, name)
    assert client.get("/api/audience").json()["poll"] is None


def _play_a_match(client):
    match_id = client.post("/api/matches", json={"speed": 600}).json()["match_id"]
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        title = (
            client.get(f"/api/matches/{match_id}/overlays/latest")
            .json()
            .get("recap_card", {})
            .get("data", {})
            .get("title", "")
        )
        if title.startswith("Full-time"):
            return match_id
        time.sleep(0.1)
    raise AssertionError("the match did not finish")


def test_presets_need_a_match_and_use_its_teams(client):
    refused = client.post(f"{BASE}/poll", json={"preset": "winner"})
    assert (refused.status_code, field(refused)) == (409, "preset")
    _play_a_match(client)
    poll = client.post(f"{BASE}/poll", json={"preset": "winner", "duration_s": 60}).json()["poll"]
    assert (poll["question"], [o["text"] for o in poll["options"]]) == (
        "Who will win?",
        ["Northbridge FC", "Draw", "Harbour City"],
    )
    client.put(
        "/api/studio/settings", json={**client.get("/api/studio").json()["settings"], "language": "es"}
    )
    spanish = client.post(f"{BASE}/poll", json={"preset": "next_goal"}).json()["poll"]
    assert spanish["options"][2]["text"] == "No habrá más goles"


# --- questions -------------------------------------------------------------------------------


def test_fans_ask_and_upvote_and_the_list_is_ordered_by_votes(client, now):
    first = ask(client)
    assert first.status_code == 201
    first_id = first.json()["id"]
    assert first.json()["audience"]["questions"][0] == {
        "id": first_id,
        "text": "Why the change?",
        "nickname": "Ann",
        "votes": 1,
        "state": "open",
        "answer": None,
        "asked_at": now.at,
    }
    second_id = ask(client, BEN, "Who is pressing?", "").json()["id"]
    assert client.get("/api/audience").json()["questions"][1]["nickname"] == "Fan"

    assert (
        client.post(f"/api/audience/questions/{second_id}/vote", headers=ANN).json()["questions"][0]["id"]
        == second_id
    )
    assert (
        client.post(f"/api/audience/questions/{second_id}/vote", headers=BEN).json()["questions"][0]["votes"]
        == 2
    ), "own question"
    assert (
        client.post(f"/api/audience/questions/{second_id}/vote", headers=ANN).json()["questions"][0]["id"]
        == first_id
    )


def test_question_refusals_carry_the_right_status_and_a_wait_time(client, now):
    for body, name in (
        ({"text": "   "}, "text"),
        ({"text": "x" * 201}, "text"),
        ({"text": "ok?", "nickname": "x" * 25}, "nickname"),
    ):
        refused = client.post("/api/audience/questions", headers=ANN, json=body)
        assert (refused.status_code, field(refused)) == (422, name)
    assert field(client.post("/api/audience/questions", json={"text": "No voter?"})) == "voter"
    assert ask(client).status_code == 201
    now.at += 12
    soon = ask(client, text="Another?")
    assert (soon.status_code, field(soon), soon.headers["retry-after"]) == (429, "text", "18")
    assert "18 seconds" in soon.json()["detail"][0]["msg"]
    now.at += 30
    assert ask(client, text="  why THE change?").status_code == 409
    assert client.post("/api/audience/questions/nope/vote", headers=BEN).status_code == 404
    assert len(client.get("/api/audience").json()["questions"]) == 1


def test_markup_in_a_question_comes_back_as_the_same_plain_text(client):
    text = "<img src=x onerror=alert(1)> <b>why?</b>"
    assert ask(client, text=text).json()["audience"]["questions"][0]["text"] == text
    assert client.get("/api/audience").headers["content-type"].startswith("application/json")


def test_a_hidden_question_and_the_draft_never_reach_fans(client):
    question = ask(client, text="Something rude").json()["id"]
    kept = ask(client, BEN, "A fair question?").json()["id"]
    hidden = client.post(f"{BASE}/questions/{question}/hide").json()
    assert [q["state"] for q in hidden["questions"]] == ["open", "hidden"] or [
        q["state"] for q in hidden["questions"]
    ] == ["hidden", "open"]
    client.post(f"{BASE}/questions/{kept}/ask")
    client.put(f"{BASE}/draft", json={"text": "A secret draft."})

    for response in (
        client.get("/api/audience"),
        client.post(f"/api/audience/questions/{kept}/vote", headers=ANN),
    ):
        body = response.text
        assert "Something rude" not in body and "A secret draft." not in body
        assert response.json()["draft"] is None and [q["id"] for q in response.json()["questions"]] == [kept]
    assert client.post(f"/api/audience/questions/{question}/vote", headers=BEN).status_code == 409

    studio = client.get(BASE).json()
    assert studio["draft"]["text"] == "A secret draft." and len(studio["questions"]) == 2
    assert client.post(f"{BASE}/questions/{question}/unhide").status_code == 200
    assert len(client.get("/api/audience").json()["questions"]) == 2


# --- the expert and going on air ---------------------------------------------------------------


def test_without_a_model_the_streamer_writes_the_answer_and_puts_it_on_air(client, now):
    question = ask(client).json()["id"]
    drafted = client.post(f"{BASE}/questions/{question}/ask").json()
    assert drafted["draft"] == {"question_id": question, "text": "", "state": "unavailable"}
    empty = client.post(f"{BASE}/draft/air", json={})
    assert (empty.status_code, field(empty)) == (422, "text")
    assert field(client.put(f"{BASE}/draft", json={"text": "x" * 401})) == "text"
    client.put(f"{BASE}/draft", json={"text": "Fresh legs for the press."})
    assert field(client.post(f"{BASE}/draft/air", json={"duration_s": 5})) == "duration_s"

    aired = client.post(f"{BASE}/draft/air", json={}).json()
    assert aired["draft"] is None and aired["qa"] == {
        "question_id": question,
        "question": "Why the change?",
        "nickname": "Ann",
        "answer": "Fresh legs for the press.",
        "ends_at": now.at + 30,
    }
    fan = client.get("/api/audience").json()
    assert fan["qa"]["answer"] == "Fresh legs for the press." and fan["questions"][0]["state"] == "answered"
    assert fan["questions"][0]["answer"] == "Fresh legs for the press."
    assert client.delete(f"{BASE}/qa").json()["qa"] is None
    assert client.post(f"{BASE}/draft/air", json={}).status_code == 409


def test_with_a_model_the_expert_drafts_from_the_match_in_the_program_language(tmp_path, now):
    expert = FakeExpert()
    with TestClient(make_app(tmp_path, now, expert=expert)) as client:
        _play_a_match(client)
        client.put(
            "/api/studio/settings", json={**client.get("/api/studio").json()["settings"], "language": "hi"}
        )
        question = ask(client).json()["id"]
        client.post(f"{BASE}/questions/{question}/ask")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and client.get(BASE).json()["draft"]["state"] != "ready":
            time.sleep(0.02)
        assert client.get(BASE).json()["draft"] == {
            "question_id": question,
            "text": "Fresh legs for the press.",
            "state": "ready",
        }
        asked, ctx, language = expert.asked[0]
        assert (asked, language) == ("Why the change?", "hi")
        assert ctx.status.state == "finished" and ctx.home.name == "Northbridge FC" and len(ctx.moments) >= 10
        assert client.get("/api/audience").json()["qa"] is None, "nothing airs until the streamer says so"
        assert client.delete(f"{BASE}/draft").json()["draft"] is None


def test_unknown_questions_and_missing_drafts_are_refused(client):
    assert client.post(f"{BASE}/questions/nope/ask").status_code == 404
    assert client.post(f"{BASE}/questions/nope/hide").status_code == 404
    refused = client.put(f"{BASE}/draft", json={"text": "No draft."})
    assert (refused.status_code, field(refused)) == (409, "draft")


# --- saving, size limits and other sites -------------------------------------------------------


def test_polls_questions_and_votes_survive_a_restart(tmp_path, now):
    with TestClient(make_app(tmp_path, now)) as first:
        option = open_poll(first)["options"][2]["id"]
        first.post("/api/audience/poll/vote", headers=ANN, json={"option_id": option})
        question = ask(first).json()["id"]
        first.post(f"/api/audience/questions/{question}/vote", headers=BEN)
    with TestClient(make_app(tmp_path, now)) as second:
        fan = second.get("/api/audience").json()
        assert fan["poll"]["options"][2]["votes"] == 1 and fan["questions"][0]["votes"] == 2
        second.post("/api/audience/poll/vote", headers=ANN, json={"option_id": option})
        assert second.get("/api/audience").json()["poll"]["options"][2]["votes"] == 1


def test_a_request_body_over_the_limit_is_refused_before_it_is_read(client):
    declared = client.post("/api/audience/questions", headers=ANN, content=b"x" * (4 * 1024 * 1024))
    assert declared.status_code == 413

    def chunks():
        for _ in range(5):
            yield bytes(1024 * 1024)

    assert client.post("/api/audience/questions", headers=ANN, content=chunks()).status_code == 413
    assert client.post("/api/studio/images", content=bytes(4 * 1024 * 1024)).status_code == 413
    assert client.get("/api/audience").json()["questions"] == []


def test_a_fan_route_cannot_be_driven_from_another_site(client):
    cross = {**ANN, "origin": "https://evil.example", "sec-fetch-site": "cross-site"}
    assert client.post("/api/audience/questions", headers=cross, json={"text": "Spam?"}).status_code == 403


# --- review fixes ------------------------------------------------------------------------------


def test_one_address_cannot_flood_the_list_by_rotating_browser_ids(client, now):
    for n in range(5):
        assert ask(client, {"x-voter": f"voter-rotating-{n:05d}"}, f"Spam {n}?").status_code == 201
    blocked = ask(client, {"x-voter": "voter-rotating-99999"}, "Spam again?")
    assert (blocked.status_code, field(blocked)) == (429, "text")
    assert int(blocked.headers["retry-after"]) == 30
    assert len(client.get("/api/audience").json()["questions"]) == 5
    now.at += 31
    assert ask(client, {"x-voter": "voter-rotating-99999"}, "After the wait?").status_code == 201


def test_an_upvote_can_be_sent_as_on_or_off_and_a_repeat_changes_nothing(client):
    question = ask(client).json()["id"]
    url = f"/api/audience/questions/{question}/vote"
    assert client.post(url, headers=BEN, json={"on": True}).json()["questions"][0]["votes"] == 2
    assert client.post(url, headers=BEN, json={"on": True}).json()["questions"][0]["votes"] == 2
    assert client.post(url, headers=BEN, json={"on": False}).json()["questions"][0]["votes"] == 1
    assert client.post(url, headers=BEN, json={"on": False}).json()["questions"][0]["votes"] == 1


def test_an_answered_question_can_be_hidden_from_fans(client):
    question = ask(client).json()["id"]
    client.post(f"{BASE}/questions/{question}/ask")
    client.put(f"{BASE}/draft", json={"text": "Aired by mistake."})
    client.post(f"{BASE}/draft/air", json={})
    assert "Aired by mistake." in client.get("/api/audience").text
    hidden = client.post(f"{BASE}/questions/{question}/hide")
    assert hidden.status_code == 200 and hidden.json()["qa"] is None
    assert "Aired by mistake." not in client.get("/api/audience").text
    assert client.post(f"{BASE}/questions/{question}/unhide").json()["questions"][0]["state"] == "answered"
