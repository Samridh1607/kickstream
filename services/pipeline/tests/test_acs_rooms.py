from datetime import UTC, datetime

import pytest
from azure.core.exceptions import HttpResponseError, ResourceNotFoundError

from kickstream.adapters.acs_rooms import AcsRooms, epoch
from kickstream.ports.calls import RoomsFailure, Seat

CONNECTION = "endpoint=https://example.communication.azure.com/;accesskey=c2VjcmV0"


class Made:
    def __init__(self, id_):
        self.id = id_


class Token:
    def __init__(self, token, expires_on):
        self.token = token
        self.expires_on = expires_on


class User:
    def __init__(self, id_):
        self.properties = {"id": id_}


class FakeRoomsClient:
    def __init__(self):
        self.calls = []
        self.fails = None

    def _record(self, *call):
        if self.fails is not None:
            raise self.fails
        self.calls.append(call)

    def create_room(self, *, valid_until, **_):
        self._record("create_room", valid_until)
        return Made("room-9")

    def add_or_update_participants(self, *, room_id, participants):
        roles = [(p.communication_identifier.properties["id"], p.role.value) for p in participants]
        self._record("add", room_id, roles)

    def remove_participants(self, *, room_id, participants):
        self._record("remove", room_id, [p.properties["id"] for p in participants])

    def delete_room(self, room_id):
        self._record("delete", room_id)


class FakeIdentityClient:
    def __init__(self, expires_on="2026-10-14T10:00:00Z"):
        self.expires_on = expires_on
        self.users = 0
        self.revoked = []
        self.fails = None

    def create_user_and_token(self, scopes):
        self.users += 1
        return User(f"8:acs:u{self.users}"), Token(f"t{self.users}", self.expires_on)

    def get_token(self, user, scopes):
        if self.fails is not None:
            raise self.fails
        return Token(f"fresh-{user.properties['id']}", self.expires_on)

    def revoke_tokens(self, user):
        if self.fails is not None:
            raise self.fails
        self.revoked.append(user.properties["id"])


def made(rooms=None, identity=None):
    rooms = rooms or FakeRoomsClient()
    identity = identity or FakeIdentityClient()
    adapter = AcsRooms(CONNECTION, make_rooms=lambda _: rooms, make_identity=lambda _: identity)
    return adapter, rooms, identity


EXPIRES = datetime(2026, 10, 14, 10, tzinfo=UTC).timestamp()


def test_the_adapter_is_named_for_the_web_client():
    assert AcsRooms(CONNECTION).name == "acs"


async def test_a_room_is_opened_until_the_given_time():
    adapter, rooms, _ = made()
    assert await adapter.open_room(1_800_000_000.0) == "room-9"
    assert rooms.calls == [("create_room", datetime.fromtimestamp(1_800_000_000, UTC))]


async def test_a_seat_is_a_new_identity_in_the_room_with_its_role():
    adapter, rooms, _ = made()
    assert await adapter.seat("room-9", "consumer") == Seat("8:acs:u1", "t1", EXPIRES)
    assert await adapter.seat("room-9", "presenter") == Seat("8:acs:u2", "t2", EXPIRES)
    assert rooms.calls == [
        ("add", "room-9", [("8:acs:u1", "Consumer")]),
        ("add", "room-9", [("8:acs:u2", "Presenter")]),
    ]


def test_a_seat_does_not_show_its_token():
    assert "secret-token" not in repr(Seat("8:acs:u1", "secret-token", EXPIRES))


async def test_a_token_is_refreshed_for_the_same_identity():
    adapter, _, _ = made()
    assert await adapter.refresh("8:acs:u1") == Seat("8:acs:u1", "fresh-8:acs:u1", EXPIRES)


async def test_unseating_and_closing_reach_the_room():
    adapter, rooms, _ = made()
    await adapter.unseat("room-9", "8:acs:u1")
    await adapter.close_room("room-9")
    assert rooms.calls == [("remove", "room-9", ["8:acs:u1"]), ("delete", "room-9")]


async def test_unseating_someone_stops_their_tokens_and_can_be_repeated():
    adapter, _, identity = made()
    await adapter.unseat("room-9", "8:acs:u1")
    await adapter.unseat("room-9", "8:acs:u1")
    assert identity.revoked == ["8:acs:u1", "8:acs:u1"]


async def test_unseating_someone_the_service_cannot_find_is_not_a_failure():
    rooms, identity = FakeRoomsClient(), FakeIdentityClient()
    rooms.fails = ResourceNotFoundError(message="Participant not found.")
    identity.fails = ResourceNotFoundError(message="Identity not found.")
    adapter, _, _ = made(rooms=rooms, identity=identity)
    await adapter.unseat("room-9", "8:acs:u1")


@pytest.mark.parametrize(
    "value",
    ["2026-10-14T10:00:00Z", "2026-10-14T10:00:00+00:00", datetime(2026, 10, 14, 10, tzinfo=UTC), EXPIRES],
)
def test_a_token_expiry_is_read_whatever_form_the_sdk_gives(value):
    assert epoch(value) == EXPIRES


async def test_a_service_error_becomes_a_rooms_failure_with_its_reason():
    rooms = FakeRoomsClient()
    rooms.fails = HttpResponseError(message="Quota exceeded for this resource.")
    adapter, _, _ = made(rooms=rooms)
    with pytest.raises(RoomsFailure, match="Quota exceeded"):
        await adapter.open_room(1_800_000_000.0)


async def test_a_bad_connection_string_is_reported_without_repeating_it():
    def refuse(_):
        raise ValueError("Invalid connection string")

    adapter = AcsRooms("endpoint=nonsense;accesskey=topsecret", make_rooms=refuse, make_identity=refuse)
    with pytest.raises(RoomsFailure) as failed:
        await adapter.open_room(1_800_000_000.0)
    assert "KICKSTREAM_ACS_CONNECTION_STRING" in str(failed.value) and "topsecret" not in str(failed.value)
    with pytest.raises(RoomsFailure, match="KICKSTREAM_ACS_CONNECTION_STRING"):
        await adapter.refresh("8:acs:u1")


async def test_an_answer_the_sdk_cannot_read_is_not_blamed_on_the_connection_string():
    identity = FakeIdentityClient(expires_on="not a time")
    adapter, _, _ = made(identity=identity)
    with pytest.raises(RoomsFailure) as failed:
        await adapter.refresh("8:acs:u1")
    assert str(failed.value) == "The calling service gave an answer Kickstream could not read."
