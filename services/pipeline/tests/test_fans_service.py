import asyncio
import json
import random

import pytest
from fastapi.testclient import TestClient

from kickstream.adapters.clocks import InstantClock
from kickstream.adapters.demo_feed import DemoFeed
from kickstream.adapters.x_feed import XRecentSearch, comments_from
from kickstream.app import Settings, create_app
from kickstream.contracts import FanSettings, FanZone
from kickstream.fans.rules import FanError
from kickstream.fans.service import SAVE_EVERY_S, FanService
from kickstream.ports.social import FeedBatch, FeedContext, FeedFailure, IncomingComment, IncomingSuperChat
from tests.factories import moment
from tests.output_fakes import FakeNow
from tests.test_agents import MemoryRecord

BASE = "/api/fans"


class ScriptedFeed:
    """Hands back the batches a test queued, one per fetch."""

    def __init__(self, *, demo=False, interval_s=10.0) -> None:
        self.demo, self.interval_s = demo, interval_s
        self.batches: list[FeedBatch | Exception] = []
        self.contexts: list[FeedContext] = []

    async def fetch(self, context: FeedContext) -> FeedBatch:
        self.contexts.append(context)
        if not self.batches:
            return FeedBatch()
        batch = self.batches.pop(0)
        if isinstance(batch, Exception):
            raise batch
        return batch


def said(n, text="Come on!", author=None) -> IncomingComment:
    return IncomingComment(id=f"c{n}", platform="x", author=author or f"Fan {n}", text=text)


def batch(*comments, superchats=()) -> FeedBatch:
    return FeedBatch(tuple(comments), tuple(superchats))


class Rig:
    def __init__(self, record=None, with_x=False) -> None:
        self.now = FakeNow(1_000.0)
        self.record = record or MemoryRecord()
        self.demo, self.x = ScriptedFeed(demo=True, interval_s=2.5), ScriptedFeed(interval_s=20.0)
        feeds = {"demo": self.demo, "x": self.x} if with_x else {"demo": self.demo}
        self.service = FanService(self.record, feeds, now=self.now, rng=random.Random(3))


# --- the service --------------------------------------------------------------------------------


async def test_the_chosen_feed_is_asked_when_it_is_due_and_its_comments_are_marked():
    rig = Rig()
    rig.demo.batches = [batch(said(1), said(2)), batch(said(3))]
    await rig.service.tick()
    doc = rig.service.view()
    assert [c.id for c in doc.comments] == ["c1", "c2"] and {c.demo for c in doc.comments} == {True}
    await rig.service.tick()  # not due yet
    assert len(rig.demo.contexts) == 1
    rig.now.at += 2.5
    await rig.service.tick()
    assert [c.id for c in rig.service.view().comments] == ["c1", "c2", "c3"]


async def test_what_a_feed_brings_is_saved_now_and_then_and_a_streamers_change_at_once():
    rig = Rig()
    rig.demo.batches = [batch(said(1))]
    await rig.service.tick()
    assert rig.record.record is None
    rig.now.at += SAVE_EVERY_S
    await rig.service.tick()
    assert [c["id"] for c in rig.record.record["doc"]["comments"]] == ["c1"]

    await rig.service.message("", "Welcome!", 8)
    assert rig.record.record["doc"]["spotlight"]["text"] == "Welcome!"
    assert FanService(rig.record, {"demo": rig.demo}, now=rig.now).view().spotlight.text == "Welcome!"


async def test_a_change_that_cannot_be_saved_is_refused_and_nothing_changes():
    rig = Rig(MemoryRecord(broken=True))
    with pytest.raises(FanError) as refused:
        await rig.service.message("", "Welcome!", 8)
    assert refused.value.status == 503 and rig.service.view().spotlight is None
    assert rig.service.view().revision == 0


