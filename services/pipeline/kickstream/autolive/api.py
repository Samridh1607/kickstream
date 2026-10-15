from collections.abc import Collection

from fastapi import APIRouter, Response, WebSocket
from pydantic import BaseModel, ConfigDict, Field
from sse_starlette.sse import EventSourceResponse

from kickstream.autolive.service import AutoLiveError, AutoLiveService
from kickstream.contracts import AutoLive, AutoLiveSettings
from kickstream.domain.sockets import pump
from kickstream.ports.speech import SpeechFailure

BASE = "/api/autolive"


class Spoken(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(max_length=2000)


def build_autolive_router(*, service: AutoLiveService, socket_hosts: Collection[str] = ()) -> APIRouter:
    router = APIRouter()

    @router.get(BASE)
    async def get_autolive() -> AutoLive:
        return service.view()

    @router.get(f"{BASE}/stream")
    async def get_stream() -> EventSourceResponse:
        async def documents():
            async for doc in service.changes():
                yield {"id": str(doc.revision), "data": doc.model_dump_json()}

        return EventSourceResponse(documents())

    @router.websocket(f"{BASE}/socket")
    async def autolive_socket(websocket: WebSocket) -> None:
        async def documents():
            async for doc in service.changes():
                yield doc.model_dump_json()

        await pump(websocket, documents(), socket_hosts)

    @router.put(f"{BASE}/settings")
    async def put_settings(body: AutoLiveSettings) -> AutoLive:
        return service.set_settings(body)

    @router.post(f"{BASE}/next")
    async def post_next() -> AutoLive:
        return service.next_scene()

    @router.post(f"{BASE}/scenes/{{scene_id}}/show")
    async def post_show(scene_id: str) -> AutoLive:
        return service.show(scene_id)

    @router.post(f"{BASE}/say")
    async def post_say() -> AutoLive:
        return service.say()

    @router.post(f"{BASE}/speech")
    async def post_speech(body: Spoken) -> Response:
        """The text in the auto live voice, as MP3. 503 when Azure Speech cannot say it; the page then speaks it."""
        try:
            audio = await service.speak(body.text)
        except SpeechFailure as exc:
            raise AutoLiveError(503, "speech", str(exc)) from exc
        return Response(content=audio, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})

    return router
