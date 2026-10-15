import asyncio
import json
import random
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from kickstream.adapters.azure_speech import AzureSpeech, ssml
from kickstream.adapters.clocks import InstantClock
from kickstream.adapters.json_record_store import JsonRecordStore
from kickstream.app import Settings, create_app
from kickstream.autolive.commentary import CommentaryService, scripted
from kickstream.autolive.facts import MatchFacts, ordinal
from kickstream.autolive.scenes import SCENE_IDS, TRANSITIONS, auto_scenes
from kickstream.autolive.service import (
    BETWEEN_MATCHES_S,
    STREAM_RETRY_S,
    AutoLiveError,
    AutoLiveService,
    check,
    default_settings,
)
from kickstream.autolive.speech import SpeechService
from kickstream.contracts import MatchStatus
from kickstream.domain.recent import make_room
from kickstream.domain.teams import AWAY, HOME
from kickstream.ports.commentary import CommentaryError
from kickstream.ports.speech import SpeechFailure
from tests.output_fakes import FakeNow

PROGRAM = "http://127.0.0.1:8000/live?output"


def status(match_id="m-1", state="live", minute=21, home=1, away=0) -> MatchStatus:
    return MatchStatus(
        match_id=match_id,
        state=state,
        minute=minute,
        score_home=home,
        score_away=away,
        speed=1,
        home=HOME,
        away=AWAY,
    )


class FakeSynth:
    def __init__(self, available=True) -> None:
        self.region = "centralindia"
        self._available = available
        self.said: list[tuple[str, str, float]] = []
        self.failure: SpeechFailure | None = None
        self.gate = asyncio.Event()
        self.gate.set()

    def available(self) -> bool:
        return self._available

    async def synthesize(self, text, voice, rate) -> bytes:
        self.said.append((text, voice, rate))
        await self.gate.wait()
        if self.failure is not None:
            raise self.failure
        return b"ID3-" + text.encode()


class Rig:
    def __init__(self, tmp_path, *, enabled_at_first=False) -> None:
        self.tmp_path = tmp_path
        self.now = FakeNow(10_000.0)
        self.facts = MatchFacts()
        self.synth = FakeSynth()
        self.speech = SpeechService(
            self.synth,
            JsonRecordStore(tmp_path / "budget.json"),
            tmp_path / "speech",
            daily_chars=100,
            now=self.now,
        )
        self.running = None
        self.started: list[tuple[int, float]] = []
        self.output = SimpleNamespace(state="idle", problem=None)
        self.outputs: list[str] = []
        self.stops = 0
        self.service = self.build(enabled_at_first)

    def build(self, enabled_at_first=False) -> AutoLiveService:
        async def start_match(seed, speed):
            self.started.append((seed, speed))
            return f"m-{len(self.started)}"

        def start_output(url):
            self.outputs.append(url)
            self.output.state = "starting"

        async def stop_output():
            self.stops += 1
            self.output.state = "idle"

        return AutoLiveService(
            JsonRecordStore(self.tmp_path / "autolive.json"),
            facts=self.facts,
            commentary=CommentaryService(rng=random.Random(3)),
            speech=self.speech,
            running_match=lambda: self.running,
            start_match=start_match,
            output_view=lambda: self.output,
            start_output=start_output,
            stop_output=stop_output,
            program_url=PROGRAM,
            now=self.now,
            rng=random.Random(7),
            enabled_at_first=enabled_at_first,
        )

    def switch(self, **changes) -> None:
        self.service.set_settings(self.service.settings.model_copy(update=changes))


@pytest.fixture
def rig(tmp_path):
    return Rig(tmp_path)


async def settle() -> None:
    for _ in range(5):
        await asyncio.sleep(0)


# --- the screens -------------------------------------------------------------------------------


def test_there_are_15_to_25_screens_with_one_for_every_agent():
    scenes = auto_scenes()
    assert 15 <= len(scenes) <= 25
    assert len({scene.id for scene in scenes}) == len(scenes) == len(SCENE_IDS)
    agents = {scene.agent for scene in scenes if scene.kind == "agent"}
    assert {
        "interpreter",
        "tactics",
        "prediction",
        "explainability",
        "visualization",
        "tracking",
        "highlights",
    } <= agents
    assert {"match", "analysis", "fans", "show"} <= {scene.kind for scene in scenes}
    assert all(scene.elements and scene.blurb for scene in scenes)


