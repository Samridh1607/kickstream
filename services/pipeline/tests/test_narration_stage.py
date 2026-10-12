import asyncio

from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.adapters.scripted_writer import ScriptedNarrativeWriter
from kickstream.contracts import MatchStatus, Narrative, Recap
from kickstream.domain.teams import AWAY, HOME
from kickstream.narration.service import NarrationService
from kickstream.narration.stage import NarrationStage
from kickstream.ports.bus import INSIGHTS, NARRATIVES, STATUS
from tests.factories import MATCH, FakeWriter, moment, stats, team_stats

STATUS_LIVE = MatchStatus(
    match_id=MATCH, state="live", minute=0, score_home=0, score_away=0, speed=30, home=HOME, away=AWAY
)


async def start(primary=None, max_pending=4):
    bus = InMemoryEventBus()
    out = bus.subscribe(NARRATIVES, maxsize=1000)
    stage = NarrationStage(bus, NarrationService(ScriptedNarrativeWriter(), primary), max_pending=max_pending)
    task = asyncio.create_task(stage.run())
    await bus.publish(STATUS, MATCH, STATUS_LIVE)
    return bus, out, task


async def take(out, count):
    return [(await asyncio.wait_for(anext(aiter(out)), 2)).payload for _ in range(count)]


async def test_a_key_moment_becomes_six_narratives_with_the_player_named():
    bus, out, task = await start()
    await bus.publish(INSIGHTS, MATCH, stats(minute=9))
    await bus.publish(INSIGHTS, MATCH, moment(1, player_id="nbr-9"))
    narratives = await take(out, 6)
    task.cancel()
    assert all(isinstance(n, Narrative) for n in narratives)
    english = next(n for n in narratives if (n.mode, n.language) == ("fan", "en"))
    assert "Luca Marrowby" in english.text
    assert english.evidence == [f"{MATCH}-k1", f"{MATCH}-s9"], "cites the latest stats snapshot"


async def test_a_period_end_snapshot_becomes_six_recaps_over_the_moments_so_far():
    bus, out, task = await start()
    await bus.publish(INSIGHTS, MATCH, moment(1))
    await take(out, 6)
    await bus.publish(INSIGHTS, MATCH, stats(minute=45, period_end="half_time", home=team_stats(goals=1)))
    recaps = await take(out, 6)
    task.cancel()
    assert all(isinstance(r, Recap) and r.period == "half_time" for r in recaps)
    english = next(r for r in recaps if (r.mode, r.language) == ("fan", "en"))
    assert english.score_home == 1 and "1 key moments" in english.text


async def test_ordinary_snapshots_do_not_produce_recaps():
    bus, out, task = await start()
    await bus.publish(INSIGHTS, MATCH, stats(minute=12))
    await bus.publish(INSIGHTS, MATCH, moment(1))
    assert all(isinstance(n, Narrative) for n in await take(out, 6))
    task.cancel()


async def test_when_the_queue_is_full_the_oldest_waiting_moment_is_scripted():
    gate = asyncio.Event()
    bus, out, task = await start(primary=FakeWriter(gate=gate), max_pending=4)
    for n in range(1, 7):
        await bus.publish(INSIGHTS, MATCH, moment(n, minute=n))
        await asyncio.sleep(0.01)
    early = await take(out, 6)
    assert {n.moment_id for n in early} == {f"{MATCH}-k2"}, "k1 is being written; k2 is the oldest waiting"
    assert {n.source for n in early} == {"scripted"}
    gate.set()
    rest = await take(out, 30)
    task.cancel()
    assert {n.moment_id for n in rest} == {f"{MATCH}-k{n}" for n in (1, 3, 4, 5, 6)}
    assert {n.source for n in rest} == {"agent"}


async def test_a_waiting_goal_is_spared_while_a_lesser_moment_can_be_evicted():
    gate = asyncio.Event()
    bus, out, task = await start(primary=FakeWriter(gate=gate), max_pending=2)
    kinds = ["big_chance", "goal", "sustained_pressure", "big_chance"]
    for n, kind in enumerate(kinds, start=1):
        await bus.publish(INSIGHTS, MATCH, moment(n, kind=kind, minute=n))
        await asyncio.sleep(0.01)
    early = await take(out, 6)
    assert {n.moment_id for n in early} == {f"{MATCH}-k3"}, "k1 is being written; k2 is a goal; k3 is evicted"
    gate.set()
    rest = await take(out, 18)
    task.cancel()
    assert {n.source for n in rest if n.moment_id == f"{MATCH}-k2"} == {"agent"}


async def test_a_moment_for_an_unknown_match_is_skipped_without_stopping_the_stage():
    bus, out, task = await start()
    stray = moment(1).model_copy(update={"match_id": "m-9", "id": "m-9-k1"})
    await bus.publish(INSIGHTS, "m-9", stray)
    await bus.publish(INSIGHTS, MATCH, moment(2))
    narratives = await take(out, 6)
    task.cancel()
    assert {n.moment_id for n in narratives} == {f"{MATCH}-k2"}
