import asyncio

from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.contracts import (LowerThirdData, MatchStatus, Narrative, Overlay, PressureMapData, PressureSnapshot,
                                  Recap, RecapCardData, StatCardData)
from kickstream.domain.teams import AWAY, HOME
from kickstream.overlay.build import lower_third, pressure_map, recap_card, stat_card
from kickstream.overlay.stage import OverlayStage
from kickstream.ports.bus import INSIGHTS, NARRATIVES, OVERLAYS, STATUS

from tests.factories import MATCH, moment, stats, team_stats


def narrative(mode="fan", language="en", n=1) -> Narrative:
    return Narrative(id=f"{MATCH}-k{n}-{mode}-{language}", match_id=MATCH, minute=10, moment_id=f"{MATCH}-k{n}",
                     mode=mode, language=language, text="GOAL! What a strike.", source="scripted", agent="scripted",
                     evidence=[f"{MATCH}-k{n}"], team="home", player_id="nbr-9")


def recap(mode="fan", language="en", period="half_time") -> Recap:
    return Recap(id=f"{MATCH}-r-{period}-{mode}-{language}", match_id=MATCH, minute=45, period=period, mode=mode,
                 language=language, title="Half-time: Northbridge FC 2-1 Harbour City", bullets=["a", "b", "c"],
                 text="t", source="scripted", agent="scripted", score_home=2, score_away=1)


def heat(minute=10) -> PressureSnapshot:
    return PressureSnapshot(id=f"{MATCH}-p{minute}", match_id=MATCH, minute=minute, cols=6, rows=4,
                            home=[1.0] * 24, away=[0.5] * 24)


def test_lower_third_pairs_a_localized_headline_with_the_narrative():
    overlay = lower_third("o1", narrative(language="es"), moment(1, kind="goal"), "Northbridge FC")
    assert (overlay.kind, overlay.language, overlay.minute) == ("lower_third", "es", 10)
    assert overlay.data == LowerThirdData(headline="GOL", subline="GOAL! What a strike.", team="Northbridge FC", minute=10)
    assert overlay.sources == [f"{MATCH}-k1-fan-es", f"{MATCH}-k1"]
    assert overlay.duration_ms > 0


def test_stat_card_has_four_localized_rows():
    snapshot = stats(minute=15, home=team_stats(possession=61.5, shots=7, shots_on_target=3, xg=1.24),
                     away=team_stats(possession=38.5, shots=2, shots_on_target=1, xg=0.3))
    english, hindi = stat_card("o1", snapshot, "en"), stat_card("o2", snapshot, "hi")
    assert isinstance(english.data, StatCardData)
    assert [(r.label, r.home, r.away) for r in english.data.stat_rows] == [
        ("Possession %", 61.5, 38.5), ("Shots", 7, 2), ("Shots on target", 3, 1), ("Expected goals", 1.24, 0.3)]
    assert hindi.language == "hi" and hindi.data.stat_rows[1].label == "शॉट"
    assert english.sources == [snapshot.id]


def test_pressure_map_copies_the_grid_and_has_no_language():
    overlay = pressure_map("o1", heat())
    assert overlay.language is None
    assert overlay.data == PressureMapData(cols=6, rows=4, home=[1.0] * 24, away=[0.5] * 24)


def test_recap_card_carries_title_score_and_bullets():
    overlay = recap_card("o1", recap())
    assert overlay.data == RecapCardData(title="Half-time: Northbridge FC 2-1 Harbour City", score="2-1", bullets=["a", "b", "c"])
    assert overlay.language == "en" and overlay.sources == [f"{MATCH}-r-half_time-fan-en"]


def test_every_overlay_survives_a_json_round_trip():
    snapshot = stats(minute=15)
    for overlay in (lower_third("o1", narrative(), moment(1), "Northbridge FC"), stat_card("o2", snapshot, "en"),
                    pressure_map("o3", heat()), recap_card("o4", recap())):
        assert Overlay.model_validate_json(overlay.model_dump_json()) == overlay


async def collect(publish, expected):
    bus = InMemoryEventBus()
    out = bus.subscribe(OVERLAYS, maxsize=1000)
    task = asyncio.create_task(OverlayStage(bus).run())
    await bus.publish(STATUS, MATCH, MatchStatus(match_id=MATCH, state="live", minute=0, score_home=0, score_away=0,
                                                 speed=30, home=HOME, away=AWAY))
    await publish(bus)
    overlays = [(await asyncio.wait_for(anext(aiter(out)), 2)).payload for _ in range(expected)]
    await asyncio.sleep(0.05)
    task.cancel()
    assert out.queue.empty(), "the stage emitted more overlays than expected"
    return overlays


async def test_stage_builds_lower_thirds_from_fan_narratives_only():
    async def publish(bus):
        await bus.publish(INSIGHTS, MATCH, moment(1, kind="red_card", team="away"))
        await bus.publish(NARRATIVES, MATCH, narrative("analyst", "en"))
        await bus.publish(NARRATIVES, MATCH, narrative("fan", "en"))
        await bus.publish(NARRATIVES, MATCH, narrative("fan", "hi"))

    english, hindi = await collect(publish, 2)
    assert (english.id, hindi.id) == (f"{MATCH}-o1", f"{MATCH}-o2")
    assert (english.data.headline, english.data.team) == ("RED CARD", "Harbour City")
    assert hindi.data.headline == "रेड कार्ड"


async def test_stage_skips_a_narrative_whose_moment_it_never_saw():
    async def publish(bus):
        await bus.publish(NARRATIVES, MATCH, narrative("fan", "en", n=7))
        await bus.publish(INSIGHTS, MATCH, heat(3))

    [only] = await collect(publish, 1)
    assert only.kind == "pressure_map"


async def test_stage_emits_stat_cards_every_five_minutes_and_at_period_ends():
    async def publish(bus):
        for minute in (4, 5, 6):
            await bus.publish(INSIGHTS, MATCH, stats(minute=minute))
        await bus.publish(INSIGHTS, MATCH, stats(minute=47, period_end="half_time"))

    overlays = await collect(publish, 6)
    assert [(o.kind, o.minute, o.language) for o in overlays] == [
        ("stat_card", 5, "en"), ("stat_card", 5, "es"), ("stat_card", 5, "hi"),
        ("stat_card", 47, "en"), ("stat_card", 47, "es"), ("stat_card", 47, "hi")]


async def test_stage_emits_recap_cards_for_fan_recaps_only():
    async def publish(bus):
        await bus.publish(NARRATIVES, MATCH, recap("analyst", "en"))
        await bus.publish(NARRATIVES, MATCH, recap("fan", "es"))

    [card] = await collect(publish, 1)
    assert (card.kind, card.language) == ("recap_card", "es")
