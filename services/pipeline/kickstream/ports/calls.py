"""What the people stage needs from a calling service: rooms, and seats in them with a role."""

from dataclasses import dataclass
from typing import Literal, Protocol

CallRole = Literal["presenter", "attendee", "consumer"]


@dataclass(frozen=True)
class Seat:
    user_id: str
    token: str
    expires_at: float  # Unix seconds


class RoomsFailure(Exception):
    """The calling service failed. The message is written for the streamer."""


class CallRooms(Protocol):
    name: Literal["acs", "fake"]  # which client the pages join the room with

    async def open_room(self, valid_until: float) -> str:
        """A new room, usable until then. Raises RoomsFailure."""

    async def seat(self, room_id: str, role: CallRole) -> Seat:
        """A new identity in the room with that role, and a token for it. Raises RoomsFailure."""

    async def refresh(self, user_id: str) -> Seat:
        """A new token for an identity. Raises RoomsFailure."""

    async def unseat(self, room_id: str, user_id: str) -> None:
        """Take the identity out of the room. An identity that is not in the room is not a failure:
        this may be called again after an earlier success. Raises RoomsFailure."""

    async def close_room(self, room_id: str) -> None:
        """Raises RoomsFailure."""
