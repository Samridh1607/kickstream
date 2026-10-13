"""Every rule for the people in a broadcast: invite links, joining, and the stage.

Each rule takes a state and returns a new one; none mutates its argument. Time, ids and call
identities are passed in. A broken limit raises `PeopleError`. A rule with nothing to change
returns its argument.
"""

import hmac
from collections.abc import Collection, Mapping
from dataclasses import asdict, dataclass, field, replace
from typing import Literal

from kickstream.contracts import Broadcast, Guest, Invite, People, StagePerson
from kickstream.domain.errors import Refusal

Role = Literal["speaker", "cohost", "member"]
Service = Literal["acs", "fake"] | None
ROLES: tuple[str, ...] = ("speaker", "cohost", "member")
ROLE_NAMES = {"speaker": "Speaker", "cohost": "Co-host", "member": "Member"}
HOST = "host"  # the streamer's place on the stage list
MAX_INVITES = 12
MAX_STAGE = 4
MAX_NAME = 40
GONE = "This invite is no longer valid."


class PeopleError(Refusal):
    """A change the people rules refuse."""


@dataclass(frozen=True)
class Invitation:
    id: str
    role: Role
    name: str | None
    secret: str
    made_at: float
    revoked: bool = False
    joined_name: str | None = None
    user_id: str | None = None  # the call identity of whoever joined with the link


@dataclass(frozen=True)
class Room:
    """One broadcast's people. `room_id` is its call room, opened the first time it is needed."""

    room_id: str | None = None
    invites: tuple[Invitation, ...] = ()
    stage: tuple[str, ...] = ()  # HOST or invite ids, in order
    host_name: str = "Host"
    host_user_id: str | None = None
    program_user_id: str | None = None


@dataclass(frozen=True)
class PeopleState:
    revision: int = 0
    rooms: Mapping[str, Room] = field(default_factory=dict)  # by broadcast id


# --- helpers -----------------------------------------------------------------------------------


def room(state: PeopleState, broadcast_id: str) -> Room:
    return state.rooms.get(broadcast_id, Room())


def _put(state: PeopleState, broadcast_id: str, changed: Room) -> PeopleState:
    if broadcast_id in state.rooms and state.rooms[broadcast_id] == changed:
        return state
    return replace(state, rooms={**state.rooms, broadcast_id: changed})


def _with_invite(current: Room, updated: Invitation) -> Room:
    return replace(current, invites=tuple(updated if i.id == updated.id else i for i in current.invites))


def clean_name(text: str, field_: str = "name") -> str:
    text = " ".join(text.split())
    if not 1 <= len(text) <= MAX_NAME:
        raise PeopleError(422, field_, f"A name is 1 to {MAX_NAME} characters.")
    return text


def find_secret(state: PeopleState, secret: str) -> tuple[str, Invitation]:
    """The broadcast and invite a link belongs to, revoked or not. An unknown link raises."""
    asked = secret.encode()
    for broadcast_id, current in state.rooms.items():
        for item in current.invites:
            if hmac.compare_digest(item.secret.encode(), asked):
                return broadcast_id, item
    raise PeopleError(404, "invite", GONE)


def usable(state: PeopleState, secret: str) -> tuple[str, Invitation]:
    broadcast_id, item = find_secret(state, secret)
    if item.revoked:
        raise PeopleError(404, "invite", GONE)
    return broadcast_id, item


def _person_name(item: Invitation) -> str:
    return item.joined_name or item.name or ROLE_NAMES[item.role]


# --- invites -----------------------------------------------------------------------------------


def invite(
    state: PeopleState,
    broadcast_id: str,
    broadcast_state: str,
    invite_id: str,
    role: str,
    name: str | None,
    secret: str,
    now: float,
) -> PeopleState:
    """A new invite link for a role. Revoked invites are cleared away to make room."""
    if broadcast_state == "ended":
        raise PeopleError(409, "broadcast", "This broadcast has ended, so it takes no more guests.")
    if role not in ROLES:
        raise PeopleError(422, "role", "Choose Speaker, Co-host or Member.")
    current = room(state, broadcast_id)
    kept = tuple(item for item in current.invites if not item.revoked)
    if len(kept) >= MAX_INVITES:
        raise PeopleError(
            409, "invites", f"A broadcast can have at most {MAX_INVITES} invites. Revoke one first."
        )
    made = Invitation(
        id=invite_id,
        role=role,
        name=clean_name(name) if name and name.strip() else None,
        secret=secret,
        made_at=now,
    )
    return _put(state, broadcast_id, replace(current, invites=(*kept, made)))


