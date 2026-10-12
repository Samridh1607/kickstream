import pytest

from kickstream.adapters.scripted_writer import ScriptedNarrativeWriter
from kickstream.domain.types import VARIANTS
from tests.factories import moment_ctx, recap_ctx

KINDS = ["goal", "red_card", "big_chance", "momentum_swing", "sustained_pressure"]


@pytest.mark.parametrize("kind", KINDS)
async def test_every_kind_is_written_in_all_six_variants(kind):
    written = await ScriptedNarrativeWriter().write_moment(moment_ctx(kind=kind))
    assert set(written) == set(VARIANTS)
    for item in written.values():
        assert item.text.strip() and item.agent == "scripted"
        assert "{" not in item.text and "}" not in item.text


async def test_goal_text_names_player_team_minute_and_score():
    written = await ScriptedNarrativeWriter().write_moment(moment_ctx(kind="goal", minute=23))
    fan = written[("fan", "en")].text
    assert fan.startswith("GOAL!")
    assert "Luca Marrowby" in fan and "Northbridge FC" in fan and "23" in fan and "1-0" in fan
    assert written[("fan", "es")].text.startswith("¡GOL!")
    assert written[("fan", "hi")].text.startswith("गोल!")


async def test_analyst_text_cites_the_localized_facts():
    written = await ScriptedNarrativeWriter().write_moment(moment_ctx(kind="goal"))
    assert "The goal reflects the balance of play: expected goals 0.42" in written[("analyst", "en")].text
    assert "goles esperados 0.42" in written[("analyst", "es")].text
    assert "अपेक्षित गोल 0.42" in written[("analyst", "hi")].text


async def test_moment_without_a_player_falls_back_to_the_team_name():
    ctx = moment_ctx(kind="red_card", player_id=None)
    assert ctx.player_name is None
    text = (await ScriptedNarrativeWriter().write_moment(ctx))[("fan", "en")].text
    assert "None" not in text and "Northbridge FC" in text


async def test_away_moments_use_the_away_team_name():
    text = (await ScriptedNarrativeWriter().write_moment(moment_ctx(kind="sustained_pressure", team="away")))[
        ("fan", "en")
    ].text
    assert text.startswith("Harbour City")


async def test_recap_has_title_three_bullets_and_text_in_every_variant():
    written = await ScriptedNarrativeWriter().write_recap(recap_ctx())
    assert set(written) == set(VARIANTS)
    for item in written.values():
        assert item.title.strip() and item.text.strip() and item.agent == "scripted"
        assert len(item.bullets) == 3 and all(b.strip() for b in item.bullets)
    english = written[("fan", "en")]
    assert english.title == "Half-time: Northbridge FC 2-1 Harbour City"
    assert english.bullets[0] == "Northbridge FC lead 2-1."
    assert "9-4" in english.bullets[1] and "58%-42%" in english.bullets[1]
    assert "1.7-0.6" in english.bullets[2]
    assert written[("fan", "en")].text != written[("analyst", "en")].text


async def test_full_time_titles_and_level_scores():
    written = await ScriptedNarrativeWriter().write_recap(recap_ctx(period="full_time", minute=90))
    assert written[("fan", "en")].title.startswith("Full-time:")
    assert written[("fan", "es")].title.startswith("Final:")
    assert written[("fan", "hi")].title.startswith("फुल टाइम:")

    ctx = recap_ctx()
    level = ctx.stats.model_copy(update={"away": ctx.stats.away.model_copy(update={"goals": 2})})
    from dataclasses import replace

    written = await ScriptedNarrativeWriter().write_recap(replace(ctx, stats=level))
    assert written[("fan", "en")].bullets[0] == "Northbridge FC and Harbour City are level at 2-2."
