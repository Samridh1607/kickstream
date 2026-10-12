import asyncio

import pytest

from kickstream.adapters.json_record_store import JsonRecordStore
from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.audience import rules
from kickstream.audience.context import MatchTracker
from kickstream.audience.rules import AudienceError
from kickstream.audience.service import AudienceService
from kickstream.audience.stage import AudienceStage
from kickstream.contracts import MatchStatus, Narrative
from kickstream.domain.teams import AWAY, HOME
from kickstream.ports.bus import INSIGHTS, NARRATIVES, STATUS

from tests.factories import MATCH, moment, stats

ANN, BEN = "voter-ann-0000001", "voter-ben-0000002"


class FakeNow:
    def __init__(self, at=1_000.0):
        self.at = at

    def __call__(self):
        return self.at


class FakeExpert:
    def __init__(self, answer="Fresh legs for the press.", fail=None, gate=None):
        self.answer_text, self.fail, self.gate = answer, fail, gate
        self.asked = []

    async def answer(self, question, ctx, language):
        self.asked.append((question, ctx, language))
        if self.gate is not None:
            await self.gate.wait()
        if self.fail is not None:
            raise self.fail
        return self.answer_text


def make(tmp_path, **kwargs):
    now = kwargs.pop("now", FakeNow())
    service = AudienceService(JsonRecordStore(tmp_path / "audience.json"), now=now,
                              push_interval_s=kwargs.pop("push_interval_s", 0.05),
                              save_interval_s=kwargs.pop("save_interval_s", 0.05), **kwargs)
    return service, now


async def with_question(service, voter=ANN, text="Why the change?"):
    return await service.ask(voter, text, "Ann")


async def settle(condition, timeout=2.0):
    for _ in range(int(timeout / 0.01)):
        if condition():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition was not met in time")


# --- loading and saving ----------------------------------------------------------------------

async def test_a_new_audience_is_empty_and_views_carry_the_server_time(tmp_path):
    service, now = make(tmp_path)
    view = service.view(studio=False)
    assert (view.poll, view.questions, view.revision, view.server_time) == (None, [], 0, 1_000.0)
    now.at = 1_050.0
    assert service.view(studio=True).server_time == 1_050.0


async def test_structural_changes_are_saved_before_the_call_returns(tmp_path):
    service, _ = make(tmp_path)
    await service.create_poll("Who will win?", ["A", "B"], None)
    again, _ = make(tmp_path)
    assert again.view(studio=False).poll.question == "Who will win?" and again.view(studio=False).revision == 1


async def test_votes_are_held_in_memory_until_the_next_flush(tmp_path):
    service, _ = make(tmp_path)
    await service.create_poll("Who will win?", ["A", "B"], None)
    option = service.view(studio=False).poll.options[0].id
    await service.vote(ANN, option)
    assert service.view(studio=False).poll.options[0].votes == 1
    assert make(tmp_path)[0].view(studio=False).poll.options[0].votes == 0, "not yet on disk"
    await service.flush()
    restarted, _ = make(tmp_path)
    assert restarted.view(studio=False).poll.options[0].votes == 1
    await restarted.vote(ANN, option)
    assert restarted.view(studio=False).poll.options[0].votes == 1, "the same browser is still remembered after a restart"


async def test_the_run_loop_flushes_votes_within_the_save_interval(tmp_path):
    service, _ = make(tmp_path, save_interval_s=0.05)
    await service.create_poll("Who will win?", ["A", "B"], None)
    option = service.view(studio=False).poll.options[0].id
    loop = asyncio.create_task(service.run())
    for n in range(20):
        await service.vote(f"voter-number-{n:07d}", option)
        await asyncio.sleep(0.005)
    await settle(lambda: make(tmp_path)[0].view(studio=False).poll.options[0].votes == 20)
    loop.cancel()


async def test_a_vote_batch_that_fails_to_save_is_kept_and_saved_later(tmp_path):
    service, _ = make(tmp_path)
    await service.create_poll("Who will win?", ["A", "B"], None)
    await service.vote(ANN, service.view(studio=False).poll.options[0].id)
    blocker = tmp_path / "audience.tmp"
    blocker.mkdir()
    await service.flush()
    assert service.view(studio=False).poll.options[0].votes == 1, "still counted in memory"
    blocker.rmdir()
    await service.flush()
    assert make(tmp_path)[0].view(studio=False).poll.options[0].votes == 1


async def test_a_structural_change_that_cannot_be_saved_is_refused_and_not_applied(tmp_path):
    service, _ = make(tmp_path)
    (tmp_path / "audience.tmp").mkdir()
    with pytest.raises(AudienceError, check=lambda e: e.status == 503):
        await service.create_poll("Who will win?", ["A", "B"], None)
    assert service.view(studio=False).poll is None and service.view(studio=False).revision == 0


