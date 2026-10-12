from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict
from sse_starlette.sse import EventSourceResponse

from kickstream.contracts import KeyMoment, MatchEvent, SceneElement, Studio, StudioSettings, Ticker
from kickstream.ports.store import MatchStore
from kickstream.studio import rules
from kickstream.studio.rules import StudioError
from kickstream.studio.service import StudioService


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NewScene(_Body):
    source: Literal["builtin", "template", "scene"]
    ref: str
    name: str | None = None


class SceneBody(_Body):
    name: str
    elements: list[SceneElement]


class NewTemplate(_Body):
    scene_id: str
    name: str | None = None


class NewBanner(_Body):
    text: str
    kind: Literal["custom", "info", "goal", "card"] = "custom"
    duration_s: int = rules.DEFAULT_BANNER_SECONDS
    source_id: str | None = None


class NewCountdown(_Body):
    kind: Literal["start", "break"]
    starts_at: float | None = None
    minutes: int | None = None
    label: str = ""


class NewReplay(_Body):
    match_id: str
    moment_id: str


def find_moment(store: MatchStore, match_id: str, moment_id: str) -> KeyMoment | None:
    for item in store.read(match_id):
        if item.type == "key_moment" and item.payload.id == moment_id:
            return item.payload
    return None


def replay_events(store: MatchStore, match_id: str, moment: KeyMoment) -> list[MatchEvent]:
    """Team events in the match seconds leading up to the moment, oldest first."""

    def at(event: MatchEvent) -> int:
        return event.minute * 60 + event.second

    events = [item.payload for item in store.read(match_id) if item.type == "match_event"]
    # A moment without its own event (a momentum swing, sustained pressure) ends with its minute.
    anchor = next((at(event) for event in events if event.id == moment.event_id), moment.minute * 60 + 59)
    return [
        event
        for event in events
        if event.team is not None and anchor - rules.REPLAY_WINDOW_SECONDS <= at(event) <= anchor
    ]


def build_studio_router(*, service: StudioService, store: MatchStore) -> APIRouter:
    router = APIRouter()

    @router.get("/api/studio")
    def get_studio() -> Studio:
        return service.doc

    @router.get("/api/studio/stream")
    async def get_stream() -> EventSourceResponse:
        async def documents():
            async for doc in service.changes():
                yield {"id": str(doc.revision), "data": doc.model_dump_json()}

        return EventSourceResponse(documents())

    @router.post("/api/studio/scenes")
    async def post_scene(body: NewScene) -> Studio:
        return await service.apply(lambda doc: rules.create_scene(doc, body.source, body.ref, body.name))

    @router.put("/api/studio/scenes/{scene_id}")
    async def put_scene(scene_id: str, body: SceneBody) -> Studio:
        return await service.apply(lambda doc: rules.replace_scene(doc, scene_id, body.name, body.elements))

    @router.delete("/api/studio/scenes/{scene_id}")
    async def delete_scene(scene_id: str) -> Studio:
        return await service.apply(lambda doc: rules.delete_scene(doc, scene_id))

    @router.post("/api/studio/scenes/{scene_id}/activate")
    async def post_activate(scene_id: str) -> Studio:
        return await service.apply(lambda doc: rules.activate_scene(doc, scene_id))

    @router.post("/api/studio/templates")
    async def post_template(body: NewTemplate) -> Studio:
        return await service.apply(lambda doc: rules.save_template(doc, body.scene_id, body.name))

    @router.delete("/api/studio/templates/{template_id}")
    async def delete_template(template_id: str) -> Studio:
        return await service.apply(lambda doc: rules.delete_template(doc, template_id))

    @router.put("/api/studio/settings")
    async def put_settings(body: StudioSettings) -> Studio:
        return await service.apply(lambda doc: rules.set_settings(doc, body))

    @router.post("/api/studio/banner")
    async def post_banner(body: NewBanner) -> Studio:
        return await service.banner(body.text, body.kind, body.duration_s, body.source_id)

    @router.delete("/api/studio/banner")
    async def delete_banner() -> Studio:
        return await service.clear_banner()

    @router.put("/api/studio/ticker")
    async def put_ticker(body: Ticker) -> Studio:
        return await service.apply(lambda doc: rules.set_ticker(doc, body))

    @router.post("/api/studio/countdown")
    async def post_countdown(body: NewCountdown) -> Studio:
        if body.kind == "start":
            if body.starts_at is None:
                raise StudioError(422, "starts_at", "A start countdown needs a start time.")
            return await service.countdown(body.starts_at, body.label)
        if body.minutes is None:
            raise StudioError(422, "minutes", "A break needs a length in minutes.")
        return await service.take_break(body.minutes, body.label)

    @router.delete("/api/studio/countdown")
    async def delete_countdown() -> Studio:
        return await service.apply(rules.end_countdown)

    @router.post("/api/studio/replay")
    async def post_replay(body: NewReplay) -> Studio:
        return await service.replay(body.match_id, body.moment_id)

    @router.delete("/api/studio/replay")
    async def delete_replay() -> Studio:
        return await service.apply(rules.stop_replay)

    @router.post("/api/studio/images", status_code=201)
    async def post_image(request: Request) -> dict[str, str]:
        declared = request.headers.get("content-length", "0")
        if declared.isdigit() and int(declared) > rules.MAX_IMAGE_BYTES:
            raise StudioError(422, "image", "An image can be at most 2 MB.")
        return {"id": service.upload(await request.body())}

    @router.get("/api/studio/images/{image_id}")
    def get_image(image_id: str) -> Response:
        found = service.image(image_id)
        if found is None:
            raise HTTPException(status_code=404, detail="no such image")
        content, media_type = found
        return Response(
            content=content,
            media_type=media_type,
            headers={
                "Cache-Control": "public, max-age=31536000, immutable",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @router.get("/api/matches/{match_id}/moments/{moment_id}/replay")
    def get_replay_events(match_id: str, moment_id: str) -> dict:
        moment = find_moment(store, match_id, moment_id)
        if moment is None:
            raise HTTPException(status_code=404, detail="no such key moment")
        return {
            "moment": moment.model_dump(mode="json"),
            "events": [event.model_dump(mode="json") for event in replay_events(store, match_id, moment)],
        }

    return router
