from kickstream.domain.demo import DEMO_SEED
from kickstream.tools.find_demo_seed import summarize


def test_demo_seed_gives_a_watchable_match():
    goals, key_moments = summarize(DEMO_SEED)
    assert 2 <= goals <= 5
    assert 10 <= len(key_moments) <= 20
    assert len({m.kind for m in key_moments}) >= 3
    assert any(m.kind == "goal" and m.minute < 45 for m in key_moments), (
        "a first-half goal keeps the demo lively"
    )
