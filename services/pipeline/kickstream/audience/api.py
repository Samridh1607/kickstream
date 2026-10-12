from collections.abc import Callable
from typing import Annotated, Literal

from fastapi import APIRouter, Header, WebSocket
from pydantic import BaseModel, ConfigDict, Field
from sse_starlette.sse import EventSourceResponse

from kickstream.audience import rules
from kickstream.audience.rules import AudienceError
from kickstream.audience.service import AudienceService
from kickstream.contracts import Audience
from kickstream.domain.sockets import pump

_TEXT = 2000  # generous bound on request text; the rules give each field its real limit and message


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Vote(_Body):
    option_id: str = Field(max_length=64)


class NewQuestion(_Body):
    text: str = Field(max_length=_TEXT)
    nickname: str = Field(default="", max_length=_TEXT)


class NewPoll(_Body):
    question: str | None = Field(default=None, max_length=_TEXT)
    options: list[Annotated[str, Field(max_length=_TEXT)]] | None = Field(default=None, max_length=20)
    duration_s: int | None = None
    preset: Literal["winner", "next_goal"] | None = None


class OnAir(_Body):
    on: bool


class DraftText(_Body):
    text: str = Field(max_length=_TEXT)


class Air(_Body):
    duration_s: int = rules.DEFAULT_QA_SECONDS


Voter = Annotated[str | None, Header(alias="X-Voter")]


def build_audience_router(
    *, service: AudienceService, teams: Callable[[], tuple[str, str] | None]
) -> APIRouter:
    router = APIRouter()

    def stream(*, studio: bool) -> EventSourceResponse:
        async def views():
            async for view in service.changes(studio=studio):
                yield {"id": str(view.revision), "data": view.model_dump_json()}

        return EventSourceResponse(views())

    async def socket(websocket: WebSocket, *, studio: bool) -> None:
        async def views():
            async for view in service.changes(studio=studio):
                yield view.model_dump_json()

        await pump(websocket, views())

    def fan() -> Audience:
        return service.view(studio=False)

    def studio() -> Audience:
        return service.view(studio=True)

    # --- fan routes ---------------------------------------------------------------------------

    @router.get("/api/audience")
    def get_audience() -> Audience:
        return fan()

    @router.get("/api/audience/stream")
    async def get_audience_stream() -> EventSourceResponse:
        return stream(studio=False)

    @router.websocket("/api/audience/socket")
    async def audience_socket(websocket: WebSocket) -> None:
        """The fan view, over a WebSocket."""
        await socket(websocket, studio=False)

    @router.websocket("/api/studio/audience/socket")
    async def studio_audience_socket(websocket: WebSocket) -> None:
        """The studio view, over a WebSocket."""
        await socket(websocket, studio=True)

    @router.post("/api/audience/poll/vote")
    async def post_vote(body: Vote, voter: Voter = None) -> Audience:
        await service.vote(rules.check_voter(voter), body.option_id)
        return fan()

    @router.post("/api/audience/questions", status_code=201)
    async def post_question(body: NewQuestion, voter: Voter = None) -> dict:
        question_id = await service.ask(rules.check_voter(voter), body.text, body.nickname)
        return {"id": question_id, "audience": fan().model_dump(mode="json")}

    @router.post("/api/audience/questions/{question_id}/vote")
    async def post_upvote(question_id: str, voter: Voter = None) -> Audience:
        await service.upvote(rules.check_voter(voter), question_id)
        return fan()

    # --- studio routes ------------------------------------------------------------------------

    @router.get("/api/studio/audience")
    def get_studio_audience() -> Audience:
        return studio()

    @router.get("/api/studio/audience/stream")
    async def get_studio_audience_stream() -> EventSourceResponse:
        return stream(studio=True)

    @router.post("/api/studio/audience/poll")
    async def post_poll(body: NewPoll) -> Audience:
        if body.preset is not None:
            names = teams()
            if names is None:
                raise AudienceError(409, "preset", "There is no match to build that poll from.")
            await service.preset_poll(body.preset, names[0], names[1], body.duration_s)
        else:
            if body.question is None:
                raise AudienceError(422, "question", "A poll needs a question.")
            await service.create_poll(body.question, body.options or [], body.duration_s)
        return studio()

    @router.post("/api/studio/audience/poll/close")
    async def post_poll_close() -> Audience:
        await service.apply(rules.close_poll)
        return studio()

    @router.put("/api/studio/audience/poll/on-air")
    async def put_poll_on_air(body: OnAir) -> Audience:
        await service.apply(lambda state: rules.set_poll_on_air(state, body.on))
        return studio()

    @router.post("/api/studio/audience/history/{poll_id}/restore")
    async def post_restore(poll_id: str) -> Audience:
        await service.apply(lambda state: rules.restore_poll(state, poll_id))
        return studio()

    @router.post("/api/studio/audience/questions/{question_id}/hide")
    async def post_hide(question_id: str) -> Audience:
        await service.apply(lambda state: rules.hide(state, question_id))
        return studio()

    @router.post("/api/studio/audience/questions/{question_id}/unhide")
    async def post_unhide(question_id: str) -> Audience:
        await service.apply(lambda state: rules.unhide(state, question_id))
        return studio()

    @router.post("/api/studio/audience/questions/{question_id}/ask")
    async def post_ask_expert(question_id: str) -> Audience:
        await service.ask_expert(question_id)
        return studio()

    @router.put("/api/studio/audience/draft")
    async def put_draft(body: DraftText) -> Audience:
        await service.apply(lambda state: rules.set_draft_text(state, body.text))
        return studio()

    @router.delete("/api/studio/audience/draft")
    async def delete_draft() -> Audience:
        await service.apply(rules.discard_draft)
        return studio()

    @router.post("/api/studio/audience/draft/air")
    async def post_air(body: Air) -> Audience:
        await service.air(body.duration_s)
        return studio()

    @router.delete("/api/studio/audience/qa")
    async def delete_qa() -> Audience:
        await service.apply(rules.clear_qa)
        return studio()

    return router
