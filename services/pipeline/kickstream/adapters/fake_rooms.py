"""Rooms that live only in memory, with predictable ids and tokens.

For tests, and for trying guests without Azure: nobody in a fake room hears or sees anyone else.
"""

import itertools
import time
from collections.abc import Callable

from kickstream.ports.calls import CallRole, RoomsFailure, Seat

TOKEN_HOURS = 24


class FakeRooms:
    name = "fake"

    def __init__(self, now: Callable[[], float] = time.time) -> None:
        self._now = now
        self._ids = itertools.count(1)
        self.rooms: dict[str, dict[str, CallRole]] = {}  # room id -> user id -> role
        self.fails: str | None = None  # when set, every call fails with this reason
        self.calls: list[str] = []

    def _check(self, call: str) -> None:
        self.calls.append(call)
        if self.fails:
            raise RoomsFailure(self.fails)

    def _seat(self, user_id: str) -> Seat:
        return Seat(user_id, f"token-{user_id}-{next(self._ids)}", self._now() + TOKEN_HOURS * 3600)

    async def open_room(self, valid_until: float) -> str:
        self._check("open_room")
        room_id = f"room-{next(self._ids)}"
        self.rooms[room_id] = {}
        return room_id

    async def seat(self, room_id: str, role: CallRole) -> Seat:
        self._check("seat")
        if room_id not in self.rooms:
            raise RoomsFailure("That room does not exist.")
        user_id = f"8:fake:{next(self._ids)}"
        self.rooms[room_id][user_id] = role
        return self._seat(user_id)

    async def refresh(self, user_id: str) -> Seat:
        self._check("refresh")
        return self._seat(user_id)

    async def unseat(self, room_id: str, user_id: str) -> None:
        self._check("unseat")
        self.rooms.get(room_id, {}).pop(user_id, None)

    async def close_room(self, room_id: str) -> None:
        self._check("close_room")
        self.rooms.pop(room_id, None)