def revoke(state: PeopleState, broadcast_id: str, invite_id: str) -> PeopleState:
    """The link stops working, and whoever joined with it leaves the stage."""
    current = room(state, broadcast_id)
    found = next((item for item in current.invites if item.id == invite_id), None)
    if found is None:
        raise PeopleError(404, "invite", "That invite no longer exists.")
    if found.revoked:
        return state
    current = _with_invite(current, replace(found, revoked=True))
    return _put(
        state, broadcast_id, replace(current, stage=tuple(p for p in current.stage if p != invite_id))
    )


def unseated(state: PeopleState, broadcast_id: str, invite_id: str) -> PeopleState:
    """Whoever joined with the link is out of the call room."""
    current = room(state, broadcast_id)
    found = next((item for item in current.invites if item.id == invite_id), None)
    if found is None or found.user_id is None:
        return state
    return _put(state, broadcast_id, _with_invite(current, replace(found, user_id=None)))


def end(state: PeopleState, broadcast_id: str) -> PeopleState:
    """The broadcast is over: every link stops working, and the room and stage are gone."""
    current = state.rooms.get(broadcast_id)
    if current is None:
        return state
    revoked = tuple(replace(item, revoked=True) for item in current.invites)
    return _put(state, broadcast_id, Room(invites=revoked, host_name=current.host_name))


def needs_ending(state: PeopleState, broadcast_id: str) -> bool:
    current = state.rooms.get(broadcast_id)
    if current is None:
        return False
    return current.room_id is not None or bool(current.stage) or any(not i.revoked for i in current.invites)


def keep_only(state: PeopleState, broadcast_ids: Collection[str]) -> PeopleState:
    """Forget the people of broadcasts that no longer exist."""
    kept = {bid: current for bid, current in state.rooms.items() if bid in broadcast_ids}
    return state if len(kept) == len(state.rooms) else replace(state, rooms=kept)


# --- joining -----------------------------------------------------------------------------------


def open_room(state: PeopleState, broadcast_id: str, room_id: str) -> PeopleState:
    return _put(state, broadcast_id, replace(room(state, broadcast_id), room_id=room_id))


def joinable(state: PeopleState, secret: str, broadcast_state: str, name: str) -> tuple[str, Invitation, str]:
    """What joining with this link needs, checked before anyone is given a seat."""
    broadcast_id, item = usable(state, secret)
    if broadcast_state == "ended":
        raise PeopleError(404, "invite", GONE)
    return broadcast_id, item, clean_name(name)


def join(state: PeopleState, secret: str, name: str, user_id: str) -> PeopleState:
    """Whoever opens the link takes its place; joining again replaces the earlier session."""
    broadcast_id, item = usable(state, secret)
    joined = replace(item, joined_name=clean_name(name), user_id=user_id)
    return _put(state, broadcast_id, _with_invite(room(state, broadcast_id), joined))


def seat_host(state: PeopleState, broadcast_id: str, name: str, user_id: str) -> PeopleState:
    current = room(state, broadcast_id)
    return _put(state, broadcast_id, replace(current, host_name=clean_name(name), host_user_id=user_id))


def seat_program(state: PeopleState, broadcast_id: str, user_id: str) -> PeopleState:
    return _put(state, broadcast_id, replace(room(state, broadcast_id), program_user_id=user_id))


def is_cohost(state: PeopleState, secret: str) -> bool:
    try:
        _, item = usable(state, secret)
    except PeopleError:
        return False
    return item.role == "cohost" and item.user_id is not None


# --- the stage ---------------------------------------------------------------------------------


