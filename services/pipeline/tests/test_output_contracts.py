import pytest
from pydantic import ValidationError


def destination(**over):
    fields = {
        "id": "d1",
        "name": "YouTube",
        "platform": "youtube",
        "url": "rtmp://a.rtmp.youtube.com/live2",
        "enabled": True,
        "key_hint": "wxyz",
        "status": "idle",
    }
    return {**fields, **over}


def output(**over):
    fields = {
        "revision": 1,
        "server_time": 100.0,
        "destinations": [],
        "quality": "720p30",
        "state": "idle",
        "recordings": [],
    }
    return {**fields, **over}


def test_an_output_document_round_trips_and_starts_with_nothing_running():
    from kickstream.contracts import Output

    doc = Output.model_validate(output(destinations=[destination()]))
    assert doc.started_at is None and doc.problem is None
    assert doc.destinations[0].reason is None and doc.destinations[0].live_since is None
    assert Output.model_validate(doc.model_dump(mode="json")) == doc


@pytest.mark.parametrize(
    "bad",
    [
        output(quality="4k60"),
        output(state="paused"),
        output(destinations=[destination(platform="tiktok")]),
        output(destinations=[destination(status="sending")]),
        output(destinations=[destination(name="")]),
        output(destinations=[destination(key_hint="12345")]),
        output(destinations=[destination(id=f"d{n}") for n in range(11)]),
        output(recordings=[{"file": "a.mp4", "size_bytes": -1, "made_at": 1.0}]),
    ],
)
def test_values_outside_the_contract_are_refused(bad):
    from kickstream.contracts import Output

    with pytest.raises(ValidationError):
        Output.model_validate(bad)


def test_a_destination_has_no_place_for_a_key():
    from kickstream.contracts import Destination

    with pytest.raises(ValidationError):
        Destination.model_validate(destination(key="sk-live-secret"))
