import asyncio
from collections import Counter

import pytest
from fastapi.testclient import TestClient

from kickstream.adapters.clocks import InstantClock
from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.adapters.scripted_explainer import ScriptedExplainer
from kickstream.agents.explain import ExplainService
from kickstream.agents.registry import AgentSwitches
from kickstream.agents.stage import AgentsStage
from kickstream.app import Settings, build_pipeline, create_app
from kickstream.contracts import (
    AgentCatalog,
    AgentRun,
    MatchIntelligence,
    MatchStatus,
    Player,
    PlayerReport,
    ViewerProfile,
)
from kickstream.domain.demo import DEMO_SEED
from kickstream.domain.teams import AWAY, HOME
from kickstream.gateway.personalize import to_envelope
from kickstream.gateway.stream import LATEST_ONLY, stream_items
from kickstream.ports.bus import AGENTS
from tests.factories import MATCH, event, moment

AGENT_TYPES = {
    "play",
    "tactics",
    "prediction",
    "explanation",
    "pitch_scene",
    "players",
    "highlight",
    "agent_run",
}
FAN_EN = ViewerProfile(mode="fan", language="en")


def _settings(tmp_path) -> Settings:
    return Settings(None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data")


async def _play(tmp_path, switch_off=()):
    pipeline = build_pipeline(_settings(tmp_path), clock_factory=lambda speed: InstantClock())
    for agent_id in switch_off:
        pipeline.agents.set(agent_id, False)
    pipeline.start()
    match_id = await pipeline.controller.start(DEMO_SEED, 600)
    await asyncio.wait_for(pipeline.controller.wait(), 30)
    agents = next(stage for stage in pipeline.stages if type(stage).__name__ == "AgentsStage")
    for _ in range(300):
        log = pipeline.store.read(match_id)
        finished = any(i.type == "match_status" and i.payload.state == "finished" for i in log)
        played = sum(i.type == "match_event" for i in log)
        expected = 0 if "event_interpreter" in switch_off else played
        if finished and sum(i.type == "play" for i in log) == expected:
            await agents.settle()
            await asyncio.sleep(0.1)
            break
        await asyncio.sleep(0.1)
    else:
        raise AssertionError("the agents did not finish")
    log = pipeline.store.read(match_id)
    await pipeline.stop()
    return pipeline, match_id, log


async def test_every_agent_works_on_a_whole_match(tmp_path):
    _, _, log = await _play(tmp_path)
    by_type = Counter(item.type for item in log)
    assert AGENT_TYPES <= set(by_type)
    events = by_type["match_event"]
    assert by_type["play"] == events and by_type["pitch_scene"] == events
    assert by_type["tactics"] == by_type["prediction"] == by_type["players"] == 90

    highlights = [item.payload for item in log if item.type == "highlight"]
    moments = [item.payload.id for item in log if item.type == "key_moment"]
    assert sorted(h.moment_id for h in highlights if h.kind == "key") == sorted(moments)
    assert any(h.kind == "hidden" for h in highlights)

    explanations = [item for item in log if item.type == "explanation"]
    assert explanations and Counter(item.mode for item in explanations)["fan"] == len(explanations) / 2
    subjects = {item.payload.id for item in log if item.type in ("tactics", "prediction", "highlight")}
    assert {item.payload.subject_id for item in explanations} <= subjects

    runs = [item.payload for item in log if item.type == "agent_run"]
    assert {run.agent for run in runs} == {
        "event_interpreter",
        "tactical_analyst",
        "prediction",
        "player_tracking",
        "visualization",
        "highlights",
        "explainability",
    }
    steady = Counter((run.agent, run.minute) for run in runs if run.agent != "explainability")
    assert max(steady.values()) == 1, "an agent reports at most once a match minute"
    interpreted = sum(run.count for run in runs if run.agent == "event_interpreter")
    assert interpreted == events


async def test_a_viewer_gets_one_wording_of_each_explanation(tmp_path):
    _, _, log = await _play(tmp_path)
    for mode in ("fan", "analyst"):
        profile = ViewerProfile(mode=mode, language="es")
        seen = [e for e in (to_envelope(item, profile) for item in log) if e and e.type == "explanation"]
        assert seen and {e.payload["mode"] for e in seen} == {mode}
        assert len({e.payload["subject_id"] for e in seen}) == len(seen)


async def test_switching_an_agent_off_quietens_it_and_the_agents_that_listen_to_it(tmp_path):
    _, _, log = await _play(tmp_path, switch_off=["prediction"])
    by_type = Counter(item.type for item in log)
    assert by_type["prediction"] == 0 and by_type["tactics"] == 90 and by_type["play"] > 0
    assert not any(item.payload.agent == "prediction" for item in log if item.type == "agent_run")
    assert not any(item.payload.subject_kind == "prediction" for item in log if item.type == "explanation")


async def test_without_the_interpreter_no_agent_has_anything_to_work_on(tmp_path):
    _, _, log = await _play(tmp_path, switch_off=["event_interpreter"])
    by_type = Counter(item.type for item in log)
    assert not {"play", "tactics", "prediction", "pitch_scene", "players"} & set(by_type)
    # The key moments come from the analytics stage, so the Highlights Agent still ranks them.
    assert {item.payload.kind for item in log if item.type == "highlight"} == {"key"}
    assert by_type["match_event"] > 0 and by_type["narrative"] > 0


async def test_a_page_arriving_late_is_replayed_only_the_newest_scene_and_player_report(tmp_path):
    pipeline, match_id, log = await _play(tmp_path)
    stream = stream_items(pipeline.store, pipeline.broadcaster, match_id, FAN_EN)
    last = max(item.id for item in log if to_envelope(item, FAN_EN) is not None)
    replayed = []
    async for envelope in stream:
        replayed.append(envelope)
        if envelope.id >= last:
            break
    await stream.aclose()
    by_type = Counter(envelope.type for envelope in replayed)
    assert by_type["pitch_scene"] == 1 and by_type["players"] == 1
    newest = {kind: max(item.id for item in log if item.type == kind) for kind in LATEST_ONLY}
    assert {e.id for e in replayed if e.type in LATEST_ONLY} == set(newest.values())
    assert by_type["play"] == sum(item.type == "play" for item in log)
    assert [e.id for e in replayed] == sorted(e.id for e in replayed)


def _status(detail="full", home=HOME) -> MatchStatus:
    return MatchStatus(
        match_id=MATCH,
        state="live",
        minute=0,
        score_home=0,
        score_away=0,
        speed=1,
        home=home,
        away=AWAY,
        detail=detail,
    )


def _drained(subscription) -> list:
    out = []
    while not subscription.queue.empty():
        out.append(subscription.queue.get_nowait().payload)
    return out


async def test_position_only_agents_sit_out_a_key_events_match():
    bus = InMemoryEventBus()
    agents = bus.subscribe(AGENTS)
    stage = AgentsStage(bus, AgentSwitches(), ExplainService(ScriptedExplainer()))
    await stage.take(MATCH, _status("key_events"))
    await stage.take(MATCH, event(1, "kickoff", located=False))
    await stage.take(MATCH, event(2, "goal", "home", minute=12, player_id="nbr-9", located=False))
    await stage.take(MATCH, moment(1, "goal", minute=12, player_id="nbr-9", facts=[]))
    await stage.take(MATCH, event(3, "yellow_card", "away", minute=13, located=False))
    out = _drained(agents)
    assert {type(item).__name__ for item in out} >= {"PlayEvent", "Prediction", "PlayerReport", "Highlight"}
    assert not {"TacticalInsight", "PitchScene"} & {type(item).__name__ for item in out}
    assert {run.agent for run in out if isinstance(run, AgentRun)} == {
        "event_interpreter",
        "prediction",
        "player_tracking",
        "highlights",
    }


async def test_the_agents_learn_players_who_appear_in_later_statuses():
    bus = InMemoryEventBus()
    agents = bus.subscribe(AGENTS)
    stage = AgentsStage(bus, AgentSwitches(), ExplainService(ScriptedExplainer()))
    await stage.take(MATCH, _status("key_events"))
    scorer = Player(id="ol-1", name="New Scorer", number=0, position="FW")
    await stage.take(
        MATCH, _status("key_events", HOME.model_copy(update={"players": [*HOME.players, scorer]}))
    )
    await stage.take(MATCH, event(1, "goal", "home", minute=12, player_id="ol-1", located=False))
    [report] = [item for item in _drained(agents) if isinstance(item, PlayerReport)]
    newcomer = next(line for line in report.players if line.player_id == "ol-1")
    assert (newcomer.name, newcomer.goals, newcomer.on_pitch) == ("New Scorer", 1, False)


@pytest.fixture
def client(tmp_path):
    app = create_app(_settings(tmp_path), clock_factory=lambda speed: InstantClock(), match_prefix="m")
    with TestClient(app) as test_client:
        yield test_client


def test_the_catalogue_route_lists_the_agents_and_switches_one(client, tmp_path):
    catalog = AgentCatalog.model_validate(client.get("/api/agents").json())
    assert len(catalog.agents) == 7 and catalog.model is False
    assert catalog.agents[0].name == "Event Interpreter"
    assert catalog.agents[0].description == "Converts video detections into structured events."

    changed = client.put("/api/agents/highlights", json={"enabled": False})
    assert changed.status_code == 200
    assert {a["id"]: a["enabled"] for a in changed.json()["agents"]}["highlights"] is False
    assert (tmp_path / "data" / "agents.json").exists()
    assert {a["id"]: a["enabled"] for a in client.get("/api/agents").json()["agents"]}["highlights"] is False


@pytest.mark.parametrize("body", [{}, {"enabled": "no"}, {"enabled": True, "extra": 1}], ids=str)
def test_a_malformed_switch_is_rejected(client, body):
    assert client.put("/api/agents/highlights", json=body).status_code == 422


def test_an_unknown_agent_cannot_be_switched(client):
    response = client.put("/api/agents/referee", json={"enabled": False})
    assert response.status_code == 404
    assert response.json()["detail"][0]["msg"] == "There is no agent called referee."


def test_intelligence_is_the_latest_output_of_every_agent(client):
    assert client.get("/api/matches/m-9/intelligence").status_code == 404
    client.post("/api/matches", json={"speed": 600})
    for _ in range(200):
        body = client.get("/api/matches/m-1/intelligence").json()
        if body["minute"] >= 90 and body["runs"]:
            break
    doc = MatchIntelligence.model_validate(body)
    assert doc.tactics and doc.prediction and doc.pitch and doc.player
    assert len(doc.plays) == 10 and doc.plays[-1].type == "full_time"
    assert doc.highlights == sorted(doc.highlights, key=lambda h: -h.score)
    assert {e.mode for e in doc.explanations} == {"fan"}

    analyst = client.get("/api/matches/m-1/intelligence?mode=analyst").json()
    assert {e["mode"] for e in analyst["explanations"]} == {"analyst"}
    followed = client.get("/api/matches/m-1/intelligence?player=hbc-1").json()["player"]
    assert followed["name"] == "Osric Pendlebury" and followed["position"] == "GK"
    assert client.get("/api/matches/m-1/intelligence?player=nobody").json()["player"] is None
    assert client.get("/api/matches/m-1/intelligence?mode=coach").status_code == 422