def set_stage(state: PeopleState, broadcast_id: str, people: list[str]) -> PeopleState:
    """Who is on stage, in order: the host and guests who joined. Members stay backstage."""
    current = room(state, broadcast_id)
    if len(people) > MAX_STAGE:
        raise PeopleError(409, "people", f"At most {MAX_STAGE} people fit on the stage.")
    if len(set(people)) != len(people):
        raise PeopleError(422, "people", "Each person can be on the stage once.")
    invited_now = {item.id: item for item in current.invites if not item.revoked}
    for person in people:
        if person == HOST:
            if current.host_user_id is None:
                raise PeopleError(409, "people", "Turn on your camera before going on stage.")
            continue
        item = invited_now.get(person)
        if item is None:
            raise PeopleError(404, "people", "That person is no longer invited.")
        if item.role == "member":
            raise PeopleError(409, "people", "Members stay backstage; they cannot go on stage.")
        if item.user_id is None:
            raise PeopleError(409, "people", "That guest has not joined yet.")
    return _put(state, broadcast_id, replace(current, stage=tuple(people)))


def muted_live(current: Room, person: str, live: bool) -> bool:
    """While the broadcast is live, everyone off stage is muted."""
    return live and person not in current.stage


# --- views -------------------------------------------------------------------------------------


def view(
    state: PeopleState,
    broadcast_id: str,
    *,
    service: Service,
    public_origin: str | None,
    present: Collection[str],
    now: float,
) -> People:
    current = room(state, broadcast_id)
    by_id = {item.id: item for item in current.invites}
    stage = []
    for person in current.stage:
        if person == HOST:
            seated = current.host_user_id is not None
            stage.append(
                StagePerson(id=HOST, name=current.host_name, acs_id=current.host_user_id, present=seated)
            )
        else:
            item = by_id[person]
            stage.append(
                StagePerson(
                    id=item.id, name=_person_name(item), acs_id=item.user_id, present=item.id in present
                )
            )
    return People(
        revision=state.revision,
        server_time=now,
        broadcast_id=broadcast_id,
        service=service,
        room_id=current.room_id,
        public_origin=public_origin,
        invites=[
            Invite(
                id=item.id,
                role=item.role,
                name=item.name,
                link=f"/guest/{item.secret}",
                made_at=item.made_at,
                joined_name=item.joined_name,
                acs_id=item.user_id,
                present=item.id in present and not item.revoked,
                revoked=item.revoked,
            )
            for item in current.invites
        ],
        stage=stage,
        host_name=current.host_name,
        host_acs_id=current.host_user_id,
    )


def guest_view(
    state: PeopleState, secret: str, broadcast: Broadcast | None, *, service: Service, now: float
) -> Guest:
    """What a guest's page shows. It says nothing about the other guests or their links."""
    broadcast_id, item = find_secret(state, secret)
    current = room(state, broadcast_id)
    broadcast_state = broadcast.state if broadcast is not None else "ended"
    valid = not item.revoked and broadcast_state != "ended"
    joined = valid and item.user_id is not None
    return Guest(
        revision=state.revision,
        server_time=now,
        valid=valid,
        service=service,
        broadcast_id=broadcast_id if valid and item.role == "cohost" else None,
        broadcast_title=broadcast.title if broadcast is not None else "",
        broadcast_state=broadcast_state,
        role=item.role,
        name=item.name,
        joined=joined,
        joined_name=item.joined_name,
        room_id=current.room_id if joined else None,
        on_stage=valid and item.id in current.stage,
        muted_live=valid and muted_live(current, item.id, broadcast_state == "live"),
    )


# --- saving ------------------------------------------------------------------------------------


def dump(state: PeopleState) -> dict:
    return {
        "revision": state.revision,
        "rooms": {bid: asdict(current) for bid, current in state.rooms.items()},
    }


def load(record: dict) -> PeopleState:
    """A saved state. Raises ValueError, TypeError or KeyError when the record cannot be used."""
    saved = record.get("rooms")
    if not isinstance(saved, dict):
        raise ValueError("the record has no rooms")
    rooms = {}
    for broadcast_id, raw in saved.items():
        invites = tuple(Invitation(**item) for item in raw["invites"])
        stage = tuple(raw["stage"])
        known = {HOST, *(item.id for item in invites)}
        if any(item.role not in ROLES for item in invites) or any(person not in known for person in stage):
            raise ValueError("an unknown role or person")
        rooms[str(broadcast_id)] = Room(**{**raw, "invites": invites, "stage": stage})
    return PeopleState(revision=int(record["revision"]), rooms=rooms)
