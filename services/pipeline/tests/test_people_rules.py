import json

import pytest

from kickstream.people import rules
from kickstream.people.rules import HOST, PeopleError, PeopleState
from tests.people_fakes import broadcast

NOW = 1_000.0


def invited(state=None, *, role="speaker", name=None, n=1, broadcast_state="ready") -> PeopleState:
    return rules.invite(
        state or PeopleState(), "b1", broadcast_state, f"i{n}", role, name, f"secret-{n}", NOW
    )


def joined(state, *, n=1, name="Sam", user="8:acs:u1") -> PeopleState:
    return rules.join(state, f"secret-{n}", name, user)


def two_guests() -> PeopleState:
    state = joined(invited(n=1), n=1, user="8:acs:u1")
    return joined(invited(state, n=2), n=2, name="Kim", user="8:acs:u2")


def view(state, present=frozenset()):
    return rules.view(state, "b1", service="fake", public_origin=None, present=present, now=NOW)


def guest(state, secret="secret-1", state_="ready"):
    return rules.guest_view(state, secret, broadcast(state_), service="fake", now=NOW)


def refusal(caught) -> tuple[int, str]:
    return caught.value.status, caught.value.field


def test_an_invite_has_a_role_an_optional_name_and_a_secret_link():
    [invite] = view(invited(name="  Sam   Lee ")).invites
    assert (invite.id, invite.role, invite.name, invite.link) == (
        "i1",
        "speaker",
        "Sam Lee",
        "/guest/secret-1",
    )
    assert (invite.joined_name, invite.acs_id, invite.present, invite.revoked) == (None, None, False, False)
    assert view(invited(name="   ")).invites[0].name is None


def test_an_ended_broadcast_takes_no_invites_and_a_broadcast_takes_at_most_twelve():
    with pytest.raises(PeopleError) as ended:
        invited(broadcast_state="ended")
    assert refusal(ended) == (409, "broadcast")
    state = PeopleState()
    for n in range(rules.MAX_INVITES):
        state = invited(state, n=n)
    with pytest.raises(PeopleError) as full:
        invited(state, n=99)
    assert refusal(full) == (409, "invites")


def test_an_unknown_role_is_refused():
    with pytest.raises(PeopleError) as unknown:
        invited(role="boss")
    assert refusal(unknown) == (422, "role")


def test_names_are_one_to_forty_characters():
    with pytest.raises(PeopleError) as long_invite:
        invited(name="x" * 41)
    assert refusal(long_invite) == (422, "name")
    for bad in ("", "   ", "y" * 41):
        with pytest.raises(PeopleError) as bad_join:
            rules.joinable(invited(), "secret-1", "ready", bad)
        assert refusal(bad_join) == (422, "name")


def test_joining_records_the_name_and_identity_and_joining_again_replaces_them():
    state = joined(joined(invited(), name="Sam"), name="Sam again", user="8:acs:u2")
    invite = view(state, {"i1"}).invites[0]
    assert (invite.joined_name, invite.acs_id, invite.present) == ("Sam again", "8:acs:u2", True)


def test_an_unknown_revoked_or_ended_link_is_no_longer_valid():
    with pytest.raises(PeopleError) as unknown:
        rules.joinable(PeopleState(), "nope", "ready", "Sam")
    assert unknown.value.status == 404 and unknown.value.message == rules.GONE
    with pytest.raises(PeopleError):
        rules.joinable(rules.revoke(invited(), "b1", "i1"), "secret-1", "ready", "Sam")
    with pytest.raises(PeopleError) as ended:
        rules.joinable(invited(), "secret-1", "ended", "Sam")
    assert ended.value.status == 404


def test_revoking_takes_the_guest_off_stage_and_twice_changes_nothing():
    state = rules.revoke(rules.set_stage(joined(invited()), "b1", ["i1"]), "b1", "i1")
    doc = view(state)
    assert doc.invites[0].revoked and doc.stage == []
    assert rules.revoke(state, "b1", "i1") is state
    with pytest.raises(PeopleError) as missing:
        rules.revoke(state, "b1", "nope")
    assert refusal(missing) == (404, "invite")


def test_a_new_invite_clears_away_revoked_ones():
    state = invited(rules.revoke(invited(), "b1", "i1"), n=2)
    assert [item.id for item in rules.room(state, "b1").invites] == ["i2"]


def test_the_stage_takes_the_host_and_joined_guests_in_order():
    state = rules.seat_host(joined(invited()), "b1", "Alex", "8:acs:host")
    stage = view(rules.set_stage(state, "b1", ["i1", HOST]), {"i1"}).stage
    assert [(p.id, p.name, p.acs_id, p.present) for p in stage] == [
        ("i1", "Sam", "8:acs:u1", True),
        (HOST, "Alex", "8:acs:host", True),
    ]