async def test_the_feed_is_told_about_the_open_poll_and_the_match_and_votes_are_counted():
    rig = Rig()
    await rig.service.open_poll("Who wins?", ["Home", "Away"], None)
    rig.service.observe_match(moment(1, "goal", team="home"))  # before the team sheets: the side's name
    rig.demo.batches = [batch(said(1, "2"), said(2, "2"), said(3, "1"))]
    await rig.service.tick()
    assert rig.demo.contexts[0] == FeedContext(poll_options=2, moments=(("goal", "home"),))
    assert [o.votes for o in rig.service.view().poll.options] == [1, 2]
    rig.now.at += 2.5
    await rig.service.tick()
    assert rig.demo.contexts[1].moments == ()  # a moment is passed on once

    winner = (await rig.service.winner("voters")).spotlight
    assert winner.kind == "winner" and winner.name in {"Fan 1", "Fan 2", "Fan 3"}


async def test_a_failing_source_is_reported_left_alone_for_a_minute_and_recovers():
    rig = Rig(with_x=True)
    await rig.service.settings(FanSettings(source="x", auto_superchat=False))
    rig.x.batches = [FeedFailure("X's limit on searches was reached."), batch(said(1))]
    await rig.service.tick()
    doc = rig.service.view()
    assert (doc.source_state, doc.problem) == ("failing", "X's limit on searches was reached.")
    rig.now.at += 30
    await rig.service.tick()
    assert len(rig.x.contexts) == 1
    rig.now.at += 30
    await rig.service.tick()
    doc = rig.service.view()
    assert (doc.source_state, doc.problem, doc.comments[0].demo) == ("live", None, False)
    assert rig.demo.contexts == []


async def test_switching_the_source_off_stops_the_asking():
    rig = Rig()
    await rig.service.settings(FanSettings(source="off", auto_superchat=False))
    rig.now.at += 60
    await rig.service.tick()
    assert rig.demo.contexts == [] and rig.service.view().source_state == "off"
    with pytest.raises(FanError):
        await rig.service.settings(FanSettings(source="x", auto_superchat=False))


async def test_deadlines_are_settled_and_pages_are_told():
    rig = Rig()
    seen: list[FanZone] = []

    async def follow():
        async for doc in rig.service.changes():
            seen.append(doc)

    follower = asyncio.create_task(follow())
    await asyncio.sleep(0)
    await rig.service.message("", "Welcome!", 5)
    await asyncio.sleep(0)
    rig.now.at += 5
    await rig.service.tick()
    await asyncio.sleep(0)
    follower.cancel()
    assert [doc.spotlight.text if doc.spotlight else None for doc in seen] == [None, "Welcome!", None]
    assert [doc.revision for doc in seen] == [0, 1, 2] and seen[-1].server_time == rig.now.at


async def test_an_unusable_saved_zone_is_set_aside():
    rig = Rig(MemoryRecord({"doc": {"revision": "many"}}))
    assert rig.record.record is None and rig.service.view().comments == []


# --- the demo feed ------------------------------------------------------------------------------


async def test_the_demo_feed_is_made_up_reacts_to_the_match_and_votes_in_a_poll():
    feed = DemoFeed(seed=1)
    assert feed.demo is True
    quiet = await feed.fetch(FeedContext())
    reacting = await feed.fetch(FeedContext(poll_options=3, moments=(("goal", "Northbridge FC"),)))
    assert all(comment.id.startswith("demo-") for comment in (*quiet.comments, *reacting.comments))
    assert any("Northbridge FC" in comment.text for comment in reacting.comments)
    votes = [comment.text for comment in reacting.comments if comment.text in ("1", "2", "3")]
    assert votes and len({c.id for c in reacting.comments}) == len(reacting.comments)


async def test_the_demo_feed_repeats_itself_for_the_same_seed_and_sometimes_pays():
    first, second = DemoFeed(seed=5), DemoFeed(seed=5)
    assert [await first.fetch(FeedContext()) for _ in range(5)] == [
        await second.fetch(FeedContext()) for _ in range(5)
    ]
    feed = DemoFeed(seed=2)
    paid = [s for _ in range(300) for s in (await feed.fetch(FeedContext())).superchats]
    assert paid and all(s.amount > 0 and s.currency == "USD" for s in paid)


