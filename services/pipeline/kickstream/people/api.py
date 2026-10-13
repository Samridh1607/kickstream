from collections.abc import AsyncIterator, Callable, Collection
from typing import Literal

from fastapi import APIRouter, Response, WebSocket
from pydantic import BaseModel, ConfigDict, Field

from kickstream.contracts import CallSeat, Guest, People
from kickstream.domain.sockets import NOT_FOUND, REFUSED, pump, refuse, same_host
from kickstream.people.rules import PeopleError
from kickstream.people.service import PeopleService

_TEXT = 200  # generous bound on request text; the rules give each field its real limit and message
BASE = "/api/broadcasts/{broadcast_id}/people"
GUEST = "/api/guest/{secret}"
COHOST_COOKIE = "kickstream_cohost"


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NewInvite(_Body):
    role: Literal["speaker", "cohost", "member"]
    name: str | None = Field(default=None, max_length=_TEXT)


class Stage(_Body):
    people: list[str] = Field(max_length=12)


class HostSeat(_Body):
    name: str = Field(default="Host", max_length=_TEXT)


class Joining(_Body):
    name: str = Field(max_length=_TEXT)


def build_people_router(*, service: PeopleService, socket_hosts: Collection[str] = ()) -> APIRouter:
    router = APIRouter()

    async def follow(websocket: WebSocket, check: Callable[[], object], docs: AsyncIterator) -> None:
        if not same_host(websocket, socket_hosts):
            await refuse(websocket, REFUSED)
            return
        try:
            check()
        except PeopleError:
            await refuse(websocket, NOT_FOUND)
            return

        async def messages():
            async for doc in docs:
                yield doc.model_dump_json()

        await pump(websocket, messages(), socket_hosts)

    # --- the studio's ---------------------------------------------------------------------------

    @router.get(BASE)
    async def get_people(broadcast_id: str) -> People:
        return service.view(broadcast_id)

    @router.websocket(f"{BASE}/socket")
    async def people_socket(websocket: WebSocket, broadcast_id: str) -> None:
        await follow(websocket, lambda: service.view(broadcast_id), service.changes(broadcast_id))

    @router.post(f"{BASE}/invites")
    async def post_invite(broadcast_id: str, body: NewInvite) -> People:
        return await service.invite(broadcast_id, body.role, body.name)

    @router.delete(f"{BASE}/invites/{{invite_id}}")
    async def delete_invite(broadcast_id: str, invite_id: str) -> People:
        return await service.revoke(broadcast_id, invite_id)

    @router.put(f"{BASE}/stage")
    async def put_stage(broadcast_id: str, body: Stage) -> People:
        return service.set_stage(broadcast_id, body.people)

    @router.post(f"{BASE}/host/seat")
    async def post_host_seat(broadcast_id: str, body: HostSeat) -> CallSeat:
        return await service.host_seat(broadcast_id, body.name)

    @router.post(f"{BASE}/program/seat")
    async def post_program_seat(broadcast_id: str) -> CallSeat:
        return await service.program_seat(broadcast_id)

    # --- a guest's, by the secret in their link --------------------------------------------------

    @router.get(GUEST)
    async def get_guest(secret: str) -> Guest:
        return service.guest(secret)

    @router.websocket(f"{GUEST}/socket")
    async def guest_socket(websocket: WebSocket, secret: str) -> None:
        with service.attending(secret):
            await follow(websocket, lambda: service.guest(secret), service.guest_changes(secret))

    @router.post(f"{GUEST}/join")
    async def post_join(secret: str, body: Joining, response: Response) -> CallSeat:
        seat = await service.join(secret, body.name)
        if service.is_cohost(secret):
            response.set_cookie(
                COHOST_COOKIE, secret, httponly=True, secure=True, samesite="strict", path="/"
            )
        return seat

    @router.post(f"{GUEST}/seat/refresh")
    async def post_refresh(secret: str) -> CallSeat:
        return await service.refresh(secret)

    return router
