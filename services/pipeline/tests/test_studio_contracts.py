import pytest
from pydantic import ValidationError


def element(**over):
    fields = {
        "id": "e1",
        "type": "text",
        "x": 0,
        "y": 0,
        "width": 400,
        "height": 100,
        "layer": 1,
        "visible": True,
        "props": {"text": "Hello"},
    }
    return {**fields, **over}


def studio(**over):
    fields = {
        "revision": 1,
        "server_time": 1000.0,
        "scenes": [{"id": "s1", "name": "Live", "elements": [element()]}],
        "active_scene_id": "s1",
        "templates": [],
        "settings": {
            "mode": "fan",
            "language": "en",
            "auto_banner": True,
            "auto_start": True,
            "auto_half_time_break": False,
        },
        "banner_queue": [],
        "ticker": {"enabled": True, "speed": 120, "messages": [], "show_score": True, "show_stats": True},
    }
    return {**fields, **over}


def test_a_studio_document_round_trips_through_json():
    from kickstream.contracts import Studio

    doc = Studio.model_validate(
        studio(
            banner={"id": "b1", "text": "GOAL!", "kind": "goal", "duration_s": 8, "ends_at": 1008.0},
            countdown={"kind": "break", "ends_at": 1300.0, "label": ""},
            replay={
                "match_id": "m-1",
                "moment_id": "m-1-k1",
                "minute": 23,
                "started_at": 1000.0,
                "duration_s": 8.0,
            },
        )
    )
    assert Studio.model_validate_json(doc.model_dump_json()) == doc
    assert doc.previous_scene_id is None and doc.scenes[0].template is None
    assert doc.banner.source_id is None


def test_optional_parts_default_to_nothing_on_screen():
    from kickstream.contracts import Studio

    doc = Studio.model_validate(studio())
    assert doc.banner is None and doc.countdown is None and doc.replay is None


@pytest.mark.parametrize(
    "bad",
    [
        {"scenes": []},
        {"scenes": [{"id": "s1", "name": "", "elements": []}]},
        {"scenes": [{"id": "s1", "name": "x" * 61, "elements": []}]},
        {"scenes": [{"id": "s1", "name": "Live", "elements": [element(type="webcam")]}]},
        {"scenes": [{"id": "s1", "name": "Live", "elements": [element(x=1.5)]}]},
        {"banner": {"id": "b", "text": "", "kind": "goal", "duration_s": 8}},
        {"banner": {"id": "b", "text": "x", "kind": "goal", "duration_s": 2}},
        {"banner": {"id": "b", "text": "x", "kind": "shout", "duration_s": 8}},
        {"ticker": {"enabled": True, "speed": 10, "messages": [], "show_score": True, "show_stats": True}},
        {
            "ticker": {
                "enabled": True,
                "speed": 120,
                "messages": ["x"] * 21,
                "show_score": True,
                "show_stats": True,
            }
        },
        {"countdown": {"kind": "nap", "ends_at": 1.0, "label": ""}},
        {"surprise": 1},
    ],
    ids=[
        "no-scenes",
        "blank-name",
        "long-name",
        "unknown-element",
        "fractional-position",
        "blank-banner",
        "short-banner",
        "unknown-banner-kind",
        "slow-ticker",
        "too-many-ticker-messages",
        "unknown-countdown",
        "extra-field",
    ],
)
def test_documents_outside_the_limits_are_rejected(bad):
    from kickstream.contracts import Studio

    with pytest.raises(ValidationError):
        Studio.model_validate(studio(**bad))
