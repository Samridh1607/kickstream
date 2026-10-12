import json

import pytest

from kickstream.adapters.agent_writer import AgentNarrativeWriter, parse_json
from kickstream.adapters.scripted_writer import ScriptedNarrativeWriter
from kickstream.domain.types import VARIANTS
from kickstream.narration.service import NarrationService
from kickstream.ports.writer import NarrationError

from tests.fake_llm import FakeLLM
from tests.factories import moment_ctx, recap_ctx


@pytest.fixture(scope="module")
def server():
    fake = FakeLLM()
    fake.start()
    yield fake
    fake.stop()


@pytest.fixture
def llm(server):
    server.reset()
    return server


def writer(llm):
    return AgentNarrativeWriter(base_url=llm.base_url, model="fake-model", api_key="test-key")


async def test_moment_is_written_by_two_agents_then_localized(llm):
    written = await writer(llm).write_moment(moment_ctx(kind="goal", minute=23))
    assert set(written) == set(VARIANTS)
    assert (written[("fan", "en")].text, written[("fan", "en")].agent) == ("Fan line.", "commentator")
    assert (written[("analyst", "en")].text, written[("analyst", "en")].agent) == ("Analyst line.", "tactical_analyst")
    assert (written[("fan", "es")].text, written[("fan", "es")].agent) == ("es:Fan line.", "localizer")
    assert written[("analyst", "hi")].text == "hi:Analyst line."
    assert sorted(call["role"] for call in llm.calls) == ["commentator", "localizer", "tactical_analyst"]


async def test_moment_prompt_carries_only_the_facts_of_the_moment(llm):
    await writer(llm).write_moment(moment_ctx(kind="goal", minute=23))
    prompt = next(call["user"] for call in llm.calls if call["role"] == "commentator")
    for expected in ("Northbridge FC", "Harbour City", "Luca Marrowby", "Minute: 23", "goal", "expected goals 0.42"):
        assert expected in prompt
    localized = json.loads(next(call["user"] for call in llm.calls if call["role"] == "localizer"))
    assert localized == {"fan": "Fan line.", "analyst": "Analyst line."}


async def test_fenced_json_with_surrounding_prose_is_still_read(llm):
    body = json.dumps({"es": {"fan": "uno", "analyst": "dos"}, "hi": {"fan": "एक", "analyst": "दो"}}, ensure_ascii=False)
    llm.replies["localizer"] = f"Here is the translation:\n```json\n{body}\n```\nLet me know if you need more."
    written = await writer(llm).write_moment(moment_ctx())
    assert written[("fan", "es")].text == "uno" and written[("analyst", "hi")].text == "दो"


@pytest.mark.parametrize("reply", [
    "I cannot translate that.",
    '{"es": {"fan": "uno", "analyst": "dos"}}',
    '{"es": {"fan": "uno"}, "hi": {"fan": "एक", "analyst": "दो"}}',
    '{"es": "uno", "hi": "एक"}',
    '{"es": {"fan": "uno", "analyst": "dos"}, "hi": {"fan": "एक", "analyst": "दो"',
], ids=["prose", "missing-language", "missing-mode", "wrong-shape", "truncated"])
async def test_unusable_localizer_output_raises_narration_error(llm, reply):
    llm.replies["localizer"] = reply
    with pytest.raises(NarrationError):
        await writer(llm).write_moment(moment_ctx())


async def test_an_empty_agent_reply_raises_narration_error(llm):
    llm.replies["commentator"] = "   "
    with pytest.raises(NarrationError):
        await writer(llm).write_moment(moment_ctx())


async def test_recap_is_written_once_then_localized(llm):
    written = await writer(llm).write_recap(recap_ctx(period="full_time", minute=90))
    assert set(written) == set(VARIANTS)
    english = written[("analyst", "en")]
    assert (english.title, english.bullets, english.text, english.agent) == (
        "Analyst title", ("a1", "a2", "a3"), "Analyst recap.", "recap_writer")
    spanish = written[("fan", "es")]
    assert (spanish.title, spanish.bullets, spanish.agent) == ("es:Fan title", ("es:f1", "es:f2", "es:f3"), "localizer")
    assert [call["role"] for call in llm.calls] == ["recap_writer", "localizer"]
    prompt = llm.calls[0]["user"]
    assert "full time" in prompt and "Northbridge FC 2-1 Harbour City" in prompt and "big chance" in prompt


async def test_recap_writer_prose_raises_narration_error(llm):
    llm.replies["recap_writer"] = "What a match that was!"
    with pytest.raises(NarrationError):
        await writer(llm).write_recap(recap_ctx())


async def test_service_falls_back_to_scripted_when_the_agents_misbehave(llm):
    llm.replies["localizer"] = '{"es": {"fan": "uno", "analyst": ""}, "hi": {"fan": "एक", "analyst": "दो"}}'
    narratives = await NarrationService(ScriptedNarrativeWriter(), writer(llm)).moment(moment_ctx(kind="goal"))
    assert {n.source for n in narratives} == {"scripted"}
    assert next(n for n in narratives if (n.mode, n.language) == ("fan", "en")).text.startswith("GOAL!")


async def test_service_falls_back_when_the_endpoint_is_unreachable():
    dead = AgentNarrativeWriter(base_url="http://127.0.0.1:9/v1", model="fake-model", api_key="test-key")
    narratives = await NarrationService(ScriptedNarrativeWriter(), dead, timeout_s=3).moment(moment_ctx())
    assert {n.source for n in narratives} == {"scripted"}


def test_parse_json_reads_plain_fenced_and_wrapped_objects():
    assert parse_json('{"a": 1}') == {"a": 1}
    assert parse_json('```json\n{"a": {"b": "c"}}\n```') == {"a": {"b": "c"}}
    assert parse_json('Sure. {"a": "x}y"} Done.') == {"a": "x}y"}


@pytest.mark.parametrize("text", ["", "no json here", "[1, 2]", '{"a": ', "} {"])
def test_parse_json_rejects_anything_that_is_not_an_object(text):
    with pytest.raises(NarrationError):
        parse_json(text)