def test_every_screen_keeps_clear_of_the_header_band_and_inside_the_frame():
    for scene in auto_scenes():
        for element in scene.elements:
            if element.type == "ticker":
                continue
            assert element.y >= 96, f"{scene.id}/{element.id} sits under the header"
            assert element.x + element.width <= 1920 and element.y + element.height <= 1080, (
                f"{scene.id}/{element.id}"
            )


def test_settings_are_checked_and_put_in_catalogue_order():
    defaults = default_settings()
    with pytest.raises(AutoLiveError, match="cannot be longer"):
        check(defaults.model_copy(update={"min_minutes": 11, "max_minutes": 10}))
    with pytest.raises(AutoLiveError, match="no auto live screen"):
        check(defaults.model_copy(update={"scenes": ["nowhere"]}))
    with pytest.raises(AutoLiveError, match="at least one"):
        check(defaults.model_copy(update={"scenes": []}))
    picked = check(defaults.model_copy(update={"scenes": ["momentum", "welcome", "momentum"]}))
    assert picked.scenes == ["welcome", "momentum"]


# --- rotation and commentary ---------------------------------------------------------------------


async def test_switched_off_nothing_rotates_plays_or_streams(rig):
    rig.now.at += 3600
    await rig.service.tick()
    view = rig.service.view()
    assert (view.settings.enabled, view.next_at, view.commentary) == (False, None, None)
    assert rig.started == [] and rig.outputs == []


async def test_switched_on_it_rotates_within_the_minutes_with_a_new_transition_and_commentary(rig):
    rig.switch(enabled=True, keep_match=False)
    await settle()
    view = rig.service.view()
    assert view.changed_at + 5 * 60 <= view.next_at <= view.changed_at + 10 * 60
    assert view.commentary is not None and view.commentary.scene_id == "welcome"
    first, transition = view.scene_id, view.transition

    rig.now.at = view.next_at - 1
    await rig.service.tick()
    assert rig.service.view().scene_id == first

    rig.now.at = view.next_at
    await rig.service.tick()
    await settle()
    after = rig.service.view()
    assert after.scene_id == SCENE_IDS[1]
    assert after.transition != transition and after.transition in TRANSITIONS
    assert after.commentary.scene_id == SCENE_IDS[1] and after.commentary.source == "scripted"
    assert after.next_at > after.changed_at


async def test_the_minutes_are_the_users_and_rotation_can_be_turned_off(rig):
    rig.switch(enabled=True, keep_match=False, min_minutes=1, max_minutes=1)
    view = rig.service.view()
    assert view.next_at == pytest.approx(view.changed_at + 60)
    rig.switch(rotate=False)
    assert rig.service.view().next_at is None
    rig.now.at += 3600
    await rig.service.tick()
    assert rig.service.view().scene_id == "welcome"


async def test_while_a_screen_stays_on_air_it_talks_every_talk_minutes(rig):
    rig.switch(enabled=True, keep_match=False, rotate=False, talk_minutes=2)
    await settle()
    first = rig.service.view().commentary
    rig.now.at += 119
    await rig.service.tick()
    await settle()
    assert rig.service.view().commentary.id == first.id
    rig.now.at += 1
    await rig.service.tick()
    await settle()
    assert rig.service.view().commentary.id != first.id


async def test_a_screen_can_be_put_on_air_and_skipped_by_hand(rig):
    rig.service.show("agent-tactics")
    assert rig.service.view().scene_id == "agent-tactics"
    rig.service.next_scene()
    assert rig.service.view().scene_id == SCENE_IDS[SCENE_IDS.index("agent-tactics") + 1]
    with pytest.raises(AutoLiveError):
        rig.service.show("nowhere")


async def test_leaving_the_on_air_screen_out_of_the_rotation_moves_to_the_first_kept(rig):
    rig.service.show("momentum")
    rig.switch(scenes=["xg-race", "fan-zone"])
    assert rig.service.view().scene_id == "xg-race"


async def test_settings_and_screen_survive_a_restart(rig):
    rig.switch(enabled=True, min_minutes=2, max_minutes=3, stream=True)
    rig.service.show("agent-prediction")
    again = rig.build()
    assert again.settings.enabled and again.settings.stream and again.settings.max_minutes == 3
    assert again.view().scene_id == "agent-prediction"