# --- the X feed ---------------------------------------------------------------------------------

X_RESPONSE = {
    "data": [
        {
            "id": "1802",
            "text": "What a goal! #Kickstream",
            "author_id": "u2",
            "created_at": "2026-10-13T14:00:05.000Z",
            "public_metrics": {"like_count": 12, "reply_count": 1},
        },
        {
            "id": "1801",
            "text": "Kick-off! #Kickstream",
            "author_id": "u1",
            "created_at": "2026-10-13T14:00:00.000Z",
        },
        {"id": "", "text": "no id"},
        "not a post",
    ],
    "includes": {
        "users": [
            {"id": "u1", "name": "Priya K", "username": "priya"},
            {"id": "u2", "name": "", "username": "tom"},
        ]
    },
    "meta": {"newest_id": "1802", "result_count": 2},
}


def test_posts_from_a_search_become_comments_oldest_first():
    first, second = comments_from(X_RESPONSE)
    assert (first.id, first.author, first.handle, first.likes) == ("x-1801", "Priya K", "@priya", 0)
    assert (second.id, second.author, second.handle, second.likes) == ("x-1802", "tom", "@tom", 12)
    assert second.at - first.at == 5.0 and second.platform == "x"
    assert comments_from({}) == [] and comments_from({"data": None}) == []


async def test_the_search_asks_for_what_is_new_since_the_last_post_it_saw():
    asked = []

    def get(url, token):
        asked.append((url, token))
        return X_RESPONSE if len(asked) == 1 else {"meta": {"result_count": 0}}

    feed = XRecentSearch("secret-token", "#Kickstream -is:retweet", get=get)
    assert feed.demo is False
    assert len((await feed.fetch(FeedContext())).comments) == 2
    assert (await feed.fetch(FeedContext())).comments == ()
    (first_url, token), (second_url, _) = asked
    assert token == "secret-token" and first_url.startswith("https://api.x.com/2/tweets/search/recent?")
    assert "query=%23Kickstream+-is%3Aretweet" in first_url and "since_id" not in first_url
    assert "since_id=1802" in second_url and "secret-token" not in first_url


async def test_a_refusal_from_x_reaches_the_streamer_in_words():
    def refused(url, token):
        raise FeedFailure("X did not accept the token. Check KICKSTREAM_X_BEARER_TOKEN.")

    with pytest.raises(FeedFailure, match="did not accept the token"):
        await XRecentSearch("bad", "q", get=refused).fetch(FeedContext())
    with pytest.raises(FeedFailure, match="not a search result"):
        await XRecentSearch("t", "q", get=lambda url, token: ["nope"]).fetch(FeedContext())


# --- the routes ---------------------------------------------------------------------------------


@pytest.fixture
def feed():
    return ScriptedFeed(demo=True, interval_s=0.05)


