import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from kickstream.adapters.clocks import InstantClock
from kickstream.app import Settings, create_app


def poll(**over):
    fields = {
        "id": "p1",
        "question": "Who will win?",
        "state": "open",
        "options": [
            {"id": "o1", "text": "Northbridge FC", "votes": 3},
            {"id": "o2", "text": "Harbour City", "votes": 1},
        ],
    }
    return {**fields, **over}


def question(**over):
    fields = {
        "id": "q1",
        "text": "Why the change?",
        "nickname": "Fan",
        "votes": 1,
        "state": "open",
        "asked_at": 10.0,
    }
    return {**fields, **over}


def audience(**over):
    fields = {"revision": 1, "server_time": 100.0, "poll_on_air": False, "history": [], "questions": []}
    return {**fields, **over}


def test_an_audience_document_round_trips_and_defaults_to_nothing_on_air():
    from kickstream.contracts import Audience

    empty = Audience.model_validate(audience())
    assert (empty.poll, empty.draft, empty.qa) == (None, None, None)
    full = Audience.model_validate(
        audience(
            poll=poll(closes_at=160.0),
            history=[poll(id="p0", state="closed")],
            questions=[question(), question(id="q2", state="answered", answer="Because of the red card.")],
            draft={"question_id": "q1", "text": "", "state": "writing"},
            qa={
                "question_id": "q2",
                "question": "Why?",
                "nickname": "Fan",
                "answer": "Because.",
                "ends_at": 130.0,
            },
        )
    )
    assert Audience.model_validate_json(full.model_dump_json()) == full
    assert full.poll.closes_at == 160.0 and full.questions[0].answer is None


@pytest.mark.parametrize(
    "bad",
    [
        {"poll": poll(question="")},
        {"poll": poll(question="x" * 141)},
        {"poll": poll(options=[{"id": "o1", "text": "Only one", "votes": 0}])},
        {"poll": poll(options=[{"id": f"o{n}", "text": f"Option {n}", "votes": 0} for n in range(7)])},
        {"poll": poll(options=[{"id": "o1", "text": "", "votes": 0}, {"id": "o2", "text": "B", "votes": 0}])},
        {"poll": poll(state="paused")},
        {"questions": [question(text="")]},
        {"questions": [question(text="x" * 201)]},
        {"questions": [question(nickname="x" * 25)]},
        {"questions": [question(state="deleted")]},
        {"draft": {"question_id": "q1", "text": "x" * 401, "state": "ready"}},
        {"draft": {"question_id": "q1", "text": "", "state": "thinking"}},
        {"history": [poll(id=f"p{n}") for n in range(21)]},
        {"extra": True},
    ],
    ids=[
        "blank-question",
        "long-question",
        "one-option",
        "seven-options",
        "blank-option",
        "bad-poll-state",
        "blank-text",
        "long-text",
        "long-nickname",
        "bad-question-state",
        "long-draft",
        "bad-draft-state",
        "long-history",
        "extra-field",
    ],
)
def test_documents_outside_the_limits_are_rejected(bad):
    from kickstream.contracts import Audience

    with pytest.raises(ValidationError):
        Audience.model_validate(audience(**bad))


def test_scenes_can_hold_poll_and_qa_elements():
    from kickstream.contracts import SceneElement

    for kind in ("poll", "qa"):
        assert (
            SceneElement(
                id="e1", type=kind, x=0, y=0, width=400, height=300, layer=1, visible=True, props={}
            ).type
            == kind
        )


def test_a_studio_refusal_is_a_refusal():
    from kickstream.domain.errors import Refusal

    from kickstream.studio.rules import StudioError

    error = StudioError(409, "scene", "No.")
    assert isinstance(error, Refusal) and (error.status, error.field, error.message, error.retry_after) == (
        409,
        "scene",
        "No.",
        None,
    )
    assert Refusal(429, "text", "Wait.", retry_after=12).retry_after == 12


def test_any_refusal_is_answered_in_one_shape_with_retry_after_when_set(tmp_path):
    from kickstream.domain.errors import Refusal

    settings = Settings(None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data")
    app = create_app(settings, clock_factory=lambda speed: InstantClock(), match_prefix="m")

    @app.get("/boom")
    def boom():
        raise Refusal(429, "text", "Wait a moment.", retry_after=7)

    with TestClient(app) as client:
        response = client.get("/boom")
        assert response.status_code == 429 and response.headers["retry-after"] == "7"
        assert response.json() == {
            "detail": [{"loc": ["body", "text"], "msg": "Wait a moment.", "type": "refusal"}]
        }
        studio = client.post("/api/studio/scenes/nope/activate")
        assert studio.status_code == 404 and "retry-after" not in studio.headers
        assert studio.json()["detail"][0]["loc"] == ["body", "scene"]
