"""Holds the people of every broadcast: applies the rules, saves, seats people in call rooms, and
pushes the documents to pages."""

import asyncio
import contextlib
import logging
import secrets
import time
import uuid
from collections import Counter
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from dataclasses import replace
from typing import TypeVar

from kickstream.contracts import Broadcast, Broadcasts, CallSeat, Guest, People
from kickstream.people import rules
from kickstream.people.rules import PeopleError, PeopleState
from kickstream.ports.calls import CallRole, CallRooms, RoomsFailure, Seat
from kickstream.ports.output import RecordStore

log = logging.getLogger(__name__)
T = TypeVar("T")

ROOM_DAYS = 7
SETUP = (
    "Guests need Azure Communication Services. Put KICKSTREAM_ACS_CONNECTION_STRING in the .env file "
    "at the top of the project, then restart the pipeline."
)
ROLES_IN_THE_ROOM: dict[str, CallRole] = {"cohost": "presenter", "speaker": "attendee", "member": "attendee"}


class PeopleService:
    def __init__(
        self,
        store: RecordStore,
        rooms: CallRooms | None,
        *,
        find_broadcast: Callable[[str], Broadcast | None],
        broadcast_changes: Callable[[], AsyncIterator[Broadcasts]],
        public_origin: str | None = None,
        now: Callable[[], float] = time.time,
        new_id: Callable[[], str] = lambda: uuid.uuid4().hex[:8],
        new_secret: Callable[[], str] = lambda: secrets.token_urlsafe(32),
    ) -> None:
        self._store = store
        self._rooms = rooms
        self._find_broadcast = find_broadcast
        self._broadcast_changes = broadcast_changes
        self._public_origin = public_origin
        self._now = now
        self._new_id = new_id
        self._new_secret = new_secret
        self._state = self._load()
        self._present: Counter[str] = Counter()  # invite id -> guest pages open for it
        self._listeners: set[asyncio.Event] = set()
        self._lock = asyncio.Lock()  # one change that waits on the calling service at a time

    def _load(self) -> PeopleState:
        record = self._store.load()
        if record is None:
            return PeopleState()
        try:
            state = rules.load(record)
        except (ValueError, TypeError, KeyError) as exc:
            log.warning("the saved people cannot be used (%s); starting empty", type(exc).__name__)
            self._store.set_aside()
            return PeopleState()
        return rules.keep_only(state, [bid for bid in state.rooms if self._find_broadcast(bid) is not None])

    # --- reading --------------------------------------------------------------------------------

    @property
    def service(self) -> rules.Service:
        return self._rooms.name if self._rooms is not None else None

    def _broadcast(self, broadcast_id: str) -> Broadcast:
        found = self._find_broadcast(broadcast_id)
        if found is None:
            raise PeopleError(404, "broadcast", "That broadcast no longer exists.")
        return found

    def view(self, broadcast_id: str) -> People:
        self._broadcast(broadcast_id)
        return rules.view(
            self._state,
            broadcast_id,
            service=self.service,
            public_origin=self._public_origin,
            present={invite_id for invite_id, count in self._present.items() if count > 0},
            now=self._now(),
        )

    def guest(self, secret: str) -> Guest:
        broadcast_id, _ = rules.find_secret(self._state, secret)
        return rules.guest_view(
            self._state, secret, self._find_broadcast(broadcast_id), service=self.service, now=self._now()
        )

    async def _follow(self, read: Callable[[], T]) -> AsyncIterator[T]:
        """The current document, then the latest one after each change, until it no longer exists."""
        listener = asyncio.Event()
        self._listeners.add(listener)
        try:
            while True:
                try:
                    yield read()
                except PeopleError:
                    return
                await listener.wait()
                listener.clear()
        finally:
            self._listeners.discard(listener)

    def changes(self, broadcast_id: str) -> AsyncIterator[People]:
        return self._follow(lambda: self.view(broadcast_id))

    def guest_changes(self, secret: str) -> AsyncIterator[Guest]:
        return self._follow(lambda: self.guest(secret))

    def is_cohost(self, secret: str) -> bool:
        return rules.is_cohost(self._state, secret)

    @contextlib.contextmanager
    def attending(self, secret: str) -> Iterator[None]:
        """A guest's page is open: they show as present until it closes."""
        try:
            _, item = rules.find_secret(self._state, secret)
            invite_id: str | None = item.id
        except PeopleError:
            invite_id = None
        if invite_id is not None:
            self._present[invite_id] += 1
            self._wake()
        try:
            yield
        finally:
            if invite_id is not None:
                self._present[invite_id] -= 1
                if self._present[invite_id] <= 0:
                    del self._present[invite_id]
                self._wake()

    # --- changing -------------------------------------------------------------------------------

    def _wake(self) -> None:
        for listener in self._listeners:
            listener.set()

    def _apply(self, change: Callable[[PeopleState], PeopleState]) -> None:
        changed = change(self._state)
        if changed is self._state:
            return
        candidate = replace(changed, revision=self._state.revision + 1)
        try:
            self._store.save(rules.dump(candidate))
        except OSError as exc:
            raise PeopleError(503, "people", "The change could not be saved. Nothing was changed.") from exc
        self._state = candidate
        self._wake()

    def _need_rooms(self) -> CallRooms:
        if self._rooms is None:
            raise PeopleError(503, "rooms", SETUP)
        return self._rooms

    @staticmethod
    async def _call(work: Awaitable[T]) -> T:
        try:
            return await work
        except RoomsFailure as exc:
            raise PeopleError(502, "rooms", f"The calling service refused: {exc}") from exc

    async def _room_id(self, broadcast_id: str) -> str:
        """The broadcast's call room, opened the first time it is needed."""
        existing = rules.room(self._state, broadcast_id).room_id
        if existing is not None:
            return existing
        valid_until = self._now() + ROOM_DAYS * 86_400
        room_id = await self._call(self._need_rooms().open_room(valid_until))
        self._apply(lambda state: rules.open_room(state, broadcast_id, room_id))
        return room_id

    def _seat(self, room_id: str, seat: Seat) -> CallSeat:
        return CallSeat(
            room_id=room_id,
            acs_id=seat.user_id,
            token=seat.token,
            expires_at=seat.expires_at,
            service=self._need_rooms().name,
        )

    async def invite(self, broadcast_id: str, role: str, name: str | None) -> People:
        broadcast = self._broadcast(broadcast_id)
        self._need_rooms()
        async with self._lock:
            invite_id, secret, now = self._new_id(), self._new_secret(), self._now()

            def made(state: PeopleState) -> PeopleState:
                return rules.invite(state, broadcast_id, broadcast.state, invite_id, role, name, secret, now)

            made(self._state)  # refused before a room is opened for it
            await self._room_id(broadcast_id)
            self._apply(made)
        return self.view(broadcast_id)

    async def revoke(self, broadcast_id: str, invite_id: str) -> People:
        self._broadcast(broadcast_id)
        async with self._lock:
            current = rules.room(self._state, broadcast_id)
            item = next((i for i in current.invites if i.id == invite_id), None)
            self._apply(lambda state: rules.revoke(state, broadcast_id, invite_id))
            if item is not None and item.user_id and current.room_id and self._rooms is not None:
                try:
                    await self._rooms.unseat(current.room_id, item.user_id)
                except RoomsFailure as exc:
                    raise PeopleError(
                        502,
                        "rooms",
                        "The invite is revoked, but the calling service did not take them out of the call "
                        f"({exc}). Press Revoke again to try again.",
                    ) from exc
                self._apply(lambda state: rules.unseated(state, broadcast_id, invite_id))
        return self.view(broadcast_id)

    def set_stage(self, broadcast_id: str, people: list[str]) -> People:
        self._broadcast(broadcast_id)
        self._apply(lambda state: rules.set_stage(state, broadcast_id, people))
        return self.view(broadcast_id)

    async def host_seat(self, broadcast_id: str, name: str) -> CallSeat:
        if self._broadcast(broadcast_id).state == "ended":
            raise PeopleError(409, "broadcast", "This broadcast has ended.")
        clean = rules.clean_name(name)
        rooms = self._need_rooms()
        async with self._lock:
            room_id = await self._room_id(broadcast_id)
            known = rules.room(self._state, broadcast_id).host_user_id
            seat = await self._call(rooms.refresh(known) if known else rooms.seat(room_id, "presenter"))
            self._apply(lambda state: rules.seat_host(state, broadcast_id, clean, seat.user_id))
        return self._seat(room_id, seat)

    async def program_seat(self, broadcast_id: str) -> CallSeat:
        self._broadcast(broadcast_id)
        rooms = self._need_rooms()
        async with self._lock:
            current = rules.room(self._state, broadcast_id)
            if current.room_id is None:
                raise PeopleError(409, "room", "No one has joined this broadcast yet.")
            room_id, known = current.room_id, current.program_user_id
            seat = await self._call(rooms.refresh(known) if known else rooms.seat(room_id, "consumer"))
            self._apply(lambda state: rules.seat_program(state, broadcast_id, seat.user_id))
        return self._seat(room_id, seat)

    async def join(self, secret: str, name: str) -> CallSeat:
        rooms = self._need_rooms()
        async with self._lock:
            broadcast_id, _ = rules.find_secret(self._state, secret)
            found = self._find_broadcast(broadcast_id)
            _, item, clean = rules.joinable(self._state, secret, found.state if found else "ended", name)
            room_id = await self._room_id(broadcast_id)
            if item.user_id:
                try:
                    await rooms.unseat(room_id, item.user_id)
                except RoomsFailure as exc:
                    raise PeopleError(
                        502, "rooms", f"Your earlier session could not be ended ({exc}). Try joining again."
                    ) from exc
            seat = await self._call(rooms.seat(room_id, ROLES_IN_THE_ROOM[item.role]))
            self._apply(lambda state: rules.join(state, secret, clean, seat.user_id))
        return self._seat(room_id, seat)

    async def refresh(self, secret: str) -> CallSeat:
        rooms = self._need_rooms()
        broadcast_id, item = rules.usable(self._state, secret)
        room_id = rules.room(self._state, broadcast_id).room_id
        if item.user_id is None or room_id is None:
            raise PeopleError(409, "invite", "Join first.")
        return self._seat(room_id, await self._call(rooms.refresh(item.user_id)))

    # --- following the broadcasts ---------------------------------------------------------------

    async def run(self) -> None:
        """An ended or deleted broadcast's links stop working and its room closes."""
        async for doc in self._broadcast_changes():
            still_open = {item.id for item in doc.broadcasts if item.state != "ended"}
            for broadcast_id in list(self._state.rooms):
                if broadcast_id not in still_open and rules.needs_ending(self._state, broadcast_id):
                    try:
                        await self._end(broadcast_id)
                    except PeopleError as exc:
                        log.warning("the guests of a broadcast could not be let go: %s", exc.message)
            self._wake()  # going live mutes everyone backstage

    async def _end(self, broadcast_id: str) -> None:
        async with self._lock:
            room_id = rules.room(self._state, broadcast_id).room_id
            self._apply(lambda state: rules.end(state, broadcast_id))
        if room_id is not None and self._rooms is not None:
            try:
                await self._rooms.close_room(room_id)
            except RoomsFailure as exc:
                log.warning("a call room could not be closed: %s", exc)
