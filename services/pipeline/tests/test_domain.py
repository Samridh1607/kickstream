from kickstream.contracts import StatFact
from kickstream.domain.labels import FACT_LABELS, KIND_LABELS, fact_text
from kickstream.domain.pitch import COLS, ROWS, attacking_third, attacking_x, xg, zone_index
from kickstream.domain.teams import AWAY, HOME, find_player
from kickstream.domain.types import LANGUAGES, VARIANTS, other


def test_variants_cover_every_mode_and_language_once():
    assert len(VARIANTS) == 6
    assert len(set(VARIANTS)) == 6
    assert ("analyst", "hi") in VARIANTS
    assert other("home") == "away" and other("away") == "home"


def test_attacking_x_mirrors_for_the_away_side():
    assert attacking_x("home", 80) == 80
    assert attacking_x("away", 80) == 20


def test_zone_index_covers_the_grid_without_overflow():
    assert zone_index(0, 0) == 0
    assert zone_index(100, 100) == COLS * ROWS - 1
    assert zone_index(99.9, 0) == COLS - 1
    assert zone_index(0, 99.9) == (ROWS - 1) * COLS


def test_attacking_third_is_the_last_two_columns_in_attack_direction():
    assert set(attacking_third("home")) == {r * COLS + c for r in range(ROWS) for c in (4, 5)}
    assert set(attacking_third("away")) == {r * COLS + c for r in range(ROWS) for c in (0, 1)}


def test_xg_rewards_distance_and_angle_and_stays_in_bounds():
    assert xg(94, 50) > xg(80, 50) > xg(60, 50)
    assert xg(90, 50) > xg(90, 10)
    for ax in (0, 50, 99.9, 100):
        for y in (0, 50, 100):
            assert 0.01 <= xg(ax, y) <= 0.95


def test_team_sheets_are_complete_and_distinct():
    for sheet in (HOME, AWAY):
        assert len(sheet.players) == 14
        assert [p.position for p in sheet.players[:11]].count("GK") == 1
        assert len({p.id for p in sheet.players}) == 14
    assert HOME.id != AWAY.id
    assert not {p.id for p in HOME.players} & {p.id for p in AWAY.players}


def test_find_player_returns_none_for_unknown_or_missing_ids():
    first = HOME.players[0]
    assert find_player((HOME, AWAY), first.id) == first
    assert find_player((HOME, AWAY), "nobody") is None
    assert find_player((HOME, AWAY), None) is None


def test_labels_exist_for_every_language():
    for language in LANGUAGES:
        assert set(FACT_LABELS[language]) == set(FACT_LABELS["en"])
        assert set(KIND_LABELS[language]) == {"goal", "red_card", "big_chance", "momentum_swing", "sustained_pressure"}


def test_fact_text_localizes_labels_and_trims_whole_numbers():
    facts = [StatFact(label="xg", value=0.42), StatFact(label="shots", value=7.0)]
    assert fact_text(facts, "en") == "expected goals 0.42, shots 7"
    assert fact_text(facts, "es") == "goles esperados 0.42, remates 7"
    assert fact_text([], "en") == ""