async def test_a_record_the_rules_cannot_load_is_set_aside_and_the_audience_starts_empty(tmp_path):
    JsonRecordStore(tmp_path / "audience.json").save({"doc": {"revision": "soon"}})
    service, _ = make(tmp_path)
    assert service.view(studio=False).revision == 0
    assert (tmp_path / "audience.json.corrupt").exists()


async def test_a_refused_change_leaves_the_state_alone(tmp_path):
    service, _ = make(tmp_path)
    with pytest.raises(AudienceError, check=lambda e: e.status == 409):
        await service.vote(ANN, "nope")
    assert service.view(studio=False).revision == 0


# --- pushes ----------------------------------------------------------------------------------

async def test_a_burst_of_votes_reaches_a_page_as_a_few_pushes_ending_with_the_final_counts(tmp_path):
    service, _ = make(tmp_path, push_interval_s=0.2)
    await service.create_poll("Who will win?", ["A", "B"], None)
    option = service.view(studio=False).poll.options[0].id
    received = []

    async def page():
        async for view in service.changes(studio=False):
            received.append(view.poll.options[0].votes)

    reader = asyncio.create_task(page())
    await asyncio.sleep(0.01)
    for n in range(300):
        await service.vote(f"voter-number-{n:07d}", option)
    await asyncio.sleep(0.5)
    reader.cancel()
    assert received[0] == 0 and received[-1] == 300
    assert len(received) <= 4, f"300 votes became {len(received)} pushes"


async def test_fans_and_the_studio_get_their_own_views(tmp_path):
    service, _ = make(tmp_path)
    question = await with_question(service)
    await service.apply(lambda s: rules.hide(s, question))
    fan, studio = service.changes(studio=False), service.changes(studio=True)
    assert (await anext(fan)).questions == []
    assert [q.id for q in (await anext(studio)).questions] == [question]
    await fan.aclose()
    await studio.aclose()
    assert service._listeners == set()


# --- deadlines -------------------------------------------------------------------------------

async def test_a_timed_poll_closes_when_its_time_comes(tmp_path):
    service, now = make(tmp_path)
    await service.create_poll("Who will win?", ["A", "B"], 60)
    now.at += 59
    await service.tick()
    assert service.view(studio=False).poll.state == "open"
    now.at += 1
    await service.tick()
    assert service.view(studio=False).poll.state == "closed"
    assert make(tmp_path)[0].view(studio=False).poll.state == "closed", "closing is saved"


async def test_a_poll_that_ended_while_the_server_was_down_is_closed_on_start(tmp_path):
    first, now = make(tmp_path)
    await first.create_poll("Who will win?", ["A", "B"], 60)
    later, _ = make(tmp_path, now=FakeNow(now.at + 3_600))
    await later.tick()
    assert later.view(studio=False).poll.state == "closed"


# --- the expert ------------------------------------------------------------------------------

async def test_asking_the_expert_fills_the_draft_in_the_program_language(tmp_path):
    expert = FakeExpert()
    service, _ = make(tmp_path, expert=expert, context=lambda: "match-context", language=lambda: "es")
    question = await with_question(service)
    await service.ask_expert(question)
    assert service.view(studio=True).draft.state in ("writing", "ready")
    await settle(lambda: service.view(studio=True).draft.state == "ready")
    assert service.view(studio=True).draft.text == "Fresh legs for the press."
    assert expert.asked == [("Why the change?", "match-context", "es")]
    assert service.view(studio=False).draft is None, "fans never see the draft"
    assert service.expert_available is True


async def test_with_no_expert_the_draft_is_left_for_the_streamer(tmp_path):
    service, _ = make(tmp_path)
    question = await with_question(service)
    await service.ask_expert(question)
    assert service.view(studio=True).draft.model_dump() == {"question_id": question, "text": "", "state": "unavailable"}
    assert service.expert_available is False


@pytest.mark.parametrize("expert, timeout", [(FakeExpert(fail=RuntimeError("rate limited")), 20.0), (FakeExpert(gate=asyncio.Event()), 0.05)],
                         ids=["fails", "too-slow"])
async def test_an_expert_that_fails_or_is_too_slow_leaves_the_draft_unavailable(tmp_path, expert, timeout):
    service, _ = make(tmp_path, expert=expert, expert_timeout_s=timeout)
    question = await with_question(service)
    await service.ask_expert(question)
    await settle(lambda: service.view(studio=True).draft.state == "unavailable")
    assert service.view(studio=True).draft.text == ""