@pytest.mark.parametrize(
    ("people", "expected"),
    [
        (["m"], (409, "people")),  # a Member
        (["waiting"], (409, "people")),  # has not joined
        ([HOST], (409, "people")),  # the host has no camera yet
        (["i3", "i4", "i5", "i6", "i7"], (409, "people")),  # five
        (["i3", "i3"], (422, "people")),
        (["gone"], (404, "people")),
    ],
)
def test_the_stage_refuses_members_strangers_and_crowds(people, expected):
    state = rules.invite(PeopleState(), "b1", "ready", "m", "member", None, "secret-m", NOW)
    state = rules.join(state, "secret-m", "Mia", "8:acs:m")
    state = rules.invite(state, "b1", "ready", "waiting", "speaker", None, "secret-w", NOW)
    for n in range(3, 8):
        state = joined(invited(state, n=n), n=n, user=f"8:acs:{n}")
    with pytest.raises(PeopleError) as refused:
        rules.set_stage(state, "b1", people)
    assert refusal(refused) == expected


def test_everyone_off_stage_is_muted_while_live():
    state = rules.set_stage(two_guests(), "b1", ["i1"])
    on, off = guest(state, "secret-1", "live"), guest(state, "secret-2", "live")
    assert (on.on_stage, on.muted_live, off.on_stage, off.muted_live) == (True, False, False, True)
    assert guest(state, "secret-2", "ready").muted_live is False


def test_the_guest_view_names_the_broadcast_and_nothing_about_other_guests():
    assert guest(two_guests()).model_dump() == {
        "revision": 0,
        "server_time": NOW,
        "valid": True,
        "service": "fake",
        "broadcast_id": None,
        "broadcast_title": "Derby day",
        "broadcast_state": "ready",
        "role": "speaker",
        "name": None,
        "joined": True,
        "joined_name": "Sam",
        "room_id": None,
        "on_stage": False,
        "muted_live": False,
    }


def test_a_joined_guest_learns_the_room():
    state = rules.open_room(joined(invited()), "b1", "room-1")
    assert guest(state).room_id == "room-1"
    assert guest(rules.open_room(invited(), "b1", "room-1")).room_id is None


def test_a_co_host_sees_their_broadcast_and_is_known_by_their_link_once_joined():
    state = invited(role="cohost")
    assert not rules.is_cohost(state, "secret-1")
    state = joined(state)
    assert rules.is_cohost(state, "secret-1") and not rules.is_cohost(state, "other")
    assert guest(state).broadcast_id == "b1"
    assert not rules.is_cohost(rules.revoke(state, "b1", "i1"), "secret-1")


def test_ending_revokes_every_invite_and_forgets_the_room_and_stage():
    state = rules.open_room(rules.set_stage(joined(invited()), "b1", ["i1"]), "b1", "room-1")
    assert rules.needs_ending(state, "b1")
    ended = rules.end(state, "b1")
    current = rules.room(ended, "b1")
    assert current.room_id is None and current.stage == () and all(i.revoked for i in current.invites)
    assert not rules.needs_ending(ended, "b1")
    assert guest(ended, state_="ended").valid is False


def test_a_deleted_broadcast_leaves_its_guests_an_invalid_link():
    doc = rules.guest_view(joined(invited()), "secret-1", None, service="fake", now=NOW)
    assert (doc.valid, doc.broadcast_state, doc.broadcast_title) == (False, "ended", "")


def test_only_the_people_of_broadcasts_that_still_exist_are_kept():
    state = rules.invite(invited(), "b2", "ready", "x", "speaker", None, "secret-x", NOW)
    assert list(rules.keep_only(state, ["b1"]).rooms) == ["b1"]
    assert rules.keep_only(state, ["b1", "b2"]) is state


def test_people_survive_a_save_and_load():
    state = rules.set_stage(joined(invited()), "b1", ["i1"])
    state = rules.seat_program(rules.seat_host(state, "b1", "Alex", "8:acs:h"), "b1", "8:acs:p")
    state = rules.open_room(state, "b1", "room-1")
    assert rules.load(json.loads(json.dumps(rules.dump(state)))) == state


@pytest.mark.parametrize(
    "record",
    [
        {"revision": 0, "rooms": []},
        {"revision": 0},
        {"revision": "x", "rooms": {}},
        {"revision": 0, "rooms": {"b1": "x"}},
        {"revision": 0, "rooms": {"b1": {"invites": [{"id": "i1"}], "stage": []}}},
        {
            "revision": 0,
            "rooms": {
                "b1": {
                    "invites": [{"id": "i1", "role": "boss", "name": None, "secret": "s", "made_at": 1.0}],
                    "stage": [],
                }
            },
        },
        {"revision": 0, "rooms": {"b1": {"invites": [], "stage": ["nobody"]}}},
    ],
)
def test_a_record_that_cannot_be_used_raises_what_the_service_catches(record):
    with pytest.raises((ValueError, TypeError, KeyError)):
        rules.load(record)