def test_auto_live_can_start_switched_on_until_settings_are_saved(tmp_path):
    assert Rig(tmp_path, enabled_at_first=True).service.settings.enabled


# --- keeping a match playing ---------------------------------------------------------------------


async def test_a_match_starts_at_once_when_none_has_played_and_after_the_recap_otherwise(rig):
    rig.switch(enabled=True, match_speed=2)
    await rig.service.tick()
    assert len(rig.started) == 1 and rig.started[0][1] == 2

    rig.running = object()
    rig.facts.take("m-1", status())
    await rig.service.tick()
    rig.facts.take("m-1", status(state="finished"))
    rig.running = None
    rig.now.at += 1
    await rig.service.tick()
    assert len(rig.started) == 1
    rig.now.at += BETWEEN_MATCHES_S - 1
    await rig.service.tick()
    assert len(rig.started) == 1
    rig.now.at += 1
    await rig.service.tick()
    assert len(rig.started) == 2
    assert rig.service.view().matches_started == 2


async def test_no_match_is_started_while_one_is_running_or_when_keep_match_is_off(rig):
    rig.running = object()
    rig.switch(enabled=True)
    await rig.service.tick()
    rig.running = None
    rig.switch(keep_match=False)
    await rig.service.tick()
    assert rig.started == []


# --- keeping the stream up -----------------------------------------------------------------------


async def test_the_stream_goes_on_air_with_the_auto_live_page_and_comes_back_when_it_stops(rig):
    rig.switch(enabled=True, keep_match=False, stream=True)
    await rig.service.tick()
    assert rig.outputs == [PROGRAM]

    rig.output.state = "live"
    await rig.service.tick()
    rig.output.state, rig.output.problem = "idle", "ffmpeg exited"
    await rig.service.tick()
    view = rig.service.view()
    assert view.stream_restarts == 1 and "ffmpeg exited" in view.problem

    waits = []
    for expected in STREAM_RETRY_S[:3]:
        rig.now.at += expected - 0.5
        await rig.service.tick()
        waits.append(len(rig.outputs))
        rig.now.at += 0.5
        await rig.service.tick()
        waits.append(len(rig.outputs))
        rig.output.state = "idle"
        await rig.service.tick()
    assert waits == [1, 2, 2, 3, 3, 4]
    assert rig.service.view().stream_restarts == 4


async def test_a_long_healthy_stream_waits_the_shortest_time_after_its_next_stop(rig):
    rig.switch(enabled=True, keep_match=False, stream=True)
    await rig.service.tick()
    for _ in range(3):
        rig.output.state = "idle"
        await rig.service.tick()
        rig.now.at += 3600
        await rig.service.tick()
    rig.output.state = "live"
    await rig.service.tick()
    rig.now.at += 301
    await rig.service.tick()
    assert rig.service.view().problem is None
    rig.output.state = "idle"
    await rig.service.tick()
    before = len(rig.outputs)
    rig.now.at += STREAM_RETRY_S[0]
    await rig.service.tick()
    assert len(rig.outputs) == before + 1


async def test_a_stream_the_studio_started_is_left_alone(rig):
    rig.output.state = "live"
    rig.switch(enabled=True, keep_match=False, stream=True)
    await rig.service.tick()
    assert rig.outputs == [] and "on air" in rig.service.view().problem
    await rig.service.stop()
    assert rig.stops == 0


async def test_turning_the_stream_off_stops_only_auto_lives_own(rig):
    rig.switch(enabled=True, keep_match=False, stream=True)
    await rig.service.tick()
    rig.output.state = "live"
    rig.switch(stream=False)
    await rig.service.tick()
    assert rig.stops == 1 and rig.service.view().problem is None


# --- the voice -----------------------------------------------------------------------------------


async def test_a_line_said_before_comes_from_the_cache_and_counts_once(rig):
    first = await rig.speech.speak("Over  to the  Tactical Analyst.", "en-GB-RyanNeural", 1.05)
    again = await rig.speech.speak("Over to the Tactical Analyst.", "en-GB-RyanNeural", 1.05)
    assert first == again and len(rig.synth.said) == 1
    assert rig.speech.view().chars_today == len("Over to the Tactical Analyst.")


