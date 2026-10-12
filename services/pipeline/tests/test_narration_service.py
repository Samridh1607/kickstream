import pytest

from kickstream.adapters.scripted_writer import ScriptedNarrativeWriter
from kickstream.domain.types import VARIANTS
from kickstream.narration.budget import Budget
from kickstream.narration.cache import DiskCache
from kickstream.narration.service import MOMENT_COST, RECAP_COST, NarrationService
from kickstream.ports.writer import NarrationError
from tests.factories import MATCH, FakeWriter, moment_ctx, recap_ctx


def service(primary=None, **kwargs):
    return NarrationService(ScriptedNarrativeWriter(), primary, **kwargs)


def sources(items):
    return {item.source for item in items}


async def test_without_a_primary_writer_everything_is_scripted():
    narratives = await service().moment(moment_ctx(kind="goal", minute=23))
    assert {(n.mode, n.language) for n in narratives} == set(VARIANTS)
    assert sources(narratives) == {"scripted"} and {n.agent for n in narratives} == {"scripted"}
    first = next(n for n in narratives if (n.mode, n.language) == ("fan", "en"))
    assert first.id == f"{MATCH}-k1-fan-en" and first.moment_id == f"{MATCH}-k1" and first.minute == 23
    assert first.evidence == [f"{MATCH}-k1", f"{MATCH}-e40", f"{MATCH}-s23"]
    assert (first.team, first.player_id) == ("home", "nbr-9")


async def test_primary_writer_output_is_used_and_attributed():
    primary = FakeWriter()
    narratives = await service(primary).moment(moment_ctx())
    assert sources(narratives) == {"agent"}
    assert {n.agent for n in narratives if n.mode == "fan"} == {"commentator"}
    assert {n.agent for n in narratives if n.mode == "analyst"} == {"tactical_analyst"}
    assert next(n for n in narratives if (n.mode, n.language) == ("analyst", "hi")).text == "analyst-hi text"


async def test_cache_replays_without_calling_the_writer_or_spending_budget(tmp_path):
    primary, budget = FakeWriter(), Budget(max_calls=MOMENT_COST, reserve=0, min_gap_s=0)
    cached = service(primary, cache=DiskCache(tmp_path), budget=budget)
    first = await cached.moment(moment_ctx())
    second = await cached.moment(moment_ctx())
    assert primary.calls == 1
    assert [n.model_dump() for n in first] == [n.model_dump() for n in second]
    assert sources(second) == {"agent"}
    assert sources(await cached.moment(moment_ctx(n=2, minute=50))) == {"scripted"}, "budget is spent"


async def test_cache_key_depends_on_the_model_name(tmp_path):
    cache, other = DiskCache(tmp_path), FakeWriter()
    other.model = "another-model"
    await service(FakeWriter(), cache=cache).moment(moment_ctx())
    await service(other, cache=cache).moment(moment_ctx())
    assert other.calls == 1


@pytest.mark.parametrize(
    "primary",
    [
        FakeWriter(fail=NarrationError("malformed")),
        FakeWriter(fail=RuntimeError("rate limited")),
        FakeWriter(drop=("fan", "hi")),
        FakeWriter(blank=("analyst", "es")),
    ],
    ids=["narration-error", "provider-error", "missing-variant", "blank-variant"],
)
async def test_any_incomplete_or_failed_result_falls_back_whole(primary, tmp_path):
    cache = DiskCache(tmp_path)
    narratives = await service(primary, cache=cache).moment(moment_ctx())
    assert len(narratives) == 6 and sources(narratives) == {"scripted"}
    assert all(n.text.strip() for n in narratives)
    assert list(tmp_path.iterdir()) == [], "a failed result must not be cached"


async def test_a_slow_writer_times_out_to_scripted():
    narratives = await service(FakeWriter(delay=0.5), timeout_s=0.01).moment(moment_ctx())
    assert sources(narratives) == {"scripted"}


async def test_an_unreadable_cache_entry_is_ignored(tmp_path):
    primary, cache = FakeWriter(), DiskCache(tmp_path)
    await service(primary, cache=cache).moment(moment_ctx())
    [entry] = tmp_path.iterdir()
    entry.write_text('{"fan:en": {"wrong": 1}}', encoding="utf-8")
    assert sources(await service(primary, cache=cache).moment(moment_ctx())) == {"agent"}
    assert primary.calls == 2


async def test_recap_builds_six_recaps_with_score_and_ids():
    recaps = await service(FakeWriter()).recap(recap_ctx(period="full_time", minute=90))
    assert {(r.mode, r.language) for r in recaps} == set(VARIANTS)
    first = next(r for r in recaps if (r.mode, r.language) == ("fan", "en"))
    assert first.id == f"{MATCH}-r-full_time-fan-en"
    assert (first.period, first.minute, first.score_home, first.score_away) == ("full_time", 90, 2, 1)
    assert first.source == "agent" and first.agent == "recap_writer" and len(first.bullets) == 3


async def test_recap_with_a_blank_bullet_falls_back():
    class BlankBullet(FakeWriter):
        async def write_recap(self, ctx):
            written = await super().write_recap(ctx)
            item = written[("fan", "en")]
            written[("fan", "en")] = type(item)(item.title, ("a", " ", "c"), item.text, item.agent)
            return written

    assert sources(await service(BlankBullet()).recap(recap_ctx())) == {"scripted"}


async def test_scripted_moment_never_touches_the_primary_writer():
    primary = FakeWriter()
    assert sources(await service(primary).scripted_moment(moment_ctx())) == {"scripted"}
    assert primary.calls == 0


def test_budget_caps_calls_per_match():
    budget = Budget(max_calls=5, reserve=0, min_gap_s=0)
    assert budget.try_spend("a", MOMENT_COST, priority=True)
    assert not budget.try_spend("a", MOMENT_COST, priority=True)
    assert budget.try_spend("a", RECAP_COST, priority=True)
    assert budget.try_spend("b", MOMENT_COST, priority=True), "each match has its own budget"


def test_budget_keeps_a_reserve_for_goals_and_recaps():
    budget = Budget(max_calls=9, reserve=6, min_gap_s=0)
    assert budget.try_spend("a", MOMENT_COST, priority=False)
    assert not budget.try_spend("a", MOMENT_COST, priority=False), "would eat into the reserve"
    assert budget.try_spend("a", MOMENT_COST, priority=True)
    assert budget.try_spend("a", MOMENT_COST, priority=True)
    assert not budget.try_spend("a", RECAP_COST, priority=True)


def test_budget_spaces_out_non_priority_calls():
    clock = [100.0]
    budget = Budget(max_calls=100, reserve=0, min_gap_s=5, now=lambda: clock[0])
    assert budget.try_spend("a", MOMENT_COST, priority=False)
    clock[0] = 103.0
    assert not budget.try_spend("a", MOMENT_COST, priority=False)
    assert budget.try_spend("a", MOMENT_COST, priority=True), "goals and recaps ignore the gap"
    clock[0] = 108.5
    assert budget.try_spend("a", MOMENT_COST, priority=False)


def test_disk_cache_round_trips_and_tolerates_missing_or_corrupt_files(tmp_path):
    cache = DiskCache(tmp_path / "nested")
    assert cache.get("absent") is None
    cache.put("k", {"fan:hi": {"text": "गोल!", "agent": "commentator"}})
    assert cache.get("k") == {"fan:hi": {"text": "गोल!", "agent": "commentator"}}
    (tmp_path / "nested" / "k.json").write_text("{not json", encoding="utf-8")
    assert cache.get("k") is None
