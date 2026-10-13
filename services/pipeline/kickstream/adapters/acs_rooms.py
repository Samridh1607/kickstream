"""Call rooms on Azure Communication Services: one room per broadcast, an identity and token per seat."""

import asyncio
from collections.abc import Callable
from contextlib import suppress
from datetime import UTC, datetime
from typing import TypeVar

from azure.communication.identity import CommunicationIdentityClient, CommunicationTokenScope
from azure.communication.identity import CommunicationUserIdentifier as IdentityUser
from azure.communication.rooms import CommunicationUserIdentifier as RoomUser
from azure.communication.rooms import ParticipantRole, RoomParticipant, RoomsClient
from azure.core.exceptions import AzureError, ResourceNotFoundError

from kickstream.ports.calls import CallRole, RoomsFailure, Seat

T = TypeVar("T")
_ROLES = {
    "presenter": ParticipantRole.PRESENTER,
    "attendee": ParticipantRole.ATTENDEE,
    "consumer": ParticipantRole.CONSUMER,
}
_SCOPES = [CommunicationTokenScope.VOIP]
_BAD_SETTING = "KICKSTREAM_ACS_CONNECTION_STRING is not a valid connection string."
_UNREADABLE = "The calling service gave an answer Kickstream could not read."


def epoch(value) -> float:
    """Token expiry as Unix seconds. Depending on the version, the SDK gives a datetime, an ISO string or a number."""
    if isinstance(value, datetime):
        return value.timestamp()
    if isinstance(value, str):
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    return float(value)


def _reason(exc: AzureError) -> str:
    text = getattr(exc, "message", None) or str(exc) or type(exc).__name__
    return text.splitlines()[0][:200]


class AcsRooms:
    name = "acs"

    def __init__(
        self,
        connection_string: str,
        *,
        make_rooms: Callable[[str], RoomsClient] = RoomsClient.from_connection_string,
        make_identity: Callable[[str], CommunicationIdentityClient] = (
            CommunicationIdentityClient.from_connection_string
        ),
    ) -> None:
        self._connection_string = connection_string
        self._make_rooms = make_rooms
        self._make_identity = make_identity
        self._rooms_client: RoomsClient | None = None
        self._identity_client: CommunicationIdentityClient | None = None

    def _rooms(self) -> RoomsClient:
        if self._rooms_client is None:
            try:
                self._rooms_client = self._make_rooms(self._connection_string)
            except ValueError as exc:
                raise RoomsFailure(_BAD_SETTING) from exc
        return self._rooms_client

    def _identity(self) -> CommunicationIdentityClient:
        if self._identity_client is None:
            try:
                self._identity_client = self._make_identity(self._connection_string)
            except ValueError as exc:
                raise RoomsFailure(_BAD_SETTING) from exc
        return self._identity_client

    @staticmethod
    async def _run(work: Callable[[], T]) -> T:
        """The SDK blocks, so it runs in a thread."""
        try:
            return await asyncio.to_thread(work)
        except AzureError as exc:
            raise RoomsFailure(_reason(exc)) from exc
        except ValueError as exc:
            raise RoomsFailure(_UNREADABLE) from exc

    async def open_room(self, valid_until: float) -> str:
        until = datetime.fromtimestamp(valid_until, UTC)
        made = await self._run(lambda: self._rooms().create_room(valid_until=until))
        return made.id

    async def seat(self, room_id: str, role: CallRole) -> Seat:
        def work() -> Seat:
            user, token = self._identity().create_user_and_token(scopes=_SCOPES)
            user_id = user.properties["id"]
            participant = RoomParticipant(communication_identifier=RoomUser(user_id), role=_ROLES[role])
            self._rooms().add_or_update_participants(room_id=room_id, participants=[participant])
            return Seat(user_id, token.token, epoch(token.expires_on))

        return await self._run(work)

    async def refresh(self, user_id: str) -> Seat:
        def work() -> Seat:
            token = self._identity().get_token(IdentityUser(user_id), scopes=_SCOPES)
            return Seat(user_id, token.token, epoch(token.expires_on))

        return await self._run(work)

    async def unseat(self, room_id: str, user_id: str) -> None:
        def work() -> None:
            # Not found means the identity, or its whole room, is already gone: that is what unseating wants.
            with suppress(ResourceNotFoundError):
                self._rooms().remove_participants(room_id=room_id, participants=[RoomUser(user_id)])
            # Out of the room, their token still lets them call for up to a day.
            with suppress(ResourceNotFoundError):
                self._identity().revoke_tokens(IdentityUser(user_id))

        await self._run(work)

    async def close_room(self, room_id: str) -> None:
        await self._run(lambda: self._rooms().delete_room(room_id))
