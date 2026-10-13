from collections.abc import Collection
from typing import Literal

from fastapi import APIRouter, WebSocket
from pydantic import BaseModel, ConfigDict, Field
from sse_starlette.sse import EventSourceResponse
from starlette.websockets import WebSocketDisconnect

from kickstream.contracts import Output
from kickstream.domain.sockets import REFUSED, pump, refuse, same_host
from kickstream.output.service import OutputService

_TEXT = 2000  # generous bound on request text; the rules give each field its real limit and message
BASE = "/api/studio/output"


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NewDestination(_Body):
    name: str = Field(max_length=_TEXT)
    platform: Literal["youtube", "x", "facebook", "twitch", "custom", "file"]
    url: str = Field(default="", max_length=_TEXT)
    key: str = Field(default="", max_length=_TEXT)


class ChangedDestination(_Body):
    name: str = Field(max_length=_TEXT)
    url: str = Field(default="", max_length=_TEXT)
    enabled: bool
    key: str | None = Field(default=None, max_length=_TEXT)


class NewQuality(_Body):
    quality: str = Field(max_length=20)


def build_output_router(*, service: OutputService, socket_hosts: Collection[str] = ()) -> APIRouter:
    router = APIRouter()

    # Every route is async: the service belongs to the event loop and starts tasks on it.

    @router.get(BASE)
    async def get_output() -> Output:
        return service.view()

    @router.get(f"{BASE}/stream")
    async def get_output_stream() -> EventSourceResponse:
        async def documents():
            async for doc in service.changes():
                yield {"id": str(doc.revision), "data": doc.model_dump_json()}

        return EventSourceResponse(documents())

    @router.websocket(f"{BASE}/socket")
    async def output_socket(websocket: WebSocket) -> None:
        async def documents():
            async for doc in service.changes():
                yield doc.model_dump_json()

        await pump(websocket, documents(), socket_hosts)

    @router.post(f"{BASE}/destinations")
    async def post_destination(body: NewDestination) -> Output:
        service.add_destination(body.name, body.platform, body.url, body.key)
        return service.view()

    @router.put(f"{BASE}/destinations/{{destination_id}}")
    async def put_destination(destination_id: str, body: ChangedDestination) -> Output:
        service.edit_destination(
            destination_id, name=body.name, url=body.url, enabled=body.enabled, key=body.key
        )
        return service.view()

    @router.delete(f"{BASE}/destinations/{{destination_id}}")
    async def delete_destination(destination_id: str) -> Output:
        service.remove_destination(destination_id)
        return service.view()

    @router.put(f"{BASE}/quality")
    async def put_quality(body: NewQuality) -> Output:
        service.set_quality(body.quality)
        return service.view()

    @router.post(f"{BASE}/start")
    async def post_start() -> Output:
        service.start()
        return service.view()

    @router.post(f"{BASE}/stop")
    async def post_stop() -> Output:
        await service.stop()
        return service.view()

    @router.websocket("/api/output/capture/socket")
    async def capture_socket(websocket: WebSocket, token: str = "") -> None:
        """The program page in the hidden browser sends its recording here."""
        if not same_host(websocket, socket_hosts) or not service.accepts(token):
            await refuse(websocket, REFUSED)
            return
        await websocket.accept()

        async def chunks():
            try:
                while True:
                    yield await websocket.receive_bytes()
            except (WebSocketDisconnect, KeyError):  # gone, or sent text where a recording belongs
                return

        await service.feed(token, chunks())

    return router