async def test_the_same_line_asked_twice_at_once_is_made_once(rig):
    rig.synth.gate.clear()
    both = asyncio.gather(*(rig.speech.speak("Kick-off!", "en-US-AvaNeural", 1.0) for _ in range(2)))
    await settle()
    rig.synth.gate.set()
    assert (await both)[0] == b"ID3-Kick-off!" and len(rig.synth.said) == 1


async def test_the_daily_allowance_and_failures_are_reported_for_the_browser_voice_to_take_over(rig):
    with pytest.raises(SpeechFailure, match="used up"):
        await rig.speech.speak("x" * 101, "en-GB-RyanNeural", 1.0)
    assert "used up" in rig.speech.view().problem
    rig.synth.failure = SpeechFailure("Azure Speech refused the key.")
    with pytest.raises(SpeechFailure, match="refused"):
        await rig.speech.speak("Hello", "en-GB-RyanNeural", 1.0)
    rig.synth.failure = None
    await rig.speech.speak("Hello", "en-GB-RyanNeural", 1.0)
    assert rig.speech.view().problem is None
    with pytest.raises(SpeechFailure):
        await rig.speech.speak("   ", "en-GB-RyanNeural", 1.0)


async def test_without_azure_speech_the_page_is_told_to_use_its_own_voice(tmp_path):
    speech = SpeechService(FakeSynth(available=False), JsonRecordStore(tmp_path / "b.json"), tmp_path / "s")
    assert speech.view().azure is False
    with pytest.raises(SpeechFailure, match="not set up"):
        await speech.speak("Hello", "en-GB-RyanNeural", 1.0)


def test_ssml_carries_the_voice_language_and_rate_and_escapes_the_text():
    made = ssml("Tom & Jerry <3", "en-GB-RyanNeural", 1.1)
    assert "xml:lang='en-GB'" in made or 'xml:lang="en-GB"' in made
    assert "RyanNeural" in made and "+10%" in made and "Tom &amp; Jerry &lt;3" in made


async def test_azure_speech_sends_ssml_with_the_key_and_explains_refusals():
    seen = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.headers["Ocp-Apim-Subscription-Key"] == "bad":
            return httpx.Response(401)
        return httpx.Response(200, content=b"mp3")

    good = AzureSpeech("good", "centralindia", transport=httpx.MockTransport(answer))
    assert await good.synthesize("Hi", "en-GB-RyanNeural", 1.0) == b"mp3"
    assert str(seen[0].url) == "https://centralindia.tts.speech.microsoft.com/cognitiveservices/v1"
    assert seen[0].headers["X-Microsoft-OutputFormat"].endswith("mp3")
    bad = AzureSpeech("bad", "centralindia", transport=httpx.MockTransport(answer))
    with pytest.raises(SpeechFailure, match="refused the key"):
        await bad.synthesize("Hi", "en-GB-RyanNeural", 1.0)
    assert not AzureSpeech(None, "centralindia").available()


# --- the words -----------------------------------------------------------------------------------


def test_scripted_commentary_names_the_screen_the_score_and_the_minute():
    facts = MatchFacts()
    scene = next(s for s in auto_scenes() if s.id == "agent-tactics")
    waiting = scripted(scene, facts, None, opening=True, rng=random.Random(1))
    assert "Tactical Analyst" in waiting and "next match" in waiting
    facts.take("m-1", status(minute=22))
    said = scripted(scene, facts, None, opening=True, rng=random.Random(1))
    assert "lead" in said and "22nd minute" in said


def test_ordinals_read_naturally():
    assert [ordinal(n) for n in (1, 2, 3, 4, 11, 12, 13, 21, 22, 90, 101)] == [
        "1st",
        "2nd",
        "3rd",
        "4th",
        "11th",
        "12th",
        "13th",
        "21st",
        "22nd",
        "90th",
        "101st",
    ]


def test_facts_follow_the_newest_match_and_ignore_an_old_one_ending():
    facts = MatchFacts()
    facts.take("m-1", status("m-1"))
    facts.take("m-2", status("m-2", minute=3))
    facts.take("m-1", status("m-1", state="abandoned"))
    assert facts.match_id == "m-2" and facts.status.minute == 3