async def test_an_answer_for_a_draft_the_streamer_moved_on_from_never_appears(tmp_path):
    gate = asyncio.Event()
    expert = FakeExpert(answer="Late answer.", gate=gate)
    service, _ = make(tmp_path, expert=expert)
    first = await with_question(service)
    second = await with_question(service, voter=BEN, text="Who is pressing?")

    await service.ask_expert(first)
    await service.apply(rules.discard_draft)
    await service.ask_expert(second)
    await service.apply(lambda s: rules.set_draft_text(s, "Typed by the streamer."))
    gate.set()
    await settle(lambda: len(expert.asked) == 2)
    await asyncio.sleep(0.05)
    draft = service.view(studio=True).draft
    assert (draft.question_id, draft.text) == (second, "Typed by the streamer.")


async def test_an_answer_goes_on_air_and_fans_see_it_under_the_question(tmp_path):
    service, now = make(tmp_path)
    question = await with_question(service)
    await service.ask_expert(question)
    await service.apply(lambda s: rules.set_draft_text(s, "Fresh legs."))
    await service.air(30)
    fan = service.view(studio=False)
    assert (fan.qa.answer, fan.qa.ends_at, fan.questions[0].answer) == ("Fresh legs.", now.at + 30, "Fresh legs.")
    now.at += 30
    await service.tick()
    assert service.view(studio=False).qa is None and service.view(studio=False).questions[0].answer == "Fresh legs."


async def test_stopping_cancels_a_draft_in_progress_and_saves_pending_votes(tmp_path):
    expert = FakeExpert(gate=asyncio.Event())
    service, _ = make(tmp_path, expert=expert)
    question = await with_question(service)
    await service.upvote(BEN, question)
    await service.ask_expert(question)
    await asyncio.sleep(0.01)
    await service.stop()
    assert service._tasks == set()
    assert make(tmp_path)[0].view(studio=False).questions[0].votes == 2


# --- tracker and stage -----------------------------------------------------------------------

def status(state="live", match_id=MATCH, minute=10, home_goals=0):
    return MatchStatus(match_id=match_id, state=state, minute=minute, score_home=home_goals, score_away=0, speed=30, home=HOME, away=AWAY)


def narrative(n=1, mode="analyst", language="en", text="They score because of the press."):
    return Narrative(id=f"{MATCH}-k{n}-{mode}-{language}", match_id=MATCH, minute=23, moment_id=f"{MATCH}-k{n}", mode=mode,
                     language=language, text=text, source="scripted", agent="scripted", evidence=[], team="home")


def test_the_tracker_has_no_context_before_a_match():
    tracker = MatchTracker()
    assert tracker.context() is None and tracker.teams() is None


def test_the_tracker_builds_the_experts_context_from_match_messages():
    tracker = MatchTracker()
    tracker.observe(MATCH, status())
    tracker.observe(MATCH, stats(minute=20))
    tracker.observe(MATCH, moment(1))
    tracker.observe(MATCH, narrative(1, mode="fan"))
    tracker.observe(MATCH, narrative(1, language="es"))
    tracker.observe(MATCH, narrative(1))
    tracker.observe(MATCH, moment(2, kind="big_chance"))
    tracker.observe(MATCH, status(minute=30, home_goals=1))
    ctx = tracker.context()
    assert (ctx.home, ctx.away, ctx.status.minute, ctx.status.score_home, ctx.stats.minute) == (HOME, AWAY, 30, 1, 20)
    assert [(m.id, text) for m, text in ctx.moments] == [(f"{MATCH}-k1", "They score because of the press."), (f"{MATCH}-k2", None)]
    assert tracker.teams() == ("Northbridge FC", "Harbour City")


def test_the_tracker_moves_to_a_new_match_and_ignores_stragglers_from_the_old_one():
    tracker = MatchTracker()
    tracker.observe(MATCH, status())
    tracker.observe(MATCH, moment(1))
    tracker.observe("m-2", status(match_id="m-2", minute=0))
    tracker.observe(MATCH, moment(2))
    tracker.observe(MATCH, status(state="abandoned"))
    ctx = tracker.context()
    assert ctx.status.match_id == "m-2" and ctx.moments == () and ctx.stats is None


def test_an_abandoned_status_for_an_unknown_match_does_not_become_the_context():
    tracker = MatchTracker()
    tracker.observe("m-0", status(state="abandoned", match_id="m-0"))
    assert tracker.context() is None


async def test_the_stage_feeds_the_tracker_from_the_bus():
    bus, tracker = InMemoryEventBus(), MatchTracker()
    task = asyncio.create_task(AudienceStage(bus, tracker).run())
    await bus.publish(STATUS, MATCH, status())
    await bus.publish(INSIGHTS, MATCH, moment(1))
    await bus.publish(NARRATIVES, MATCH, narrative(1))
    await asyncio.sleep(0.02)
    task.cancel()
    assert [text for _, text in tracker.context().moments] == ["They score because of the press."]
