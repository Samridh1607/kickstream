from collections.abc import Awaitable, Callable
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, WebSocket
from pydantic import BaseModel, ConfigDict, Field
from sse_starlette.sse import EventSourceResponse

from kickstream.contracts import TeamSheet, ViewerProfile
from kickstream.domain.demo import DEMO_SEED
from kickstream.domain.sockets import NOT_FOUND, REFUSED, pump
from kickstream.domain.types import Language, Mode
from kickstream.gateway.stream import stream_items
from kickstream.ports.broadcaster import Broadcaster
from kickstream.ports.store import MatchStore

MAX_SPEED = 600.0
_MAX_ID_DIGITS = 18


class StartMatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    seed: int = Field(default=DEMO_SEED, ge=0, le=2**31 - 1)
    speed: float = Field(default=30.0, ge=1.0, le=MAX_SPEED)


def parse_last_event_id(value: str | None) -> int:
    """A missing or malformed Last-Event-ID means: replay from the start."""
    if value and value.isascii() and value.isdigit() and len(value) <= _MAX_ID_DIGITS:
        return int(value)
    return 0


def build_router(
    *,
    store: MatchStore,
    broadcaster: Broadcaster,
    teams: tuple[TeamSheet, TeamSheet],
    start_match: Callable[[int, float], Awaitable[str]],
    current_match: Callable[[], str | None],
    match_exists: Callable[[str], bool],
) -> APIRouter:
    router = APIRouter(prefix="/api")

    def require(match_id: str) -> None:
        if not match_exists(match_id):
            raise HTTPException(status_code=404, detail=f"unknown match {match_id}")

    @router.get("/teams")
    def get_teams() -> dict[str, TeamSheet]:
        return {"home": teams[0], "away": teams[1]}

    @router.post("/matches", status_code=201)
    async def post_match(body: StartMatch | None = None) -> dict[str, str]:
        request = body or StartMatch()
        return {"match_id": await start_match(request.seed, request.speed)}

    @router.get("/matches/current")
    def get_current() -> dict[str, str]:
        match_id = current_match()
        if match_id is None:
            raise HTTPException(status_code=404, detail="no match has been started")
        return {"match_id": match_id}

    @router.get("/matches/{match_id}/stream")
    async def get_stream(
        match_id: str,
        mode: Mode = "fan",
        lang: Language = "en",
        club: str | None = None,
        player: str | None = None,
        last_event_id: Annotated[str | None, Header()] = None,
    ) -> EventSourceResponse:
        require(match_id)
        profile = ViewerProfile(mode=mode, language=lang, club=club or None, player=player or None)

        async def events():
            async for envelope in stream_items(
                store, broadcaster, match_id, profile, parse_last_event_id(last_event_id)
            ):
                yield {"id": str(envelope.id), "data": envelope.model_dump_json()}

        return EventSourceResponse(events())

    @router.websocket("/matches/{match_id}/socket")
    async def match_socket(
        websocket: WebSocket,
        match_id: str,
        mode: str = "fan",
        lang: str = "en",
        club: str | None = None,
        player: str | None = None,
        after: str | None = None,
    ) -> None:
        """The same stream as `/stream`, over a WebSocket. `after` plays the part of Last-Event-ID."""
        if not match_exists(match_id):
            await websocket.close(code=NOT_FOUND)
            return
        if mode not in ("fan", "analyst") or lang not in ("en", "es", "hi"):
            await websocket.close(code=REFUSED)
            return
        profile = ViewerProfile(mode=mode, language=lang, club=club or None, player=player or None)

        async def envelopes():
            async for envelope in stream_items(
                store, broadcaster, match_id, profile, parse_last_event_id(after)
            ):
                yield envelope.model_dump_json()

        await pump(websocket, envelopes())

    @router.get("/matches/{match_id}/overlays/latest")
    def get_latest_overlays(match_id: str, lang: Language = "en") -> dict[str, dict]:
        require(match_id)
        latest: dict[str, dict] = {}
        for item in store.read(match_id):
            if item.type == "overlay" and item.language in (None, lang):
                latest[item.payload.kind] = item.payload.model_dump(mode="json")
        return latest

    return router