class Writer:
    model = "test-model"

    def __init__(self, answer=None, error=None) -> None:
        self.answer, self.error, self.asked = answer, error, []

    async def write(self, ctx) -> str:
        self.asked.append(ctx)
        if self.error:
            raise self.error
        return self.answer


async def test_the_model_words_the_commentary_within_its_hourly_allowance():
    scene = auto_scenes()[0]
    facts = MatchFacts()
    facts.take("m-1", status())
    writer = Writer(answer="  What a start in this one.  ")
    service = CommentaryService(writer, per_hour=1, now=lambda: 0.0)
    assert await service.write(scene, facts, None, opening=True) == ("What a start in this one.", "model")
    assert ("Score", f"{HOME.name} 1, {AWAY.name} 0") in writer.asked[0].facts
    text, source = await service.write(scene, facts, None, opening=True)
    assert source == "scripted" and text


async def test_a_failing_model_falls_back_to_the_templates():
    service = CommentaryService(Writer(error=CommentaryError("down")))
    text, source = await service.write(auto_scenes()[3], MatchFacts(), None, opening=False)
    assert source == "scripted" and text


# --- bounded memory ------------------------------------------------------------------------------


def test_make_room_keeps_only_the_newest_matches():
    seen: dict[str, int] = {}
    for n in range(10):
        make_room(seen, f"m-{n}")
        seen[f"m-{n}"] = n
    assert list(seen) == ["m-6", "m-7", "m-8", "m-9"]
    make_room(seen, "m-9")
    assert len(seen) == 4


# --- over HTTP -----------------------------------------------------------------------------------


@pytest.fixture
def client(tmp_path):
    settings = Settings(None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data")
    app = create_app(
        settings, clock_factory=lambda speed: InstantClock(), match_prefix="m", speech=FakeSynth()
    )
    with TestClient(app) as test_client:
        yield test_client


def test_the_page_reads_and_changes_auto_live_over_http(client):
    doc = client.get("/api/autolive").json()
    assert 15 <= len(doc["scenes"]) <= 25 and doc["settings"]["enabled"] is False
    settings = {**doc["settings"], "enabled": True, "keep_match": False, "min_minutes": 6, "max_minutes": 8}
    changed = client.put("/api/autolive/settings", json=settings).json()
    assert changed["settings"]["min_minutes"] == 6 and changed["next_at"] is not None
    refused = client.put("/api/autolive/settings", json={**settings, "min_minutes": 9})
    assert refused.status_code == 422
    shown = client.post("/api/autolive/scenes/agent-highlights/show").json()
    assert shown["scene_id"] == "agent-highlights"
    assert client.post("/api/autolive/next").json()["scene_id"] != "agent-highlights"


def test_pages_follow_auto_live_over_a_socket(client):
    with client.websocket_connect("/api/autolive/socket") as socket:
        assert json.loads(socket.receive_text())["scene_id"] == "welcome"
        client.post("/api/autolive/next")
        assert json.loads(socket.receive_text())["scene_id"] == SCENE_IDS[1]


def test_the_voice_is_served_as_mp3_and_refusals_are_503(client):
    spoken = client.post("/api/autolive/speech", json={"text": "Welcome to Kickstream Live."})
    assert spoken.status_code == 200 and spoken.headers["content-type"] == "audio/mpeg"
    assert spoken.content == b"ID3-Welcome to Kickstream Live."
    assert client.post("/api/autolive/speech", json={"text": "  "}).status_code == 503


def test_health_answers_for_the_platforms_probes(client):
    health = client.get("/api/health").json()
    assert health["status"] == "ok" and health["output"] == "idle" and health["autolive"] is False


def test_settings_read_auto_live_and_azure_speech_from_the_environment():
    settings = Settings.from_env(
        {
            "KICKSTREAM_AUTOLIVE": "on",
            "KICKSTREAM_SPEECH_KEY": "secret-speech-key",
            "KICKSTREAM_SPEECH_REGION": "centralindia",
            "KICKSTREAM_PROGRAM_URL": "http://127.0.0.1:8000/studio?output",
        }
    )
    assert settings.autolive_on and settings.speech_region == "centralindia"
    assert settings.speech_key == "secret-speech-key" and "secret-speech-key" not in repr(settings)
    assert settings.autolive_program_url == "http://127.0.0.1:8000/live?output"
