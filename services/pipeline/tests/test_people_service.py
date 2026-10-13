import asyncio

import pytest

from kickstream.adapters.fake_rooms import FakeRooms
from kickstream.people import rules
from kickstream.people.rules import PeopleError
from kickstream.people.service import PeopleService
from tests.people_fakes import FakeBroadcasts, MemoryRecords, broadcast

NOW = 1_000.0


def made(broadcasts=None, *, rooms=True, store=None):
    broadcasts = broadcasts or FakeBroadcasts(broadcast())
    fake = FakeRooms(now=lambda: NOW) if rooms else None
    ids = iter(f"i{n}" for n in range(1, 100))
    secrets = iter(f"secret-{n}" for n in range(1, 100))
    service = PeopleService(
        store if store is not None else MemoryRecords(),
        fake,
        find_broadcast=broadcasts.find,
        broadcast_changes=broadcasts.changes,
        public_origin="https://guests.example",
        now=lambda: NOW,
        new_id=lambda: next(ids),
        new_secret=lambda: next(secrets),
    )
    return service, fake, broadcasts


async def until(check, limit_s=1.0):
    deadline = asyncio.get_running_loop().time() + limit_s
    while not check():
        assert asyncio.get_running_loop().time() < deadline, "the condition was not reached"
        await asyncio.sleep(0.01)


def refusal(caught) -> tuple[int, str]:
    return caught.value.status, caught.value.field


async def test_inviting_opens_the_broadcasts_room_once_and_saves_the_invites():
    store = MemoryRecords()
    service, rooms, _ = made(store=store)
    await service.invite("b1", "speaker", "Sam")
    doc = await service.invite("b1", "member", None)
    assert doc.room_id == "room-1" and rooms.calls.count("open_room") == 1
    assert [item.id for item in doc.invites] == ["i1", "i2"]
    assert (doc.service, doc.public_origin, doc.revision) == ("fake", "https://guests.example", 3)
    assert store.record["rooms"]["b1"]["invites"][0]["secret"] == "secret-1"


async def test_without_a_calling_service_inviting_explains_the_setup():
    service, _, _ = made(rooms=False)
    assert service.view("b1").service is None
    with pytest.raises(PeopleError) as refused:
        await service.invite("b1", "speaker", None)
    assert refusal(refused) == (503, "rooms") and "KICKSTREAM_ACS_CONNECTION_STRING" in refused.value.message


async def test_a_calling_service_failure_is_reported_and_nothing_is_kept():
    service, rooms, _ = made()
    rooms.fails = "quota exceeded"
    with pytest.raises(PeopleError) as refused:
        await service.invite("b1", "speaker", None)
    assert refusal(refused) == (502, "rooms") and "quota exceeded" in refused.value.message
    assert service.view("b1").invites == []


async def test_an_unknown_broadcast_is_refused():
    service, _, _ = made()
    with pytest.raises(PeopleError) as refused:
        service.view("nope")
    assert refusal(refused) == (404, "broadcast")


async def test_a_guest_joins_with_a_seat_in_the_room_for_their_role():
    service, rooms, _ = made()
    await service.invite("b1", "cohost", None)
    await service.invite("b1", "member", None)
    cohost = await service.join("secret-1", "Kim")
    assert (cohost.room_id, cohost.service) == ("room-1", "fake") and cohost.token.startswith("token-")
    member = await service.join("secret-2", "Mo")
    assert rooms.rooms["room-1"] == {cohost.acs_id: "presenter", member.acs_id: "attendee"}
    assert service.is_cohost("secret-1") and not service.is_cohost("secret-2")


async def test_joining_again_with_the_same_link_ends_the_earlier_session():
    service, rooms, _ = made()
    await service.invite("b1", "speaker", None)
    await service.join("secret-1", "Sam")
    second = await service.join("secret-1", "Sam")
    assert list(rooms.rooms["room-1"]) == [second.acs_id]


async def test_an_earlier_session_that_cannot_be_ended_keeps_the_link_as_it_was():
    service, rooms, _ = made()
    await service.invite("b1", "speaker", None)
    first = await service.join("secret-1", "Sam")
    seats = rooms.calls.count("seat")
    rooms.fails = "service unavailable"
    with pytest.raises(PeopleError) as refused:
        await service.join("secret-1", "Sam")
    assert refusal(refused) == (502, "rooms")
    assert refused.value.message.endswith("ended (service unavailable). Try joining again.")
    assert list(rooms.rooms["room-1"]) == [first.acs_id] and rooms.calls.count("seat") == seats
    assert service.view("b1").invites[0].acs_id == first.acs_id


async def test_a_guest_refreshes_their_token_only_after_joining():
    service, _, _ = made()
    await service.invite("b1", "speaker", None)
    with pytest.raises(PeopleError) as early:
        await service.refresh("secret-1")
    assert refusal(early) == (409, "invite")
    seat = await service.join("secret-1", "Sam")
    fresh = await service.refresh("secret-1")
    assert fresh.acs_id == seat.acs_id and fresh.token != seat.token


async def test_revoking_unseats_the_guest_and_their_link_stops_working():
    service, rooms, _ = made()
    await service.invite("b1", "speaker", None)
    await service.join("secret-1", "Sam")
    doc = await service.revoke("b1", "i1")
    assert doc.invites[0].revoked and rooms.rooms["room-1"] == {}
    assert service.guest("secret-1").valid is False


