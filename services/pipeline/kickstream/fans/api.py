from collections.abc import Collection
from typing import Literal

from fastapi import APIRouter, WebSocket
from pydantic import BaseModel, ConfigDict, Field
from sse_starlette.sse import EventSourceResponse

from kickstream.contracts import FanSettings, FanZone
from kickstream.domain.sockets import pump
from kickstream.fans import rules
from kickstream.fans.service import FanService
from kickstream.ports.social import IncomingComment, IncomingSuperChat

_TEXT = 2000  # generous bound on request text; the rules give each field its real limit and message
BASE = "/api/fans"
MAX_INGEST = 100


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Liked(_Body):
    liked: bool = True


class NewPoll(_Body):
    question: str = Field(max_length=_TEXT)
    options: list[str] = Field(max_length=20)
    minutes: int | None = None


class PollAir(_Body):
    on_air: bool


class NewSuperChat(_Body):
    name: str = Field(max_length=_TEXT)
    amount: float
    currency: str = Field(default="USD", max_length=10)
    message: str = Field(default="", max_length=_TEXT)


class NewMessage(_Body):
    title: str = Field(default="", max_length=_TEXT)
    text: str = Field(max_length=_TEXT)
    duration_s: int = rules.DEFAULT_SPOTLIGHT_S


class NewWinner(_Body):
    pool: Literal["commenters", "voters", "supporters"]


class IngestComment(_Body):
    id: str = Field(min_length=1, max_length=80)
    platform: str = Field(default="other", max_length=20)
    author: str = Field(max_length=_TEXT)
    handle: str | None = Field(default=None, max_length=_TEXT)
    text: str = Field(max_length=_TEXT)
    likes: int = Field(default=0, ge=0)


class IngestSuperChat(_Body):
    id: str = Field(min_length=1, max_length=80)
    platform: str = Field(default="other", max_length=20)
    name: str = Field(max_length=_TEXT)
    amount: float
    currency: str = Field(max_length=10)
    message: str = Field(default="", max_length=_TEXT)


class Ingest(_Body):
    comments: list[IngestComment] = Field(default_factory=list, max_length=MAX_INGEST)
    superchats: list[IngestSuperChat] = Field(default_factory=list, max_length=MAX_INGEST)


def build_fans_router(*, service: FanService, socket_hosts: Collection[str] = ()) -> APIRouter:
    router = APIRouter()

    # Every route is async: the service belongs to the event loop.

    @router.get(BASE)
    async def get_fans() -> FanZone:
        return service.view()

    @router.get(f"{BASE}/stream")
    async def get_stream() -> EventSourceResponse:
        async def documents():
            async for doc in service.changes():
                yield {"id": str(doc.revision), "data": doc.model_dump_json()}

        return EventSourceResponse(documents())

    @router.websocket(f"{BASE}/socket")
    async def fans_socket(websocket: WebSocket) -> None:
        async def documents():
            async for doc in service.changes():
                yield doc.model_dump_json()

        await pump(websocket, documents(), socket_hosts)

    @router.put(f"{BASE}/settings")
    async def put_settings(body: FanSettings) -> FanZone:
        return await service.settings(body)

    @router.post(f"{BASE}/comments/{{comment_id}}/like")
    async def post_like(comment_id: str, body: Liked | None = None) -> FanZone:
        return await service.like(comment_id, (body or Liked()).liked)

    @router.post(f"{BASE}/comments/{{comment_id}}/spotlight")
    async def post_comment_spotlight(comment_id: str) -> FanZone:
        return await service.spotlight_comment(comment_id)

    @router.post(f"{BASE}/poll")
    async def post_poll(body: NewPoll) -> FanZone:
        return await service.open_poll(body.question, body.options, body.minutes)

    @router.post(f"{BASE}/poll/close")
    async def post_poll_close() -> FanZone:
        return await service.close_poll()

    @router.post(f"{BASE}/poll/announce")
    async def post_poll_announce() -> FanZone:
        return await service.announce_poll()

    @router.put(f"{BASE}/poll/air")
    async def put_poll_air(body: PollAir) -> FanZone:
        return await service.poll_air(body.on_air)

    @router.delete(f"{BASE}/poll")
    async def delete_poll() -> FanZone:
        return await service.remove_poll()

    @router.post(f"{BASE}/superchats")
    async def post_superchat(body: NewSuperChat) -> FanZone:
        return await service.superchat(body.name, body.amount, body.currency, body.message)

    @router.post(f"{BASE}/superchats/{{superchat_id}}/spotlight")
    async def post_superchat_spotlight(superchat_id: str) -> FanZone:
        return await service.spotlight_superchat(superchat_id)

    @router.post(f"{BASE}/spotlight")
    async def post_spotlight(body: NewMessage) -> FanZone:
        return await service.message(body.title, body.text, body.duration_s)

    @router.delete(f"{BASE}/spotlight")
    async def delete_spotlight() -> FanZone:
        return await service.clear_spotlight()

    @router.post(f"{BASE}/winner")
    async def post_winner(body: NewWinner) -> FanZone:
        return await service.winner(body.pool)

    @router.post(f"{BASE}/ingest")
    async def post_ingest(body: Ingest) -> FanZone:
        """Comments and superchats from a bridge to a platform Kickstream does not read itself."""
        comments = [
            IncomingComment(c.id, c.platform, c.author, c.text, c.handle, c.likes) for c in body.comments
        ]
        superchats = [
            IncomingSuperChat(s.id, s.platform, s.name, s.amount, s.currency, s.message)
            for s in body.superchats
        ]
        return await service.ingest(comments, superchats)

    @router.delete(BASE)
    async def delete_fans() -> FanZone:
        return await service.clear()

    return router
