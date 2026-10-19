import re
from collections.abc import Awaitable, Callable, Collection
from typing import Annotated, Literal

from fastapi import APIRouter, Header, HTTPException, Response, WebSocket
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sse_starlette.sse import EventSourceResponse

from kickstream.contracts import TeamSheet, ViewerProfile
from kickstream.domain.demo import DEMO_SEED
from kickstream.domain.errors import Refusal
from kickstream.domain.sockets import NOT_FOUND, REFUSED, pump, refuse
from kickstream.domain.types import Language, Mode
from kickstream.gateway.stream import stream_items
from kickstream.ports.broadcaster import Broadcaster
from kickstream.ports.match_source import SourceFailure, SourceUnavailable
from kickstream.ports.store import MatchStore

MAX_SPEED = 600.0
_MAX_ID_DIGITS = 18
_REPLAY_REF = re.compile(r"[0-9]+/[0-9]+/[0-9]+")
_LIVE_REF = re.compile(r"[0-9]+")


class StartMatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    source: Literal["simulated", "statsbomb", "api_football", "openligadb", "detector"] = "simulated"
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)
    # ASCII digits only: \d would also let other scripts' digits through
    ref: str | None = Field(default=None, pattern=r"^[0-9]{1,10}(/[0-9]{1,10}){0,2}$")
    speed: float = Field(default=30.0, ge=1.0, le=MAX_SPEED)

    @model_validator(mode="after")
    def _fits_the_source(self) -> "StartMatch":
        if self.source in ("simulated", "detector"):
            if self.ref is not None:
                raise ValueError(f"a {self.source} match takes no ref")
            if self.source == "detector" and self.seed is not None:
                raise ValueError("a detector match takes no seed")
            return self
        if self.seed is not None:
            raise ValueError(f"a {self.source} match takes no seed")
        shape = _REPLAY_REF if self.source == "statsbomb" else _LIVE_REF
        if self.ref is None or shape.fullmatch(self.ref) is None:
            raise ValueError(f"choose a {self.source} match by its ref")
        return self


class StartRefusal(Refusal):
    """A match could not be started from its source: 409 when unavailable as configured, 502 when it failed."""

    def __init__(self, failure: SourceFailure) -> None:
        status = 409 if isinstance(failure, SourceUnavailable) else 502
        super().__init__(status, "source", failure.message)


def parse_last_event_id(value: str | None) -> int:
    """A missing or malformed Last-Event-ID means: replay from the start."""
    if value and value.isascii() and value.isdigit() and len(value) <= _MAX_ID_DIGITS:
        return int(value)
    return 0


def build_router(
    *,
    store: MatchStore,
    broadcaster: Broadcaster,
    teams: Callable[[], tuple[TeamSheet, TeamSheet]],
    start_match: Callable[..., Awaitable[str]],
    stop_match: Callable[[], Awaitable[None]],
    current_match: Callable[[], str | None],
    match_exists: Callable[[str], bool],
    socket_hosts: Collection[str] = (),
) -> APIRouter:
    router = APIRouter(prefix="/api")

    def require(match_id: str) -> None:
        if not match_exists(match_id):
            raise HTTPException(status_code=404, detail=f"unknown match {match_id}")

    @router.get("/teams")
    async def get_teams() -> dict[str, TeamSheet]:
        home, away = teams()
        return {"home": home, "away": away}

    @router.post("/matches", status_code=201)
    async def post_match(body: StartMatch | None = None) -> dict[str, str]:
        request = body or StartMatch()
        seed = request.seed if request.seed is not None else DEMO_SEED
        try:
            match_id = await start_match(seed, request.speed, source=request.source, ref=request.ref)
        except SourceFailure as exc:
            raise StartRefusal(exc) from exc
        return {"match_id": match_id}

    @router.post("/matches/stop", status_code=204)
    async def post_stop() -> Response:
        await stop_match()
        return Response(status_code=204)

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
            await refuse(websocket, NOT_FOUND)
            return
        if mode not in ("fan", "analyst") or lang not in ("en", "es", "hi"):
            await refuse(websocket, REFUSED)
            return
        profile = ViewerProfile(mode=mode, language=lang, club=club or None, player=player or None)

        async def envelopes():
            async for envelope in stream_items(
                store, broadcaster, match_id, profile, parse_last_event_id(after)
            ):
                yield envelope.model_dump_json()

        await pump(websocket, envelopes(), socket_hosts)

    @router.get("/matches/{match_id}/overlays/latest")
    def get_latest_overlays(match_id: str, lang: Language = "en") -> dict[str, dict]:
        require(match_id)
        latest: dict[str, dict] = {}
        for item in store.read(match_id):
            if item.type == "overlay" and item.language in (None, lang):
                latest[item.payload.kind] = item.payload.model_dump(mode="json")
        return latest

    return router