async def test_a_guest_the_calling_service_keeps_is_reported_and_revoking_again_retries():
    service, rooms, _ = made()
    await service.invite("b1", "speaker", None)
    seat = await service.join("secret-1", "Sam")
    rooms.fails = "service unavailable"
    with pytest.raises(PeopleError) as refused:
        await service.revoke("b1", "i1")
    assert refusal(refused) == (502, "rooms")
    assert refused.value.message.endswith("call (service unavailable). Press Revoke again to try again.")
    assert service.view("b1").invites[0].revoked and seat.acs_id in rooms.rooms["room-1"]
    rooms.fails = None
    await service.revoke("b1", "i1")
    assert rooms.rooms["room-1"] == {}
    unseats = rooms.calls.count("unseat")
    await service.revoke("b1", "i1")
    assert rooms.calls.count("unseat") == unseats


async def test_a_new_invite_keeps_a_revoked_guest_still_in_the_call_so_revoking_can_be_retried():
    service, rooms, _ = made()
    await service.invite("b1", "speaker", None)
    seat = await service.join("secret-1", "Sam")
    rooms.fails = "service unavailable"
    with pytest.raises(PeopleError):
        await service.revoke("b1", "i1")
    rooms.fails = None
    await service.invite("b1", "member", None)
    await service.revoke("b1", "i1")
    assert seat.acs_id not in rooms.rooms["room-1"]


async def test_the_host_and_program_keep_their_identity_and_get_fresh_tokens():
    service, rooms, _ = made()
    with pytest.raises(PeopleError) as no_room:
        await service.program_seat("b1")
    assert refusal(no_room) == (409, "room")
    host = await service.host_seat("b1", "Alex")
    again = await service.host_seat("b1", "Alex")
    assert host.acs_id == again.acs_id and host.token != again.token
    program = await service.program_seat("b1")
    assert rooms.rooms["room-1"] == {host.acs_id: "presenter", program.acs_id: "consumer"}
    doc = service.view("b1")
    assert (doc.host_acs_id, doc.host_name) == (host.acs_id, "Alex")


async def test_the_stage_follows_the_rules():
    service, _, _ = made()
    await service.invite("b1", "member", None)
    await service.join("secret-1", "Mia")
    with pytest.raises(PeopleError) as refused:
        service.set_stage("b1", ["i1"])
    assert refusal(refused) == (409, "people")


async def test_a_guest_shows_as_present_while_their_page_is_open():
    service, _, _ = made()
    await service.invite("b1", "speaker", None)
    with service.attending("secret-1"):
        with service.attending("secret-1"):
            assert service.view("b1").invites[0].present
        assert service.view("b1").invites[0].present
    assert not service.view("b1").invites[0].present
    with service.attending("unknown"):
        pass


async def test_pages_get_the_document_and_then_each_change():
    service, _, _ = made()
    stream = service.changes("b1")
    first = await anext(stream)
    await service.invite("b1", "speaker", None)
    second = await asyncio.wait_for(anext(stream), 1)
    assert (len(first.invites), len(second.invites)) == (0, 1)
    await stream.aclose()


async def test_a_broadcast_that_ends_or_is_deleted_lets_its_guests_go_and_closes_its_room():
    service, rooms, broadcasts = made(FakeBroadcasts(broadcast(), broadcast(id_="b2")))
    await service.invite("b1", "speaker", None)
    await service.invite("b2", "speaker", None)
    task = asyncio.create_task(service.run())
    try:
        broadcasts.set(broadcast(state="ended"))
        broadcasts.delete("b2")
        await until(lambda: rooms.rooms == {})
        assert service.guest("secret-1").valid is False and service.guest("secret-2").valid is False
    finally:
        task.cancel()


async def test_a_guest_page_hears_when_the_broadcast_goes_live():
    service, _, broadcasts = made()
    await service.invite("b1", "speaker", None)
    task = asyncio.create_task(service.run())
    stream = service.guest_changes("secret-1")
    try:
        assert (await anext(stream)).muted_live is False
        broadcasts.set(broadcast(state="live"))
        while not (await asyncio.wait_for(anext(stream), 1)).muted_live:
            pass
    finally:
        await stream.aclose()
        task.cancel()


async def test_a_saved_file_that_cannot_be_used_is_set_aside():
    store = MemoryRecords({"revision": 1, "rooms": []})
    service, _, _ = made(store=store)
    assert store.aside and service.view("b1").invites == []


async def test_people_of_broadcasts_that_no_longer_exist_are_forgotten_at_start():
    state = rules.invite(rules.PeopleState(), "gone", "ready", "x", "speaker", None, "secret-x", NOW)
    store = MemoryRecords(rules.dump(state))
    service, _, _ = made(store=store)
    await service.invite("b1", "speaker", None)
    assert list(store.record["rooms"]) == ["b1"]


async def test_a_change_that_cannot_be_saved_is_refused():
    store = MemoryRecords()
    store.fails = True
    service, _, _ = made(store=store)
    with pytest.raises(PeopleError) as refused:
        await service.invite("b1", "speaker", None)
    assert refusal(refused) == (503, "people")
