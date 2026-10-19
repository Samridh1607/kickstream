from collections.abc import Collection
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from sse_starlette.sse import EventSourceResponse

from kickstream.broadcasts.service import BroadcastService
from kickstream.contracts import Broadcasts
from kickstream.domain.sockets import pump

_TEXT = 2000  # generous bound on request text; the rules give each field its real limit and message
BASE = "/api/broadcasts"
_NOT_HERE = "That file is not part of this broadcast, or is no longer on this computer."


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NewBroadcast(_Body):
    title: str = Field(max_length=_TEXT)
    description: str = Field(default="", max_length=_TEXT)
    record: bool = True


class ChangedBroadcast(_Body):
    title: str = Field(max_length=_TEXT)
    description: str = Field(default="", max_length=_TEXT)


def build_broadcasts_router(*, service: BroadcastService, socket_hosts: Collection[str] = ()) -> APIRouter:
    router = APIRouter()

    # Every route is async: the service belongs to the event loop and starts tasks on it.

    @router.get(BASE)
    async def get_broadcasts() -> Broadcasts:
        return service.view()

    @router.get(f"{BASE}/stream")
    async def get_broadcasts_stream() -> EventSourceResponse:
        async def documents():
            async for doc in service.changes():
                yield {"id": str(doc.revision), "data": doc.model_dump_json()}

        return EventSourceResponse(documents())

    @router.websocket(f"{BASE}/socket")
    async def broadcasts_socket(websocket: WebSocket) -> None:
        async def documents():
            async for doc in service.changes():
                yield doc.model_dump_json()

        await pump(websocket, documents(), socket_hosts)

    @router.post(BASE)
    async def post_broadcast(body: NewBroadcast) -> Broadcasts:
        service.create(body.title, body.description, body.record)
        return service.view()

    @router.put(f"{BASE}/{{broadcast_id}}")
    async def put_broadcast(broadcast_id: str, body: ChangedBroadcast) -> Broadcasts:
        service.edit(broadcast_id, body.title, body.description)
        return service.view()

    @router.delete(f"{BASE}/{{broadcast_id}}")
    async def delete_broadcast(broadcast_id: str) -> Broadcasts:
        service.delete(broadcast_id)
        return service.view()

    @router.post(f"{BASE}/{{broadcast_id}}/select")
    async def post_select(broadcast_id: str) -> Broadcasts:
        service.select(broadcast_id)
        return service.view()

    @router.post(f"{BASE}/{{broadcast_id}}/live")
    async def post_live(broadcast_id: str) -> Broadcasts:
        service.go_live(broadcast_id)
        return service.view()

    @router.post(f"{BASE}/{{broadcast_id}}/end")
    async def post_end(broadcast_id: str) -> Broadcasts:
        await service.end(broadcast_id)
        return service.view()

    @router.post(f"{BASE}/{{broadcast_id}}/reels")
    async def post_reels(broadcast_id: str) -> Broadcasts:
        service.generate_reels(broadcast_id)
        return service.view()

    @router.delete(f"{BASE}/{{broadcast_id}}/reels/{{reel_id}}")
    async def delete_reel(broadcast_id: str, reel_id: str) -> Broadcasts:
        service.delete_reel(broadcast_id, reel_id)
        return service.view()

    @router.put(f"{BASE}/{{broadcast_id}}/reels/{{reel_id}}/edited")
    async def put_edited(broadcast_id: str, reel_id: str, request: Request) -> Broadcasts:
        # The body is the video itself; its name comes percent-encoded, as a header can carry only ASCII.
        name = unquote(request.headers.get("x-file-name", ""))
        await service.add_edited(broadcast_id, reel_id, request.stream(), name)
        return service.view()

    @router.delete(f"{BASE}/{{broadcast_id}}/reels/{{reel_id}}/edited")
    async def delete_edited(broadcast_id: str, reel_id: str) -> Broadcasts:
        service.remove_edited(broadcast_id, reel_id)
        return service.view()

    @router.get(f"{BASE}/{{broadcast_id}}/reels/{{reel_id}}/edited.mp4")
    async def get_edited(broadcast_id: str, reel_id: str) -> FileResponse:
        path = service.edited_file(broadcast_id, reel_id)
        if path is None:
            raise HTTPException(404, _NOT_HERE)
        return FileResponse(
            path,
            media_type="video/mp4",
            filename=f"reel-{reel_id}-edited.mp4",
            content_disposition_type="inline",
        )

    @router.get(f"{BASE}/{{broadcast_id}}/recordings/{{file}}")
    async def get_recording(broadcast_id: str, file: str) -> FileResponse:
        path = service.recording_file(broadcast_id, file)
        if path is None:
            raise HTTPException(404, _NOT_HERE)
        return FileResponse(path, media_type="video/mp4", filename=file, content_disposition_type="inline")

    @router.get(f"{BASE}/{{broadcast_id}}/reels/{{reel_id}}.mp4")
    async def get_reel(broadcast_id: str, reel_id: str) -> FileResponse:
        path = service.reel_file(broadcast_id, reel_id)
        if path is None:
            raise HTTPException(404, _NOT_HERE)
        return FileResponse(
            path, media_type="video/mp4", filename=f"reel-{reel_id}.mp4", content_disposition_type="inline"
        )

    return router
