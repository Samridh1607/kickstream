from pathlib import Path

import pytest
from pydantic import ValidationError

from kickstream.tools.gen_contracts import TARGET, render


def _normalized(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def test_generated_contracts_are_current(tmp_path):
    fresh = tmp_path / "contracts.py"
    render(fresh)
    assert _normalized(fresh) == _normalized(TARGET), "run: uv run python -m kickstream.tools.gen_contracts"


def test_match_event_accepts_minimal_event_and_defaults_nullables():
    from kickstream.contracts import MatchEvent

    event = MatchEvent(id="m-1-e1", match_id="m-1", seq=1, minute=0, second=0, type="half_time", x=50, y=50)
    assert event.team is None
    assert event.player_id is None
    assert event.outcome is None


def test_models_reject_unknown_fields_and_values():
    from kickstream.contracts import MatchEvent

    base = dict(id="e", match_id="m", seq=1, minute=0, second=0, type="pass", x=1, y=1)
    with pytest.raises(ValidationError):
        MatchEvent(**base, bogus=1)
    with pytest.raises(ValidationError):
        MatchEvent(**{**base, "type": "handball"})


def test_overlay_data_resolves_to_the_matching_shape():
    from kickstream.contracts import Overlay, PressureMapData, StatCardData

    stat = Overlay(
        id="o1",
        match_id="m",
        minute=5,
        kind="stat_card",
        duration_ms=8000,
        sources=[],
        data={"stat_rows": [{"label": "Shots", "home": 3, "away": 1}]},
    )
    heat = Overlay(
        id="o2",
        match_id="m",
        minute=5,
        kind="pressure_map",
        duration_ms=8000,
        sources=[],
        data={"cols": 6, "rows": 4, "home": [0.0] * 24, "away": [0.0] * 24},
    )
    assert isinstance(stat.data, StatCardData)
    assert isinstance(heat.data, PressureMapData)


def test_recap_requires_exactly_three_bullets():
    from kickstream.contracts import Recap

    fields = dict(
        id="r",
        match_id="m",
        minute=45,
        period="half_time",
        mode="fan",
        language="en",
        title="t",
        text="x",
        source="scripted",
        agent="scripted",
        score_home=0,
        score_away=0,
    )
    with pytest.raises(ValidationError):
        Recap(**fields, bullets=["a", "b"])
    assert len(Recap(**fields, bullets=["a", "b", "c"]).bullets) == 3