@pytest.fixture
def client(tmp_path, feed):
    settings = Settings(None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data")
    app = create_app(
        settings, clock_factory=lambda speed: InstantClock(), match_prefix="m", feeds={"demo": feed}
    )
    with TestClient(app) as test_client:
        yield test_client


def problem(response) -> tuple[int, str]:
    return response.status_code, response.json()["detail"][0]["loc"][-1]


def test_a_bridge_sends_comments_and_superchats_and_they_are_not_marked_as_a_demo(client):
    body = {
        "comments": [
            {
                "id": "yt-1",
                "platform": "youtube",
                "author": "Mei",
                "text": "<b>Hello</b> from Osaka",
                "likes": 2,
            }
        ],
        "superchats": [
            {"id": "yt-s1", "platform": "youtube", "name": "Kofi", "amount": 10, "currency": "GHS"}
        ],
    }
    doc = FanZone.model_validate(client.post(f"{BASE}/ingest", json=body).json())
    [comment], [superchat] = doc.comments, doc.superchats
    assert (comment.author, comment.text, comment.platform, comment.demo) == (
        "Mei",
        "<b>Hello</b> from Osaka",
        "youtube",
        False,
    )
    assert (superchat.name, superchat.amount, superchat.currency, superchat.tier) == ("Kofi", 10.0, "GHS", 3)
    assert len(client.post(f"{BASE}/ingest", json=body).json()["comments"]) == 1  # sent twice, taken once


@pytest.mark.parametrize(
    "body",
    [
        {"comments": [{"id": "", "author": "A", "text": "t"}]},
        {"comments": [{"author": "A", "text": "t"}]},
        {"comments": [{"id": "1", "author": "A", "text": "t", "likes": -1}]},
        {"comments": [{"id": "1", "author": "A", "text": "t", "admin": True}]},
        {"comments": [{"id": str(n), "author": "A", "text": "t"} for n in range(101)]},
        {"superchats": [{"id": "1", "name": "A", "amount": "lots", "currency": "USD"}]},
    ],
    ids=["blank id", "no id", "negative likes", "extra field", "too many", "amount not a number"],
)
def test_a_malformed_ingest_is_rejected(client, body):
    assert client.post(f"{BASE}/ingest", json=body).status_code == 422


def test_the_streamer_runs_a_poll_from_start_to_result(client):
    assert problem(client.put(f"{BASE}/poll/air", json={"on_air": True})) == (409, "poll")
    opened = client.post(
        f"{BASE}/poll", json={"question": "Who wins?", "options": ["Home", "Away"], "minutes": 5}
    )
    assert opened.status_code == 200 and opened.json()["poll"]["state"] == "open"
    assert problem(client.post(f"{BASE}/poll/announce")) == (409, "poll")
    votes = [{"id": f"v{n}", "author": f"Fan {n}", "text": "2" if n else "1"} for n in range(4)]
    counted = client.post(f"{BASE}/ingest", json={"comments": votes}).json()
    assert [o["votes"] for o in counted["poll"]["options"]] == [1, 3] and counted["comments"] == []
    assert client.put(f"{BASE}/poll/air", json={"on_air": True}).json()["poll_on_air"] is True
    assert client.post(f"{BASE}/poll/close").json()["poll"]["state"] == "closed"
    shown = client.post(f"{BASE}/poll/announce").json()["spotlight"]
    assert (shown["kind"], shown["text"], shown["detail"]) == ("poll_result", "Away", "75% of 4 votes")
    assert client.delete(f"{BASE}/poll").json()["poll"] is None
    assert problem(client.post(f"{BASE}/poll", json={"question": "Who?", "options": ["Only"]})) == (
        422,
        "options",
    )


def test_quick_actions_like_a_comment_thank_a_supporter_send_a_message_and_pick_a_winner(client):
    client.post(f"{BASE}/ingest", json={"comments": [{"id": "c1", "author": "Ana", "text": "Great stream"}]})
    assert client.post(f"{BASE}/comments/c1/like").json()["comments"][0]["liked"] is True
    assert (
        client.post(f"{BASE}/comments/c1/like", json={"liked": False}).json()["comments"][0]["liked"] is False
    )
    assert problem(client.post(f"{BASE}/comments/nope/like")) == (404, "comment")

    added = client.post(
        f"{BASE}/superchats", json={"name": "Ben", "amount": 20, "currency": "eur", "message": "Allez"}
    )
    superchat = added.json()["superchats"][0]
    assert (superchat["currency"], superchat["tier"]) == ("EUR", 4) and added.json()["spotlight"] is None
    assert problem(client.post(f"{BASE}/superchats", json={"name": "Ben", "amount": 0})) == (422, "superchat")

    first = client.post(f"{BASE}/superchats/{superchat['id']}/spotlight").json()["spotlight"]
    assert (first["kind"], first["name"], first["detail"], first["text"]) == (
        "superchat",
        "Ben",
        "EUR 20.00",
        "Allez",
    )
    client.post(f"{BASE}/comments/c1/spotlight")
    client.post(f"{BASE}/spotlight", json={"title": "Half-time", "text": "Back in 15", "duration_s": 12})
    queued = client.post(f"{BASE}/winner", json={"pool": "commenters"}).json()["spotlight_queue"]
    assert [(s["kind"], s["name"]) for s in queued] == [
        ("comment", "Ana"),
        ("message", None),
        ("winner", "Ana"),
    ]
    assert client.delete(f"{BASE}/spotlight").json()["spotlight"]["kind"] == "comment"
    assert problem(client.post(f"{BASE}/winner", json={"pool": "voters"})) == (409, "pool")
    assert client.post(f"{BASE}/winner", json={"pool": "referees"}).status_code == 422
    assert problem(client.post(f"{BASE}/spotlight", json={"text": " "})) == (422, "text")

    emptied = client.delete(BASE).json()
    assert (emptied["comments"], emptied["superchats"], emptied["spotlight"]) == ([], [], None)


def test_settings_choose_the_source_and_x_needs_setting_up(client):
    off = client.put(f"{BASE}/settings", json={"source": "off", "auto_superchat": True}).json()
    assert (off["source_state"], off["settings"]["auto_superchat"], off["x_available"]) == (
        "off",
        True,
        False,
    )
    assert problem(client.put(f"{BASE}/settings", json={"source": "x", "auto_superchat": True})) == (
        409,
        "source",
    )
    assert (
        client.put(f"{BASE}/settings", json={"source": "mastodon", "auto_superchat": True}).status_code == 422
    )


def test_pages_follow_the_fan_zone_over_a_socket_and_the_feed_fills_it(client, feed):
    feed.batches = [batch(said(1, "Hello from the feed"))]
    with client.websocket_connect(f"{BASE}/socket") as socket:
        for _ in range(20):
            doc = json.loads(socket.receive_text())
            if doc["comments"]:
                break
        assert doc["comments"][0]["text"] == "Hello from the feed" and doc["comments"][0]["demo"] is True
        client.post(f"{BASE}/spotlight", json={"text": "Welcome!"})
        for _ in range(20):
            doc = json.loads(socket.receive_text())
            if doc["spotlight"]:
                break
        assert doc["spotlight"]["text"] == "Welcome!"


def test_a_page_from_another_site_cannot_change_the_fan_zone(client):
    refused = client.post(f"{BASE}/spotlight", json={"text": "Hi"}, headers={"sec-fetch-site": "cross-site"})
    assert refused.status_code == 403


def test_with_a_token_and_a_query_x_can_be_chosen(tmp_path):
    settings = Settings(
        None,
        None,
        None,
        cache_dir=tmp_path / "c",
        data_dir=tmp_path / "d",
        x_bearer_token="tok-9f3-secret",
        x_query="#Kickstream",
    )
    assert "tok-9f3-secret" not in repr(settings)
    with TestClient(create_app(settings, clock_factory=lambda speed: InstantClock())) as client:
        assert client.get(BASE).json()["x_available"] is True
    env = {"KICKSTREAM_X_BEARER_TOKEN": "abc", "KICKSTREAM_X_QUERY": "#Derby"}
    assert (Settings.from_env(env).x_bearer_token, Settings.from_env(env).x_query) == ("abc", "#Derby")
    assert Settings.from_env({}).x_bearer_token is None


def test_paid_messages_reach_the_zone_through_a_feed():
    async def run():
        rig = Rig()
        rig.demo.batches = [
            batch(superchats=(IncomingSuperChat("s1", "twitch", "Zara", 50, "USD", "Brilliant"),))
        ]
        await rig.service.tick()
        return rig.service.view()

    doc = asyncio.run(run())
    assert [(s.name, s.tier, s.demo) for s in doc.superchats] == [("Zara", 5, True)] and doc.spotlight is None
