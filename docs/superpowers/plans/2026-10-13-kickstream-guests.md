# Guests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A streamer invites people into a broadcast by link, as a Speaker, Co-host or Member. The host's camera and every guest's camera and microphone work end to end: people on stage appear in the program, and their voices are on the stream.

**Architecture:** A new `people` feature in the pipeline, built like the others: `rules.py` (pure), `service.py` and `api.py`. It holds invites, the stage and call seats, and talks to a calling service through a `CallRooms` port. `AcsRooms` (Azure Communication Services Rooms) is the real adapter, and `FakeRooms` stands in for tests. The web app hides the calling SDK behind a `RoomCall` interface: `AcsRoomCall` for Azure and `LocalRoomCall` for the fake. Three pages use it: the studio's People panel, a new guest page at `/guest/{secret}`, and the program page, which joins as a receive-only Consumer, draws the new `cameras` scene element and mixes the room's sound into the stream. A public-host gate means a tunnel exposes only the guest routes.

**Tech Stack:**
- Pipeline: FastAPI, pydantic v2, pytest.
- Azure SDKs: `azure-communication-rooms` 1.2.0, `azure-communication-identity` 1.5.0, and `@azure/communication-calling` 2.0.0 with `@azure/communication-common` 2.5.0.
- Web: React 19, Fluent UI v9, vitest and Playwright.

Spec: `docs/superpowers/specs/2026-10-13-kickstream-guests-design.md` (section 2).

Two deliberate refinements of the spec:
- The people and guest documents carry `service` (`"acs"`, `"fake"` or null) instead of `configured`, so a page knows which call client to open before it has a seat. Null means "not configured".
- A request is public when it names a public host **or** carries any proxy header (`X-Forwarded-For`, `X-Forwarded-Host`, `Forwarded`, `CF-Connecting-IP`). This way a tunnel that rewrites Host to the local address cannot open the studio.

## Global Constraints

- Never paste, log, print, commit or echo the ACS connection string. It lives only in the git-ignored `.env` at the repository root, which the user writes. `Settings` must not show it in `repr`.
- Never set `KICKSTREAM_*` environment variables in a shared shell. Tests pass settings explicitly.
- Never stage `.playwright-mcp/` or `apps/web/tsconfig.tsbuildinfo`. Stage exact paths.
- The studio has no sign-in. Studio routes stay local; on a public host only `/api/guest/*` answers, plus everything for a valid co-host cookie.
- Secrets are compared in constant time (`hmac.compare_digest`). `people.json` is written owner-only (`private=True`).
- Roles:

  | Role | ACS role | On stage |
  |---|---|---|
  | Host | Presenter | Can be |
  | Co-host | Presenter | Can be |
  | Speaker | Attendee | Can be |
  | Member | Attendee | Never |
  | Program page | Consumer | Not applicable |

- Limits: at most 12 invites per broadcast, 4 people on stage, and names of 1–40 characters. A room is valid for 7 days, and a token for 24 hours.
- While the broadcast is live, everyone off stage is muted and cannot unmute.
- Refusals use the existing shape `{"detail":[{"loc":["body",field],"msg",...}]}`:
  - 404 for an unknown or revoked invite. The message is "This invite is no longer valid."
  - 409 for a full stage, a Member on stage, or an ended broadcast.
  - 503 when no calling service is set up.
  - 502 when the calling service fails.
- Code style: match the surrounding code. Write a comment only for a constraint the code cannot show. UI text is English and in sentence case.
- Commands:
  - Pipeline, in `services/pipeline`: `uv run pytest -q <files>`, `uv run ruff check .` and `uv run ruff format --check .`.
  - Web, in `apps/web`: `pnpm test`, `pnpm typecheck` and `pnpm e2e --reporter=line`.
  - Regenerate the contracts with `uv run python -m kickstream.tools.gen_contracts` (pipeline) and `pnpm gen:contracts` (web).

---

## File structure

Pipeline (`services/pipeline/kickstream/`):
- `people/__init__.py`, `people/rules.py`: invites, joining, stage, muting, views, save and load.
- `people/service.py`: state, saving, seats through `CallRooms`, presence, live documents, following broadcasts.
- `people/api.py`: studio routes under `/api/broadcasts/{id}/people`, guest routes under `/api/guest/{secret}`, and the co-host cookie.
- `ports/calls.py`: the `CallRooms` port, `Seat` and `RoomsFailure`.
- `adapters/fake_rooms.py`: in-memory rooms.
- `adapters/acs_rooms.py`: Azure Communication Services Rooms and Identity.
- `app.py`: settings (public hosts, ACS, fake rooms, `.env`), wiring, and the `PublicHostGate`.
- `studio/rules.py`, `studio/templates.py`: the `cameras` element props and the Interview template.
- `adapters/chromium_capture.py`: the capture browser reports a non-headless user agent.

Web (`apps/web/src/`):
- `calls/RoomCall.ts`: the interface.
- `calls/acs.ts`: `AcsRoomCall`.
- `calls/local.ts`: `LocalRoomCall`.
- `calls/open.ts`: `openRoomCall`.
- `calls/useCallUpdates.ts`, `calls/useDevices.ts`, `calls/DevicePickers.tsx`, `calls/VideoBox.tsx`.
- `people/api.ts`, `people/stage.ts`, `people/roomAudio.ts`.
- `people/GuestPage.tsx`, `people/PeoplePanel.tsx`, `people/useProgramCall.ts`.
- `studio/elements.tsx`, `studio/ProgramPage.tsx`, `studio/panels.tsx`, `studio/StudioPage.tsx`, `stream/useLiveDocument.ts`, `main.tsx`, `i18n.ts`.
- `test/FakeRoomCall.ts`, `test/fixtures.ts`.

Other:
- `packages/contracts/kickstream.schema.json`.
- `apps/web/vite.config.ts`, `apps/web/playwright.config.ts`, `apps/web/playwright.acs.config.ts`.
- `apps/web/e2e/guests.spec.ts`, `apps/web/e2e-acs/guests-acs.spec.ts`.
- `README.md`.

---

### Task 1: Contracts and the people rules

**Files:**
- Modify: `packages/contracts/kickstream.schema.json` (add the definitions after `Broadcasts`).
- Regenerate: `services/pipeline/kickstream/contracts.py` and `apps/web/src/contracts.ts`.
- Create: `services/pipeline/kickstream/people/__init__.py` (empty) and `services/pipeline/kickstream/people/rules.py`.
- Create: `services/pipeline/tests/people_fakes.py` and `services/pipeline/tests/test_people_rules.py`.
- Modify: `services/pipeline/tests/test_architecture.py` (add `"people"` to `STAGES`).

**Interfaces:**
- Produces, in contracts: `Invite`, `StagePerson`, `People`, `Guest` and `CallSeat`. The field names and types are exactly as in the schema below.
- Produces, in `kickstream.people.rules`:
  - Constants and types: `Role`, `Service`, `ROLES`, `ROLE_NAMES`, `HOST = "host"`, `MAX_INVITES`, `MAX_STAGE`, `MAX_NAME`, `GONE`, `PeopleError(Refusal)`.
  - Dataclasses: `Invitation`, `Room`, `PeopleState(revision=0, rooms={})`.
  - Lookups and checks:
    - `room(state, broadcast_id) -> Room`
    - `clean_name(text, field_="name") -> str`
    - `find_secret(state, secret) -> (broadcast_id, Invitation)`
    - `usable(state, secret) -> (broadcast_id, Invitation)`
    - `joinable(state, secret, broadcast_state, name) -> (broadcast_id, Invitation, clean_name)`
    - `needs_ending(state, broadcast_id) -> bool`
    - `is_cohost(state, secret) -> bool`
    - `muted_live(room, person, live) -> bool`
  - Changes, each returning a new `PeopleState`:
    - `invite(state, broadcast_id, broadcast_state, invite_id, role, name, secret, now)`
    - `revoke(state, broadcast_id, invite_id)`
    - `end(state, broadcast_id)`
    - `keep_only(state, broadcast_ids)`
    - `open_room(state, broadcast_id, room_id)`
    - `join(state, secret, name, user_id)`
    - `seat_host(state, broadcast_id, name, user_id)`
    - `seat_program(state, broadcast_id, user_id)`
    - `set_stage(state, broadcast_id, people)`
  - Views:
    - `view(state, broadcast_id, *, service, public_origin, present, now) -> People`
    - `guest_view(state, secret, broadcast: Broadcast | None, *, service, now) -> Guest`
  - Saving: `dump(state) -> dict` and `load(record) -> PeopleState`. `load` raises `ValueError`, `TypeError` or `KeyError` when the record cannot be used.
- Produces, in `tests/people_fakes.py`: `broadcast(state="ready", id_="b1", title="Derby day")`, `MemoryRecords` and `FakeBroadcasts`.

- [ ] **Step 1: Add the schema definitions**

In `packages/contracts/kickstream.schema.json`, after the `"Broadcasts": { ... }` definition (add a comma after its closing brace), insert:

```json
    "Invite": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "role", "link", "made_at", "present", "revoked"],
      "properties": {
        "id": { "type": "string", "minLength": 1, "maxLength": 64 },
        "role": { "enum": ["speaker", "cohost", "member"] },
        "name": { "type": ["string", "null"], "default": null },
        "link": { "type": "string" },
        "made_at": { "type": "number" },
        "joined_name": { "type": ["string", "null"], "default": null },
        "acs_id": { "type": ["string", "null"], "default": null },
        "present": { "type": "boolean" },
        "revoked": { "type": "boolean" }
      }
    },
    "StagePerson": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "name", "present"],
      "properties": {
        "id": { "type": "string", "minLength": 1, "maxLength": 64 },
        "name": { "type": "string" },
        "acs_id": { "type": ["string", "null"], "default": null },
        "present": { "type": "boolean" }
      }
    },
    "People": {
      "type": "object", "additionalProperties": false,
      "required": ["revision", "server_time", "broadcast_id", "invites", "stage", "host_name"],
      "properties": {
        "revision": { "type": "integer" },
        "server_time": { "type": "number" },
        "broadcast_id": { "type": "string" },
        "service": { "enum": ["acs", "fake", null], "default": null },
        "room_id": { "type": ["string", "null"], "default": null },
        "public_origin": { "type": ["string", "null"], "default": null },
        "invites": { "type": "array", "items": { "$ref": "#/$defs/Invite" }, "maxItems": 12 },
        "stage": { "type": "array", "items": { "$ref": "#/$defs/StagePerson" }, "maxItems": 4 },
        "host_name": { "type": "string" },
        "host_acs_id": { "type": ["string", "null"], "default": null }
      }
    },
    "Guest": {
      "type": "object", "additionalProperties": false,
      "required": ["revision", "server_time", "valid", "broadcast_title", "broadcast_state", "role", "joined", "on_stage", "muted_live"],
      "properties": {
        "revision": { "type": "integer" },
        "server_time": { "type": "number" },
        "valid": { "type": "boolean" },
        "service": { "enum": ["acs", "fake", null], "default": null },
        "broadcast_id": { "type": ["string", "null"], "default": null },
        "broadcast_title": { "type": "string" },
        "broadcast_state": { "enum": ["ready", "live", "ended"] },
        "role": { "enum": ["speaker", "cohost", "member"] },
        "name": { "type": ["string", "null"], "default": null },
        "joined": { "type": "boolean" },
        "joined_name": { "type": ["string", "null"], "default": null },
        "room_id": { "type": ["string", "null"], "default": null },
        "on_stage": { "type": "boolean" },
        "muted_live": { "type": "boolean" }
      }
    },
    "CallSeat": {
      "type": "object", "additionalProperties": false,
      "required": ["room_id", "acs_id", "token", "expires_at", "service"],
      "properties": {
        "room_id": { "type": "string" },
        "acs_id": { "type": "string" },
        "token": { "type": "string" },
        "expires_at": { "type": "number" },
        "service": { "enum": ["acs", "fake"] }
      }
    }
```

- [ ] **Step 2: Regenerate both contract files**

Run `uv run python -m kickstream.tools.gen_contracts` in `services/pipeline`, then `pnpm gen:contracts` in `apps/web`.

Expected: `contracts.py` gains `Invite`, `StagePerson`, `People`, `Guest` and `CallSeat`, and `contracts.ts` gains the same interfaces. `uv run pytest -q tests/test_contracts.py` passes.

- [ ] **Step 3: Write the test fakes**

Create `services/pipeline/tests/people_fakes.py`:

```python
"""Stand-ins for the people stage's neighbours: its saved file and the broadcasts."""

import asyncio
import json

from kickstream.contracts import Broadcast, Broadcasts, BroadcastStats


def broadcast(state="ready", id_="b1", title="Derby day") -> Broadcast:
    return Broadcast(
        id=id_,
        title=title,
        description="",
        record=False,
        state=state,
        created_at=1_000.0,
        sessions=[],
        recordings=[],
        moments=[],
        stats=BroadcastStats(live_s=0.0),
        reels=[],
        generating=False,
    )


class MemoryRecords:
    """A record store in memory. Saving goes through JSON, as the real file does."""

    def __init__(self, record: dict | None = None) -> None:
        self.record = record
        self.aside = False
        self.fails = False

    def load(self) -> dict | None:
        return self.record

    def save(self, record: dict) -> None:
        if self.fails:
            raise OSError("the disk is full")
        self.record = json.loads(json.dumps(record))

    def set_aside(self) -> None:
        self.aside = True
        self.record = None


class FakeBroadcasts:
    """The broadcasts as the people service sees them: look one up, and follow their changes."""

    def __init__(self, *broadcasts: Broadcast) -> None:
        self.items = {item.id: item for item in broadcasts}
        self._changed: asyncio.Queue[Broadcasts] = asyncio.Queue()

    def find(self, broadcast_id: str) -> Broadcast | None:
        return self.items.get(broadcast_id)

    def doc(self) -> Broadcasts:
        return Broadcasts(
            revision=0, server_time=0.0, broadcasts=list(self.items.values()), current_id=None, ai=False
        )

    def set(self, changed: Broadcast) -> None:
        self.items[changed.id] = changed
        self._changed.put_nowait(self.doc())

    def delete(self, broadcast_id: str) -> None:
        del self.items[broadcast_id]
        self._changed.put_nowait(self.doc())

    async def changes(self):
        yield self.doc()
        while True:
            yield await self._changed.get()
```

- [ ] **Step 4: Write the failing rules tests**

Create `services/pipeline/tests/test_people_rules.py`:

```python
import json

import pytest

from kickstream.people import rules
from kickstream.people.rules import HOST, PeopleError, PeopleState
from tests.people_fakes import broadcast

NOW = 1_000.0


def invited(state=None, *, role="speaker", name=None, n=1, broadcast_state="ready") -> PeopleState:
    return rules.invite(state or PeopleState(), "b1", broadcast_state, f"i{n}", role, name, f"secret-{n}", NOW)


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
    assert (invite.id, invite.role, invite.name, invite.link) == ("i1", "speaker", "Sam Lee", "/guest/secret-1")
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
```

Also add `"people",` to `STAGES` in `services/pipeline/tests/test_architecture.py`.

- [ ] **Step 5: Run the tests to see them fail**

Run: `uv run pytest -q tests/test_people_rules.py`
Expected: an error collecting the tests, `ModuleNotFoundError: No module named 'kickstream.people'`.

- [ ] **Step 6: Write the rules**

Create an empty `services/pipeline/kickstream/people/__init__.py`, then `services/pipeline/kickstream/people/rules.py`:

```python
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
    return _put(state, broadcast_id, replace(current, stage=tuple(p for p in current.stage if p != invite_id)))


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
            stage.append(StagePerson(id=HOST, name=current.host_name, acs_id=current.host_user_id, present=seated))
        else:
            item = by_id[person]
            stage.append(
                StagePerson(id=item.id, name=_person_name(item), acs_id=item.user_id, present=item.id in present)
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
    return {"revision": state.revision, "rooms": {bid: asdict(current) for bid, current in state.rooms.items()}}


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
```

- [ ] **Step 7: Run the tests to see them pass**

Run `uv run pytest -q tests/test_people_rules.py tests/test_architecture.py tests/test_contracts.py`, then `uv run ruff check .` and `uv run ruff format --check .`.
Expected: all pass, and ruff is clean. Run `uv run ruff format .` first if the format check asks for it.

- [ ] **Step 8: Commit**

```powershell
git add packages/contracts/kickstream.schema.json services/pipeline/kickstream/contracts.py apps/web/src/contracts.ts services/pipeline/kickstream/people services/pipeline/tests/people_fakes.py services/pipeline/tests/test_people_rules.py services/pipeline/tests/test_architecture.py
git commit -m "Add the people rules: invite links, joining, the stage and muting while live"
```

---

### Task 2: The CallRooms port, FakeRooms and the people service

**Files:**
- Create: `services/pipeline/kickstream/ports/calls.py`, `services/pipeline/kickstream/adapters/fake_rooms.py` and `services/pipeline/kickstream/people/service.py`.
- Test: `services/pipeline/tests/test_people_service.py`.

**Interfaces:**
- Consumes: everything from `kickstream.people.rules` (Task 1), and `MemoryRecords`, `FakeBroadcasts` and `broadcast` from `tests/people_fakes.py`.
- Produces, in `kickstream.ports.calls`: `CallRole = Literal["presenter","attendee","consumer"]`, `Seat(user_id, token, expires_at)`, `RoomsFailure(Exception)`, and the `CallRooms` protocol. Its methods are `name`, `open_room(valid_until) -> str`, `seat(room_id, role) -> Seat`, `refresh(user_id) -> Seat`, `unseat(room_id, user_id)` and `close_room(room_id)`. All are async except `name`.
- Produces `kickstream.adapters.fake_rooms.FakeRooms(now=time.time)`, with `name = "fake"` and the public fields `rooms: dict[room_id, dict[user_id, CallRole]]`, `fails: str | None` and `calls: list[str]`.
- Produces `kickstream.people.service.PeopleService(store, rooms, *, find_broadcast, broadcast_changes, public_origin=None, now, new_id, new_secret)`:
  - Reading: `service`, `view(broadcast_id) -> People`, `guest(secret) -> Guest`, `changes(broadcast_id)`, `guest_changes(secret)`, `is_cohost(secret) -> bool`, and the context manager `attending(secret)`.
  - Changing, all async: `invite(broadcast_id, role, name) -> People`, `revoke(broadcast_id, invite_id) -> People`, `host_seat(broadcast_id, name) -> CallSeat`, `program_seat(broadcast_id) -> CallSeat`, `join(secret, name) -> CallSeat` and `refresh(secret) -> CallSeat`. `set_stage(broadcast_id, people) -> People` is sync.
  - Running: `run()` follows the broadcasts.
- Produces `SETUP`, the message the service gives when no calling service is set up.

- [ ] **Step 1: Write the failing service tests**

Create `services/pipeline/tests/test_people_service.py`:

```python
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


async def until(check, timeout=1.0):
    deadline = asyncio.get_running_loop().time() + timeout
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `uv run pytest -q tests/test_people_service.py`
Expected: an error collecting the tests, `ModuleNotFoundError` for `kickstream.adapters.fake_rooms`.

- [ ] **Step 3: Write the port**

Create `services/pipeline/kickstream/ports/calls.py`:

```python
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
        """Take the identity out of the room. Raises RoomsFailure."""

    async def close_room(self, room_id: str) -> None:
        """Raises RoomsFailure."""
```

- [ ] **Step 4: Write FakeRooms**

Create `services/pipeline/kickstream/adapters/fake_rooms.py`:

```python
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
```

- [ ] **Step 5: Write the service**

Create `services/pipeline/kickstream/people/service.py`:

```python
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
                    log.warning("a revoked guest could not be taken out of the room: %s", exc)
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
            seat = await self._call(rooms.seat(room_id, ROLES_IN_THE_ROOM[item.role]))
            if item.user_id:
                try:
                    await rooms.unseat(room_id, item.user_id)
                except RoomsFailure as exc:
                    log.warning("an earlier session could not be taken out of the room: %s", exc)
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
```

- [ ] **Step 6: Run the tests to see them pass**

Run `uv run pytest -q tests/test_people_service.py tests/test_people_rules.py tests/test_architecture.py`, then `uv run ruff check .` and `uv run ruff format --check .`.
Expected: all pass, and ruff is clean.

- [ ] **Step 7: Commit**

```powershell
git add services/pipeline/kickstream/ports/calls.py services/pipeline/kickstream/adapters/fake_rooms.py services/pipeline/kickstream/people/service.py services/pipeline/tests/test_people_service.py
git commit -m "Add the people service: invites, seats in call rooms, presence and live documents"
```

---

### Task 3: People routes, settings, wiring and the public-host gate

**Files:**
- Create: `services/pipeline/kickstream/people/api.py`.
- Modify: `services/pipeline/kickstream/app.py`.
- Test: `services/pipeline/tests/test_people_api.py`.

**Interfaces:**
- Consumes: `PeopleService` and `SETUP` (Task 2), `FakeRooms` (Task 2) and `PeopleError` (Task 1).
- Produces `kickstream.people.api`: `build_people_router(*, service, socket_hosts=()) -> APIRouter` and `COHOST_COOKIE = "kickstream_cohost"`. The routes:
  - `GET /api/broadcasts/{id}/people` and `WS /api/broadcasts/{id}/people/socket`.
  - `POST .../people/invites` with `{role, name?}`, and `DELETE .../people/invites/{invite}`.
  - `PUT .../people/stage` with `{people}`.
  - `POST .../people/host/seat` with `{name}`, and `POST .../people/program/seat`.
  - `GET /api/guest/{secret}` and `WS /api/guest/{secret}/socket`.
  - `POST /api/guest/{secret}/join` with `{name}`, and `POST /api/guest/{secret}/seat/refresh`.
- Produces in `kickstream.app`:
  - New `Settings` fields: `public_hosts`, `acs_connection_string` (not in repr) and `rooms`.
  - `read_env_file(path) -> dict[str,str]` and `environment(path, base) -> dict`.
  - `PublicHostGate`.
  - A `Pipeline.people` field.
  - A `rooms: CallRooms | None = None` parameter on `build_pipeline` and `create_app`.
- Environment variables: `KICKSTREAM_PUBLIC_HOSTS`, `KICKSTREAM_ACS_CONNECTION_STRING` and `KICKSTREAM_ROOMS` (`fake`).

- [ ] **Step 1: Write the failing API tests**

Create `services/pipeline/tests/test_people_api.py`:

```python
import json

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from kickstream.adapters.clocks import InstantClock
from kickstream.adapters.fake_rooms import FakeRooms
from kickstream.app import Settings, create_app, environment

PUBLIC = "guests.example"


def build(tmp_path, *, rooms):
    settings = Settings(
        None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data", public_hosts=(PUBLIC,)
    )
    return create_app(
        settings, clock_factory=lambda speed: InstantClock(), match_prefix="m", now=lambda: 5_000.0, rooms=rooms
    )


@pytest.fixture
def rooms():
    return FakeRooms(now=lambda: 5_000.0)


@pytest.fixture
def client(tmp_path, rooms):
    with TestClient(build(tmp_path, rooms=rooms)) as test_client:
        yield test_client


def new_broadcast(client) -> str:
    return client.post("/api/broadcasts", json={"title": "Derby day"}).json()["current_id"]


def people(broadcast_id: str) -> str:
    return f"/api/broadcasts/{broadcast_id}/people"


def invite(client, broadcast_id, role="speaker", name=None) -> dict:
    body = {"role": role} if name is None else {"role": role, "name": name}
    return client.post(f"{people(broadcast_id)}/invites", json=body).json()["invites"][-1]


def secret_of(item: dict) -> str:
    return item["link"].rsplit("/", 1)[-1]


def field(response) -> str:
    return response.json()["detail"][0]["loc"][-1]


def next_matching(socket, check, limit=20) -> dict:
    for _ in range(limit):
        doc = json.loads(socket.receive_text())
        if check(doc):
            return doc
    raise AssertionError("no document matched")


def test_without_a_calling_service_inviting_explains_the_setup(tmp_path):
    with TestClient(build(tmp_path, rooms=None)) as client:
        b = new_broadcast(client)
        assert client.get(people(b)).json()["service"] is None
        refused = client.post(f"{people(b)}/invites", json={"role": "speaker"})
        assert (refused.status_code, field(refused)) == (503, "rooms")


def test_a_guest_is_invited_joins_and_goes_on_stage(client):
    b = new_broadcast(client)
    item = invite(client, b, name="Sam")
    doc = client.get(people(b)).json()
    assert (doc["service"], doc["public_origin"], doc["room_id"]) == ("fake", f"https://{PUBLIC}", "room-1")
    assert item["link"].startswith("/guest/") and item["name"] == "Sam"
    secret = secret_of(item)
    guest = client.get(f"/api/guest/{secret}").json()
    assert (guest["valid"], guest["broadcast_title"], guest["role"], guest["joined"]) == (
        True,
        "Derby day",
        "speaker",
        False,
    )
    seat = client.post(f"/api/guest/{secret}/join", json={"name": "Sam"}).json()
    assert (seat["room_id"], seat["service"]) == ("room-1", "fake")
    staged = client.put(f"{people(b)}/stage", json={"people": [item["id"]]}).json()
    assert [(p["id"], p["name"], p["acs_id"]) for p in staged["stage"]] == [(item["id"], "Sam", seat["acs_id"])]
    assert client.get(f"/api/guest/{secret}").json()["on_stage"] is True
    assert client.post(f"/api/guest/{secret}/seat/refresh").json()["acs_id"] == seat["acs_id"]


def test_refusals_name_what_was_wrong(client):
    b = new_broadcast(client)
    member = invite(client, b, role="member")
    client.post(f"/api/guest/{secret_of(member)}/join", json={"name": "Mia"})
    on_stage = client.put(f"{people(b)}/stage", json={"people": [member["id"]]})
    assert (on_stage.status_code, field(on_stage)) == (409, "people")
    unknown = client.get("/api/guest/nope")
    assert (unknown.status_code, unknown.json()["detail"][0]["msg"]) == (404, "This invite is no longer valid.")
    assert client.post(f"{people(b)}/invites", json={"role": "boss"}).status_code == 422
    assert client.post(f"/api/guest/{secret_of(member)}/join", json={"name": "x" * 41}).status_code == 422
    assert client.get(people("nope")).status_code == 404


def test_a_revoked_link_stops_working(client, rooms):
    b = new_broadcast(client)
    item = invite(client, b)
    client.post(f"/api/guest/{secret_of(item)}/join", json={"name": "Sam"})
    doc = client.delete(f"{people(b)}/invites/{item['id']}").json()
    assert doc["invites"][0]["revoked"] is True and rooms.rooms["room-1"] == {}
    assert client.get(f"/api/guest/{secret_of(item)}").json()["valid"] is False
    assert client.post(f"/api/guest/{secret_of(item)}/join", json={"name": "Sam"}).status_code == 404


def test_deleting_a_broadcast_lets_its_guests_go_and_closes_its_room(client, rooms):
    b = new_broadcast(client)
    item = invite(client, b)
    client.delete(f"/api/broadcasts/{b}")
    with client.websocket_connect(f"/api/guest/{secret_of(item)}/socket") as socket:
        next_matching(socket, lambda doc: doc["valid"] is False)
    assert rooms.rooms == {}


def test_the_host_and_the_program_get_seats_with_their_roles(client, rooms):
    b = new_broadcast(client)
    host = client.post(f"{people(b)}/host/seat", json={"name": "Alex"}).json()
    program = client.post(f"{people(b)}/program/seat").json()
    assert rooms.rooms[host["room_id"]] == {host["acs_id"]: "presenter", program["acs_id"]: "consumer"}
    assert client.get(people(b)).json()["host_name"] == "Alex"


def test_pages_follow_people_live_and_a_guest_page_shows_them_present(client):
    b = new_broadcast(client)
    secret = secret_of(invite(client, b))
    with client.websocket_connect(f"{people(b)}/socket") as studio:
        next_matching(studio, lambda doc: doc["invites"][0]["present"] is False)
        with client.websocket_connect(f"/api/guest/{secret}/socket") as guest:
            assert json.loads(guest.receive_text())["valid"] is True
            next_matching(studio, lambda doc: doc["invites"][0]["present"] is True)
        next_matching(studio, lambda doc: doc["invites"][0]["present"] is False)


def test_a_socket_for_an_unknown_broadcast_or_link_is_turned_away(client):
    for path in (f"{people('nope')}/socket", "/api/guest/nope/socket"):
        with pytest.raises(WebSocketDisconnect) as closed:
            with client.websocket_connect(path) as socket:
                socket.receive_text()
        assert closed.value.code == 4404


def test_on_a_public_host_only_the_guest_routes_answer(client):
    b = new_broadcast(client)
    secret = secret_of(invite(client, b))
    for headers in ({"host": PUBLIC}, {"x-forwarded-for": "203.0.113.9"}, {"x-forwarded-host": PUBLIC}):
        assert client.get("/api/broadcasts", headers=headers).status_code == 404
        assert client.get("/api/studio", headers=headers).status_code == 404
        assert client.get(f"/api/guest/{secret}", headers=headers).status_code == 200
    assert client.get("/api/broadcasts").status_code == 200
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/studio/socket", headers={"host": PUBLIC}) as socket:
            socket.receive_text()


def test_a_co_host_opens_the_studio_on_the_public_host_until_their_invite_is_revoked(client):
    b = new_broadcast(client)
    cohost, speaker = invite(client, b, role="cohost"), invite(client, b)
    answer = client.post(f"/api/guest/{secret_of(cohost)}/join", json={"name": "Kim"}, headers={"host": PUBLIC})
    cookie = answer.headers["set-cookie"].lower()
    assert f"kickstream_cohost={secret_of(cohost)}".lower() in cookie
    assert "httponly" in cookie and "secure" in cookie and "samesite=strict" in cookie
    client.post(f"/api/guest/{secret_of(speaker)}/join", json={"name": "Sam"})
    as_cohost = {"host": PUBLIC, "cookie": f"kickstream_cohost={secret_of(cohost)}"}
    as_speaker = {"host": PUBLIC, "cookie": f"kickstream_cohost={secret_of(speaker)}"}
    assert client.get("/api/broadcasts", headers=as_cohost).status_code == 200
    assert client.get("/api/broadcasts", headers=as_speaker).status_code == 404
    client.delete(f"{people(b)}/invites/{cohost['id']}")
    assert client.get("/api/broadcasts", headers=as_cohost).status_code == 404


def test_settings_read_guests_from_the_environment():
    settings = Settings.from_env(
        {
            "KICKSTREAM_PUBLIC_HOSTS": "Guests.Example, b.example",
            "KICKSTREAM_ACS_CONNECTION_STRING": "endpoint=https://x/;accesskey=abc==",
            "KICKSTREAM_ROOMS": "fake",
        }
    )
    assert settings.public_hosts == ("guests.example", "b.example") and settings.rooms == "fake"
    assert settings.acs_connection_string.endswith("abc==") and "accesskey" not in repr(settings)


def test_a_dotenv_file_fills_in_what_the_environment_leaves_out(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# guests\n"
        'KICKSTREAM_ACS_CONNECTION_STRING="endpoint=https://x/;accesskey=abc=="\n'
        "export KICKSTREAM_ROOMS=fake\n"
        "KICKSTREAM_PUBLIC_HOSTS=from-file\n",
        encoding="utf-8",
    )
    assert environment(env_file, {"KICKSTREAM_PUBLIC_HOSTS": "from-shell"}) == {
        "KICKSTREAM_ACS_CONNECTION_STRING": "endpoint=https://x/;accesskey=abc==",
        "KICKSTREAM_ROOMS": "fake",
        "KICKSTREAM_PUBLIC_HOSTS": "from-shell",
    }
    assert environment(tmp_path / "missing", {}) == {}
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `uv run pytest -q tests/test_people_api.py`
Expected: an error collecting the tests, `ImportError: cannot import name 'environment' from 'kickstream.app'`.

- [ ] **Step 3: Write the routes**

Create `services/pipeline/kickstream/people/api.py`:

```python
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
            response.set_cookie(COHOST_COOKIE, secret, httponly=True, secure=True, samesite="strict", path="/")
        return seat

    @router.post(f"{GUEST}/seat/refresh")
    async def post_refresh(secret: str) -> CallSeat:
        return await service.refresh(secret)

    return router
```

- [ ] **Step 4: Wire it into the app**

In `services/pipeline/kickstream/app.py`, make these changes.

Imports. Add `from http.cookies import CookieError, SimpleCookie` beside the other standard imports, and change `from collections.abc import Callable, Mapping` to `from collections.abc import Callable, Collection, Mapping`. Then add:

```python
from kickstream.adapters.acs_rooms import AcsRooms
from kickstream.adapters.fake_rooms import FakeRooms
from kickstream.people.api import COHOST_COOKIE, build_people_router
from kickstream.people.service import PeopleService
from kickstream.ports.calls import CallRooms
```

`AcsRooms` does not exist until Task 4, so leave its import out for now. In this task `_rooms` (below) knows only the fake; Task 4 adds the import and the Azure branch.

After `BodyLimit`, add the gate:

```python
_PROXIED = (b"x-forwarded-for", b"x-forwarded-host", b"forwarded", b"cf-connecting-ip")


class PublicHostGate:
    """On a public address only the guest routes answer, and the studio's only for a co-host.

    Guests reach Kickstream through a tunnel to the web server, and the studio has no sign-in. A
    request is public when it names a public host or came through any proxy: a tunnel that rewrites
    Host to the local address must not open the studio.
    """

    def __init__(self, app, *, public_hosts: Collection[str], is_cohost: Callable[[str], bool]) -> None:
        self._app = app
        self._public_hosts = frozenset(public_hosts)
        self._is_cohost = is_cohost

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] in ("http", "websocket") and self._public_hosts:
            headers = dict(scope["headers"])
            if self._is_public(headers) and not self._allowed(scope["path"], headers):
                if scope["type"] == "websocket":
                    await receive()
                    await send({"type": "websocket.close", "code": 1008})
                else:
                    await JSONResponse(status_code=404, content={"detail": "Not Found"})(scope, receive, send)
                return
        await self._app(scope, receive, send)

    def _is_public(self, headers: dict[bytes, bytes]) -> bool:
        if any(name in headers for name in _PROXIED):
            return True
        named = urlsplit("//" + headers.get(b"host", b"").decode("latin-1")).hostname
        return named in self._public_hosts

    def _allowed(self, path: str, headers: dict[bytes, bytes]) -> bool:
        if path.startswith("/api/guest/"):
            return True
        cookies = SimpleCookie()
        try:
            cookies.load(headers.get(b"cookie", b"").decode("latin-1"))
        except CookieError:
            return False
        morsel = cookies.get(COHOST_COOKIE)
        return morsel is not None and self._is_cohost(morsel.value)
```

Above `Settings`, add the `.env` reading:

```python
def read_env_file(path: Path) -> dict[str, str]:
    """`KEY=value` lines from a .env file, if there is one. Surrounding quotes are dropped."""
    if not path.is_file():
        return {}
    found = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip().removeprefix("export ").strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        found[key] = value
    return found


def environment(path: Path, base: Mapping[str, str]) -> dict[str, str]:
    """The settings' sources: the .env file, overridden by the real environment."""
    return {**read_env_file(path), **base}


def _hosts(text: str) -> tuple[str, ...]:
    return tuple(host.strip().lower() for host in text.split(",") if host.strip())
```

In `Settings`, after `ffmpeg`, add:

```python
    # A tunnel's hostnames. There, only the guest routes answer. See PublicHostGate.
    public_hosts: tuple[str, ...] = ()
    acs_connection_string: str | None = field(default=None, repr=False)
    rooms: str | None = None  # "fake": in-memory rooms, for the end-to-end tests and trying guests without Azure
```

In `from_env`, replace the `allowed_hosts=tuple(...)` expression with `allowed_hosts=_hosts(env.get("KICKSTREAM_ALLOWED_HOSTS", "")),`, and add:

```python
            public_hosts=_hosts(env.get("KICKSTREAM_PUBLIC_HOSTS", "")),
            acs_connection_string=env.get("KICKSTREAM_ACS_CONNECTION_STRING") or None,
            rooms=env.get("KICKSTREAM_ROOMS") or None,
```

Add properties to `Settings`:

```python
    @property
    def socket_hosts(self) -> tuple[str, ...]:
        return (*self.allowed_hosts, *self.public_hosts)

    @property
    def public_origin(self) -> str | None:
        return f"https://{self.public_hosts[0]}" if self.public_hosts else None
```

Add `people: PeopleService` to `Pipeline` after `broadcasts: BroadcastService`. In `start()`, add `self.tasks.append(asyncio.create_task(self.people.run()))`.

Add the chooser above `build_pipeline`:

```python
def _rooms(settings: Settings) -> CallRooms | None:
    if settings.rooms == "fake":
        return FakeRooms()
    return None
```

Add the parameter `rooms: CallRooms | None = None` to both `build_pipeline` and `create_app`; `create_app` passes it through. In `build_pipeline`, after `broadcasts = BroadcastService(...)`:

```python
    people = PeopleService(
        JsonRecordStore(settings.data_dir / "people.json", private=True),
        rooms if rooms is not None else _rooms(settings),
        find_broadcast=lambda broadcast_id: next(
            (item for item in broadcasts.view().broadcasts if item.id == broadcast_id), None
        ),
        broadcast_changes=broadcasts.changes,
        public_origin=settings.public_origin,
        now=now,
    )
```

The return becomes `Pipeline(bus, store, broadcaster, controller, studio, output, broadcasts, people, stages)`.

In `create_app`, replace `settings = settings or Settings.from_env()` with `settings = settings or Settings.from_env(environment(Path(".env"), os.environ))`. Replace every `socket_hosts=settings.allowed_hosts` with `socket_hosts=settings.socket_hosts`. After `app.add_middleware(BodyLimit)`, add:

```python
    app.add_middleware(
        PublicHostGate, public_hosts=settings.public_hosts, is_cohost=pipeline.people.is_cohost
    )
```

After the broadcasts router, add:

```python
    app.include_router(build_people_router(service=pipeline.people, socket_hosts=settings.socket_hosts))
```

- [ ] **Step 5: Run the tests to see them pass**

Run `uv run pytest -q tests/test_people_api.py tests/test_people_service.py tests/test_broadcast_api.py tests/test_sockets.py tests/test_api.py`, then `uv run ruff check .` and `uv run ruff format --check .`.
Expected: all pass, and ruff is clean.

- [ ] **Step 6: Run the whole pipeline suite**

Run: `uv run pytest -q`
Expected: everything passes except, at most, `tests/test_output_browser.py`, which is flaky under load. If it fails, re-run that file alone: `uv run pytest -q tests/test_output_browser.py`. It must pass on its own.

- [ ] **Step 7: Commit**

```powershell
git add services/pipeline/kickstream/people/api.py services/pipeline/kickstream/app.py services/pipeline/tests/test_people_api.py
git commit -m "Serve people and guest routes, read guests settings and .env, and gate public hosts"
```

---

### Task 4: The Azure Communication Services rooms adapter

**Files:**
- Modify: `services/pipeline/pyproject.toml` and `services/pipeline/uv.lock` (with `uv add`).
- Create: `services/pipeline/kickstream/adapters/acs_rooms.py`.
- Modify: `services/pipeline/kickstream/app.py` (the `_rooms` chooser).
- Test: `services/pipeline/tests/test_acs_rooms.py` and `services/pipeline/tests/test_acs_rooms_real.py` (opt-in).

**Interfaces:**
- Consumes: `CallRole`, `Seat` and `RoomsFailure` from `kickstream.ports.calls`, and `environment` from `kickstream.app`.
- Produces `AcsRooms(connection_string, *, make_rooms=RoomsClient.from_connection_string, make_identity=CommunicationIdentityClient.from_connection_string)`, with `name = "acs"`. It implements `CallRooms`. The SDK clients are made on first use, so a bad connection string never stops the pipeline starting.
- Produces `epoch(value) -> float`, which handles a `datetime`, an ISO string or a number.

- [ ] **Step 1: Add the SDKs**

In `services/pipeline`, run `uv add azure-communication-rooms==1.2.0 azure-communication-identity==1.5.0`.
Expected: `pyproject.toml` lists both, and `uv.lock` is updated.

- [ ] **Step 2: Write the failing adapter tests**

Create `services/pipeline/tests/test_acs_rooms.py`:

```python
from datetime import UTC, datetime

import pytest
from azure.core.exceptions import HttpResponseError

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

    def create_user_and_token(self, scopes):
        self.users += 1
        return User(f"8:acs:u{self.users}"), Token(f"t{self.users}", self.expires_on)

    def get_token(self, user, scopes):
        return Token(f"fresh-{user.properties['id']}", self.expires_on)


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
    assert rooms.calls == [("add", "room-9", [("8:acs:u1", "Consumer")]), ("add", "room-9", [("8:acs:u2", "Presenter")])]


async def test_a_token_is_refreshed_for_the_same_identity():
    adapter, _, _ = made()
    assert await adapter.refresh("8:acs:u1") == Seat("8:acs:u1", "fresh-8:acs:u1", EXPIRES)


async def test_unseating_and_closing_reach_the_room():
    adapter, rooms, _ = made()
    await adapter.unseat("room-9", "8:acs:u1")
    await adapter.close_room("room-9")
    assert rooms.calls == [("remove", "room-9", ["8:acs:u1"]), ("delete", "room-9")]


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
```

Create `services/pipeline/tests/test_acs_rooms_real.py`:

```python
"""Against Azure itself. Runs only when the .env file at the top of the project names a resource."""

import os
import time
from pathlib import Path

import pytest

from kickstream.adapters.acs_rooms import AcsRooms
from kickstream.app import environment

CONNECTION = environment(Path(__file__).resolve().parents[3] / ".env", os.environ).get(
    "KICKSTREAM_ACS_CONNECTION_STRING"
)
pytestmark = pytest.mark.skipif(
    not CONNECTION, reason="put KICKSTREAM_ACS_CONNECTION_STRING in .env to test against Azure"
)


async def test_a_real_room_seats_refreshes_and_closes():
    rooms = AcsRooms(CONNECTION)
    room_id = await rooms.open_room(time.time() + 3600)
    try:
        seat = await rooms.seat(room_id, "presenter")
        assert seat.user_id.startswith("8:acs:") and seat.expires_at > time.time()
        fresh = await rooms.refresh(seat.user_id)
        assert fresh.user_id == seat.user_id and fresh.token
        await rooms.unseat(room_id, seat.user_id)
    finally:
        await rooms.close_room(room_id)
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `uv run pytest -q tests/test_acs_rooms.py tests/test_acs_rooms_real.py`
Expected: an error collecting `test_acs_rooms.py`, `ModuleNotFoundError: No module named 'kickstream.adapters.acs_rooms'`.

- [ ] **Step 4: Write the adapter**

Create `services/pipeline/kickstream/adapters/acs_rooms.py`:

```python
"""Call rooms on Azure Communication Services: one room per broadcast, an identity and token per seat."""

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime
from typing import TypeVar

from azure.communication.identity import CommunicationIdentityClient, CommunicationTokenScope
from azure.communication.identity import CommunicationUserIdentifier as IdentityUser
from azure.communication.rooms import CommunicationUserIdentifier as RoomUser
from azure.communication.rooms import ParticipantRole, RoomParticipant, RoomsClient
from azure.core.exceptions import AzureError

from kickstream.ports.calls import CallRole, RoomsFailure, Seat

T = TypeVar("T")
_ROLES = {
    "presenter": ParticipantRole.PRESENTER,
    "attendee": ParticipantRole.ATTENDEE,
    "consumer": ParticipantRole.CONSUMER,
}
_SCOPES = [CommunicationTokenScope.VOIP]
_BAD_SETTING = "KICKSTREAM_ACS_CONNECTION_STRING is not a valid connection string."


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
            self._rooms_client = self._make_rooms(self._connection_string)
        return self._rooms_client

    def _identity(self) -> CommunicationIdentityClient:
        if self._identity_client is None:
            self._identity_client = self._make_identity(self._connection_string)
        return self._identity_client

    @staticmethod
    async def _run(work: Callable[[], T]) -> T:
        """The SDK blocks, so it runs in a thread."""
        try:
            return await asyncio.to_thread(work)
        except AzureError as exc:
            raise RoomsFailure(_reason(exc)) from exc
        except ValueError as exc:
            raise RoomsFailure(_BAD_SETTING) from exc

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
        await self._run(
            lambda: self._rooms().remove_participants(room_id=room_id, participants=[RoomUser(user_id)])
        )

    async def close_room(self, room_id: str) -> None:
        await self._run(lambda: self._rooms().delete_room(room_id))
```

The fake rooms client in the test reads `p.communication_identifier.properties["id"]` and `p.properties["id"]`. Both of the SDK's `CommunicationUserIdentifier` classes keep the id in `.properties["id"]`. Check this by running `uv run python -c "from azure.communication.rooms import CommunicationUserIdentifier as U; print(U('8:acs:x').properties)"`. If the attribute is named differently in the installed version, change the fakes to match the SDK, not the other way round.

- [ ] **Step 5: Choose Azure when it is configured**

In `services/pipeline/kickstream/app.py`, add `from kickstream.adapters.acs_rooms import AcsRooms` to the adapter imports. Make `_rooms` read:

```python
def _rooms(settings: Settings) -> CallRooms | None:
    if settings.acs_connection_string:
        return AcsRooms(settings.acs_connection_string)
    if settings.rooms == "fake":
        return FakeRooms()
    return None
```

Add this test to `tests/test_people_api.py`. It checks that Azure is chosen by the setting and that no Azure call happens while starting:

```python
def test_an_acs_connection_string_chooses_azure_and_starting_calls_nothing(tmp_path):
    settings = Settings(
        None,
        None,
        None,
        cache_dir=tmp_path / "cache",
        data_dir=tmp_path / "data",
        acs_connection_string="endpoint=https://example.communication.azure.com/;accesskey=c2VjcmV0",
    )
    with TestClient(create_app(settings, clock_factory=lambda speed: InstantClock(), match_prefix="m")) as client:
        b = new_broadcast(client)
        assert client.get(people(b)).json()["service"] == "acs"
```

- [ ] **Step 6: Run the tests to see them pass**

Run `uv run pytest -q tests/test_acs_rooms.py tests/test_acs_rooms_real.py tests/test_people_api.py tests/test_architecture.py`, then `uv run ruff check .` and `uv run ruff format --check .`.
Expected: all pass. The real test is skipped unless `.env` has the connection string, and ruff is clean.

- [ ] **Step 7: Commit**

```powershell
git add services/pipeline/pyproject.toml services/pipeline/uv.lock services/pipeline/kickstream/adapters/acs_rooms.py services/pipeline/kickstream/app.py services/pipeline/tests/test_acs_rooms.py services/pipeline/tests/test_acs_rooms_real.py services/pipeline/tests/test_people_api.py
git commit -m "Add Azure Communication Services rooms, chosen when a connection string is set"
```

---

### Task 5: The cameras scene element and the Interview template

**Files:**
- Modify: `packages/contracts/kickstream.schema.json` (`SceneElement.type` enum), then regenerate both contract files.
- Modify: `services/pipeline/kickstream/studio/rules.py` (`_normalize_props`) and `services/pipeline/kickstream/studio/templates.py`.
- Modify: `apps/web/src/studio/elements.tsx`, `apps/web/src/studio/ProgramPage.tsx`, `apps/web/src/studio/panels.tsx` and `apps/web/src/i18n.ts`.
- Test: `services/pipeline/tests/test_studio_rules.py`, `apps/web/src/studio/elements.test.tsx`, `apps/web/src/studio/ProgramPage.fallbacks.test.ts` and `apps/web/src/studio/StudioPage.test.tsx`.

**Interfaces:**
- Produces, in `studio/elements.tsx`: `CameraTile { id: string; name: string; acsId: string | null; present: boolean }`, and two optional fields on `ProgramData`: `cameras?: readonly CameraTile[]` and `renderVideo?: (acsId: string, element: HTMLElement) => () => void`.
- Produces, in `studio/ProgramPage.tsx`: `withCamerasFallback(scene, cameras)` and `withFallbacks(scene, studio, cameras = [])`.
- Produces `INTERVIEW = "Interview"` in `studio/templates.py`. The new template is not one of a new studio's starting scenes.

- [ ] **Step 1: Write the failing pipeline tests**

Append to `services/pipeline/tests/test_studio_rules.py`. Add `INTERVIEW` to the existing import from `kickstream.studio.templates`, and import `SceneElement` from `kickstream.contracts` if it is not already imported.

```python
def test_a_cameras_element_keeps_only_its_name_tags_switch():
    made = rules.normalize_element(
        SceneElement(
            id="c", type="cameras", x=0, y=0, width=800, height=450, layer=1, visible=True,
            props={"names": False, "junk": 1},
        )
    )
    assert made.props == {"names": False}
    plain = made.model_copy(update={"props": {}})
    assert rules.normalize_element(plain).props == {"names": True}


def test_the_interview_template_puts_the_cameras_first_and_new_studios_start_without_it():
    interview = next(t for t in builtin_templates() if t.name == INTERVIEW)
    assert [e.type for e in interview.elements] == ["cameras", "scoreboard"]
    assert INTERVIEW not in {scene.name for scene in default_studio().scenes}
    doc = rules.create_scene(default_studio(), "builtin", INTERVIEW)
    assert doc.scenes[-1].name == INTERVIEW
```

Two existing tests in this file pin the built-in templates. Update them:
- `test_there_are_five_built_in_templates_that_fit_the_canvas`: rename it to `test_there_are_six_built_in_templates_that_fit_the_canvas`, and expect `[STARTING_SOON, LIVE_MATCH, ANALYST_DESK, BREAK, FULL_TIME, INTERVIEW]`.
- `test_the_live_match_is_the_fan_scene_and_the_analyst_desk_the_analyst_scene`: add `INTERVIEW: None` to the expected modes.

`test_a_new_studio_has_one_scene_per_template_with_starting_soon_live` stays as it is: a new studio still has five scenes. Rename it to `test_a_new_studio_starts_with_the_match_templates_and_starting_soon_live`.

- [ ] **Step 2: Run them to see them fail**

Run: `uv run pytest -q tests/test_studio_rules.py`
Expected: FAIL. Pydantic refuses `"cameras"` as an element type, and `INTERVIEW` cannot be imported.

- [ ] **Step 3: Add the element type and the template**

In the schema's `SceneElement.type` enum, add `"cameras"` after `"image"`. Regenerate both contract files (as in Task 1, Step 2).

In `services/pipeline/kickstream/studio/rules.py` `_normalize_props`, before the final `return {}`, add:

```python
    if type_ == "cameras":
        return {"names": props.get("names", True) is not False}
```

In `services/pipeline/kickstream/studio/templates.py`:
- Add `INTERVIEW = "Interview"` after `FULL_TIME`.
- Add this entry to `layouts`:

  ```python
        INTERVIEW: [
            _el(1, "cameras", 40, 40, 1840, 820, names=True),
            _el(2, "scoreboard", 410, 880, 1100, 120),
        ],
  ```

- Make `default_studio` skip it:

  ```python
    starting = [template for template in builtin_templates() if template.name != INTERVIEW]
    scenes = [template.model_copy(update={"id": f"scene-{n}"}) for n, template in enumerate(starting, 1)]
  ```

- [ ] **Step 4: Run the pipeline tests to see them pass**

Run `uv run pytest -q tests/test_studio_rules.py tests/test_studio_api.py tests/test_studio_service.py tests/test_studio_stores.py tests/test_contracts.py tests/test_sockets.py`, then `uv run ruff check .`.
Expected: all pass, and ruff is clean.

- [ ] **Step 5: Write the failing web tests**

Append to `apps/web/src/studio/elements.test.tsx`:

```tsx
test("the cameras element tiles the people on stage with name tags and their video", () => {
  const rendered: string[] = [];
  const renderVideo = (acsId: string, box: HTMLElement) => {
    rendered.push(acsId);
    box.setAttribute("data-video", acsId);
    return () => box.removeAttribute("data-video");
  };
  const cameras = [
    { id: "i1", name: "Sam Lee", acsId: "8:acs:1", present: true },
    { id: "host", name: "Alex", acsId: null, present: false },
    { id: "i2", name: "Kim", acsId: "8:acs:2", present: true },
  ];
  show("cameras", { cameras, renderVideo }, { names: true });
  const grid = screen.getByTestId("program-cameras");
  expect([grid.style.gridTemplateColumns, grid.style.gridTemplateRows]).toEqual(["repeat(2, 1fr)", "repeat(2, 1fr)"]);
  expect(screen.getAllByTestId("camera-tile")).toHaveLength(3);
  expect(rendered).toEqual(["8:acs:1", "8:acs:2"]);
  expect(screen.getByText("Alex · away")).toBeTruthy();
  expect(screen.getByText("SL")).toBeTruthy();
});

test("one person on stage fills the box, and name tags can be switched off", () => {
  show("cameras", { cameras: [{ id: "i1", name: "Sam", acsId: null, present: true }] }, { names: false });
  const grid = screen.getByTestId("program-cameras");
  expect([grid.style.gridTemplateColumns, grid.style.gridTemplateRows]).toEqual(["repeat(1, 1fr)", "repeat(1, 1fr)"]);
  expect(screen.queryByText("Sam")).toBeNull();
});

test("with no one on stage the cameras element shows nothing", () => {
  show("cameras");
  expect(screen.queryByTestId("program-cameras")).toBeNull();
});
```

Append to `apps/web/src/studio/ProgramPage.fallbacks.test.ts`. Extend its existing imports with `withCamerasFallback`, and with `element` and `scene` from `../test/fixtures` if they are not already imported.

```ts
const sam = { id: "i1", name: "Sam", acsId: "8:acs:1", present: true };

test("people on stage get a picture-in-picture box when the scene shows no cameras", () => {
  const shown = withCamerasFallback(scene(), [sam]);
  expect(shown.elements.at(-1)).toMatchObject({ id: "__cameras", type: "cameras", x: 1440, y: 740, width: 440, height: 300, visible: true });
  expect(withCamerasFallback(scene(), [])).toEqual(scene());
  const own = scene({ elements: [element({ id: "c", type: "cameras", props: {} })] });
  expect(withCamerasFallback(own, [sam])).toBe(own);
  const hidden = scene({ elements: [element({ id: "c", type: "cameras", visible: false, props: {} })] });
  expect(withCamerasFallback(hidden, [sam]).elements).toHaveLength(2);
});
```

In `apps/web/src/studio/StudioPage.test.tsx`, add:

```tsx
test("an Interview scene can be made from the built-in templates", async () => {
  const server = await opened();
  fireEvent.change(screen.getByLabelText("New scene from"), { target: { value: "builtin:Interview" } });
  fireEvent.click(screen.getByRole("button", { name: "Add scene" }));
  await waitFor(() => expect(last(server).body).toEqual({ source: "builtin", ref: "Interview" }));
});
```

- [ ] **Step 6: Run them to see them fail**

Run: `pnpm test -- src/studio`
Expected: FAIL. `program-cameras` is not found, `withCamerasFallback` is not exported, and there is no "Interview" option.

- [ ] **Step 7: Draw the cameras**

In `apps/web/src/i18n.ts`, add `away: "away",` after `replay` in `en`, `away: "ausente",` in `es`, and `away: "अनुपस्थित",` in `hi`.

In `apps/web/src/studio/elements.tsx`, change the React import to `import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";`. Extend `ProgramData` and add the tile type:

```tsx
/** Someone on stage, as the cameras element draws them. */
export interface CameraTile {
  id: string;
  name: string;
  acsId: string | null;
  present: boolean;
}

/** Everything an element can draw from. `now` is the server's clock in Unix seconds. */
export interface ProgramData {
  match: MatchData;
  studio: Studio;
  now: number;
  language: Language;
  /** The people on stage, in order. */
  cameras?: readonly CameraTile[];
  /** Puts a person's video into the element; returns what takes it out. Absent where there is no call. */
  renderVideo?: (acsId: string, element: HTMLElement) => () => void;
}
```

Above `ElementView`, add:

```tsx
const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0].toUpperCase()).join("");

function CameraFeed({ tile, names, renderVideo, language }: { tile: CameraTile; names: boolean; renderVideo?: ProgramData["renderVideo"]; language: Language }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tile.acsId || !renderVideo || !box.current) return;
    return renderVideo(tile.acsId, box.current);
  }, [tile.acsId, renderVideo]);
  return (
    <div data-testid="camera-tile" data-person={tile.id}
      style={{ position: "relative", overflow: "hidden", borderRadius: 16, backgroundColor: "#101828" }}>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 96, fontWeight: 700, color: "rgba(255, 255, 255, 0.45)" }}>
        {initials(tile.name)}
      </div>
      <div ref={box} style={{ position: "absolute", inset: 0 }} />
      {names && (
        <span style={{ position: "absolute", left: 16, bottom: 16, padding: "4px 16px", borderRadius: 8, color: "#FFFFFF", backgroundColor: "rgba(16, 24, 40, 0.8)", fontSize: 28, fontWeight: 600 }}>
          {tile.present ? tile.name : `${tile.name} · ${t(language, "away")}`}
        </span>
      )}
    </div>
  );
}

function CamerasView({ data, names }: { data: ProgramData; names: boolean }) {
  const tiles = data.cameras ?? [];
  if (tiles.length === 0) return null;
  const columns = tiles.length === 1 ? 1 : 2;
  const rows = tiles.length <= 2 ? 1 : 2;
  return (
    <div data-testid="program-cameras"
      style={{ width: "100%", height: "100%", display: "grid", gap: 16, gridTemplateColumns: `repeat(${columns}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}>
      {tiles.map((tile) => (
        <CameraFeed key={tile.id} tile={tile} names={names} renderVideo={data.renderVideo} language={data.language} />
      ))}
    </div>
  );
}
```

In `ElementView`'s switch, add: `case "cameras": return <CamerasView data={data} names={props.names !== false} />;`.

In `apps/web/src/studio/ProgramPage.tsx`, import `type CameraTile` from `./elements` and replace `withFallbacks` with:

```tsx
const CAMERAS_BOX = { x: 1440, y: 740, width: 440, height: 300 };

/** People on stage must be seen: add a picture-in-picture box to a scene that shows no cameras. */
export function withCamerasFallback(scene: Scene, cameras: readonly CameraTile[]): Scene {
  if (cameras.length === 0 || scene.elements.some((element) => element.type === "cameras" && element.visible)) return scene;
  const fallback = { id: "__cameras", type: "cameras" as const, ...CAMERAS_BOX, layer: nextLayer(scene.elements), visible: true, props: { names: true } };
  return { ...scene, elements: [...scene.elements, fallback] };
}

/** Whatever is on air must be visible: add a default box for each thing the scene has no element for. */
export function withFallbacks(scene: Scene, studio: Studio, cameras: readonly CameraTile[] = []): Scene {
  return withCamerasFallback(withReplayFallback(scene, studio), cameras);
}
```

In `apps/web/src/studio/panels.tsx`:
- Add `VideoPersonRegular` to the icons import. If `pnpm typecheck` says it does not exist, use `PersonVideoRegular`.
- Change `BUILTIN` to `["Starting soon", "Live match", "Analyst desk", "Break", "Full-time", "Interview"]`.
- Add `Interview: <VideoPersonRegular />,` to `TEMPLATE_ICONS`.
- Add `"cameras"` at the end of `ELEMENT_TYPES`.
- After the `pitch` switch, add:

  ```tsx
      {selected?.type === "cameras" && (
        <Switch label="Name tags" checked={selected.props.names !== false} onChange={(_, data) => setProp(selected, "names", data.checked)} />
      )}
  ```

- [ ] **Step 8: Run the web checks**

Run `pnpm test` and `pnpm typecheck` in `apps/web`.
Expected: all pass.

- [ ] **Step 9: Commit**

```powershell
git add packages/contracts/kickstream.schema.json services/pipeline/kickstream/contracts.py apps/web/src/contracts.ts services/pipeline/kickstream/studio/rules.py services/pipeline/kickstream/studio/templates.py services/pipeline/tests/test_studio_rules.py apps/web/src/i18n.ts apps/web/src/studio/elements.tsx apps/web/src/studio/elements.test.tsx apps/web/src/studio/ProgramPage.tsx apps/web/src/studio/ProgramPage.fallbacks.test.ts apps/web/src/studio/panels.tsx apps/web/src/studio/StudioPage.test.tsx
git commit -m "Add the cameras scene element, the Interview template and a picture-in-picture fallback"
```

---

### Task 6: The call client in the web app

**Files:**
- Modify: `apps/web/package.json` and `pnpm-lock.yaml` (`pnpm add`).
- Create, in `apps/web/src/calls/`: `RoomCall.ts`, `acs.ts`, `local.ts`, `open.ts`, `useCallUpdates.ts`, `useDevices.ts`, `DevicePickers.tsx` and `VideoBox.tsx`.
- Create, in `apps/web/src/people/`: `api.ts`, `stage.ts` and `roomAudio.ts`.
- Create: `apps/web/src/test/FakeRoomCall.ts`.
- Modify: `apps/web/src/test/fixtures.ts` and `apps/web/src/stream/useLiveDocument.ts`.
- Test: `apps/web/src/calls/local.test.ts`, `apps/web/src/calls/open.test.ts`, `apps/web/src/people/api.test.ts`, `apps/web/src/people/roomAudio.test.ts` and `apps/web/src/stream/useLiveDocument.test.tsx`.

**Interfaces:**
- Consumes: the `People`, `Guest`, `CallSeat` and `Invite` contracts (Task 1), `CameraTile` (Task 5), and `ProgramAudio` and `programAudio` from `studio/capture.ts`.
- Produces `RoomCall`, `Device`, `Participant`, `CallState` and `JoinOptions` (below), plus:
  - `AcsRoomCall`, `LocalRoomCall` and `openRoomCall(service)`.
  - `useCallUpdates(call)`, `useDevices(call)` (returns `Devices`), `DevicePickers` and `VideoBox`.
  - `deviceProblem(caught)`.
- Produces, from `people/api.ts`:
  - `Role`, `ROLE_NAMES` and `inviteLink(people, link, origin?)`.
  - `peopleStream`, `invite`, `revokeInvite`, `setStage`, `hostSeat` and `programSeat`.
  - `guestStream`, `getGuest`, `joinAsGuest` and `refreshGuestSeat`.
- Produces `stageTiles(people)` (`people/stage.ts`), `connectRoomAudio(stream, program?, makeAudio?)` (`people/roomAudio.ts`) and `FakeRoomCall` (test).
- Produces new fixtures: `invitation()`, `peopleDoc()`, `guestDoc()` and `callSeat()`.
- `useLiveDocument(url: string | null, ...)`: a null url follows nothing.

- [ ] **Step 1: Add the calling SDK**

In `apps/web`, run `pnpm add @azure/communication-calling@2.0.0 @azure/communication-common@2.5.0`.
Expected: both appear in `dependencies`.

- [ ] **Step 2: Write the failing tests**

In `apps/web/src/test/fixtures.ts`, add `CallSeat, Guest, Invite, People` to the contracts import and append:

```ts
export const invitation = (over: Partial<Invite> = {}): Invite => ({
  id: "i1", role: "speaker", name: "Sam", link: "/guest/abc", made_at: 1000, joined_name: null, acs_id: null,
  present: false, revoked: false, ...over,
});

export const peopleDoc = (over: Partial<People> = {}): People => ({
  revision: 1, server_time: 1000, broadcast_id: "b1", service: "fake", room_id: "room-1",
  public_origin: "https://guests.example", invites: [], stage: [], host_name: "Host", host_acs_id: null, ...over,
});

export const guestDoc = (over: Partial<Guest> = {}): Guest => ({
  revision: 1, server_time: 1000, valid: true, service: "fake", broadcast_id: null, broadcast_title: "Derby day",
  broadcast_state: "ready", role: "speaker", name: "Sam", joined: false, joined_name: null, room_id: null,
  on_stage: false, muted_live: false, ...over,
});

export const callSeat = (over: Partial<CallSeat> = {}): CallSeat => ({
  room_id: "room-1", acs_id: "8:fake:2", token: "t1", expires_at: 2000, service: "fake", ...over,
});
```

Create `apps/web/src/calls/local.test.ts`:

```ts
import { LocalRoomCall } from "./local";

function stubDevices() {
  const stopped: number[] = [];
  let made = 0;
  const getUserMedia = vi.fn(async () => {
    const id = ++made;
    return { getTracks: () => [{ stop: () => stopped.push(id) }] } as unknown as MediaStream;
  });
  const enumerateDevices = vi.fn(async () => [
    { kind: "videoinput", deviceId: "cam1", label: "Front camera" },
    { kind: "audioinput", deviceId: "mic1", label: "" },
  ] as MediaDeviceInfo[]);
  Object.defineProperty(window.navigator, "mediaDevices", { value: { getUserMedia, enumerateDevices }, configurable: true });
  return { getUserMedia, stopped };
}

test("a call with no service lists devices once allowed, previews the camera, and is always alone", async () => {
  const { getUserMedia, stopped } = stubDevices();
  const call = new LocalRoomCall();
  expect(await call.cameras()).toEqual([{ id: "cam1", name: "Front camera" }]);
  expect(await call.microphones()).toEqual([{ id: "mic1", name: "Microphone 1" }]);
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(stopped).toEqual([1]);
  await call.setCamera("cam1");
  expect(call.cameraOn).toBe(true);
  const box = document.createElement("div");
  const stop = call.renderLocal(box);
  expect(box.querySelector("video")?.muted).toBe(true);
  await call.join({ roomId: "room-1", token: "t", name: "Sam", refresh: async () => "t" });
  expect([call.state, call.participants]).toEqual(["joined", []]);
  await call.setCamera(null);
  expect([call.cameraOn, stopped]).toEqual([false, [1, 2]]);
  stop();
  expect(box.children).toHaveLength(0);
});
```

Create `apps/web/src/calls/open.test.ts`:

```ts
import { AcsRoomCall } from "./acs";
import { LocalRoomCall } from "./local";
import { openRoomCall } from "./open";

test("the room's service decides which call joins it", () => {
  expect(openRoomCall("acs")).toBeInstanceOf(AcsRoomCall);
  expect(openRoomCall("fake")).toBeInstanceOf(LocalRoomCall);
});
```

Create `apps/web/src/people/api.test.ts`:

```ts
import { peopleDoc } from "../test/fixtures";
import { invite, inviteLink } from "./api";

test("an invite link uses the public address when there is one", () => {
  expect(inviteLink(peopleDoc(), "/guest/abc", "http://127.0.0.1:5173")).toBe("https://guests.example/guest/abc");
  expect(inviteLink(peopleDoc({ public_origin: null }), "/guest/abc", "http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173/guest/abc");
});

test("an invite without a name sends only the role", async () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(peopleDoc()), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await invite("b1", "member", "  ");
  await invite("b1", "cohost", "Kim");
  expect(fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
    ["/api/broadcasts/b1/people/invites", { role: "member" }],
    ["/api/broadcasts/b1/people/invites", { role: "cohost", name: "Kim" }],
  ]);
});
```

Create `apps/web/src/people/roomAudio.test.ts`:

```ts
import type { ProgramAudio } from "../studio/capture";
import { connectRoomAudio } from "./roomAudio";

test("the room's voices join the program mix through a muted media element that plays them", () => {
  const connected: unknown[] = [];
  const node = { connect: (to: unknown) => connected.push(to), disconnect: vi.fn() };
  const program = { context: { createMediaStreamSource: vi.fn(() => node) }, input: {} } as unknown as ProgramAudio;
  const element = { muted: false, srcObject: null as unknown, play: vi.fn(async () => {}), pause: vi.fn() };
  const stream = {} as MediaStream;
  const undo = connectRoomAudio(stream, program, () => element as unknown as HTMLAudioElement);
  expect([element.muted, element.srcObject]).toEqual([true, stream]);
  expect(element.play).toHaveBeenCalled();
  expect(program.context.createMediaStreamSource).toHaveBeenCalledWith(stream);
  expect(connected).toEqual([program.input]);
  undo();
  expect(node.disconnect).toHaveBeenCalled();
  expect(element.srcObject).toBeNull();
});
```

Append to `apps/web/src/stream/useLiveDocument.test.tsx`:

```tsx
test("with no address there is nothing to follow", () => {
  const { result } = renderHook(() => useLiveDocument<Broadcasts>(null, FakeEventSourceCtor, 10));
  expect(FakeEventSource.instances).toHaveLength(0);
  expect([result.current.doc, result.current.connected]).toEqual([null, false]);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm test -- src/calls src/people src/stream`
Expected: FAIL. The modules `./local`, `./open`, `./api` and `./roomAudio` are not found, and `useLiveDocument` opens a source for a null url.

- [ ] **Step 4: Write the interface and the pieces around it**

Create `apps/web/src/calls/RoomCall.ts`:

```ts
/** A seat in a broadcast's call room. The pages never see which calling service carries it. */

export interface Device {
  id: string;
  name: string;
}

export interface Participant {
  acsId: string;
  name: string;
  video: boolean;
  speaking: boolean;
  muted: boolean;
}

export type CallState = "idle" | "joining" | "joined" | "dropped";

export interface JoinOptions {
  roomId: string;
  token: string;
  /** The name the others see. */
  name: string;
  /** A fresh token, asked for before the current one expires. */
  refresh(): Promise<string>;
  /** The program page: it only receives, and needs no devices. */
  receiveOnly?: boolean;
}

export interface RoomCall {
  readonly state: CallState;
  readonly participants: readonly Participant[];
  readonly muted: boolean;
  readonly cameraOn: boolean;
  /** Why the call ended, written for people; null while it is fine. */
  readonly problem: string | null;
  /** Called after any of the above changes. Returns what stops it. */
  onChange(listener: () => void): () => void;
  cameras(): Promise<Device[]>;
  microphones(): Promise<Device[]>;
  /** Null turns the camera off. Before joining it drives the preview. */
  setCamera(deviceId: string | null): Promise<void>;
  setMicrophone(deviceId: string): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  join(options: JoinOptions): Promise<void>;
  leave(): Promise<void>;
  /** The host and co-hosts may mute anyone. */
  muteParticipant(acsId: string): Promise<void>;
  renderVideo(acsId: string, element: HTMLElement): () => void;
  renderLocal(element: HTMLElement): () => void;
  /** Everyone else in the room, mixed into one stream. */
  roomAudio(): Promise<MediaStream | null>;
}
```

Create `apps/web/src/calls/local.ts`:

```ts
import type { CallState, Device, JoinOptions, Participant, RoomCall } from "./RoomCall";

/**
 * A call with no service behind it: the devices and the preview work, and no one else is ever there.
 * For trying guests without Azure, and for the end-to-end tests.
 */
export class LocalRoomCall implements RoomCall {
  state: CallState = "idle";
  participants: Participant[] = [];
  muted = true;
  cameraOn = false;
  problem: string | null = null;
  private readonly listeners = new Set<() => void>();
  private stream: MediaStream | null = null;
  private allowed: Promise<void> | null = null;

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    for (const listener of [...this.listeners]) listener();
  }

  /** Browsers name devices only once the page may use them. */
  private allow(): Promise<void> {
    this.allowed ??= navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then((probe) => {
      probe.getTracks().forEach((track) => track.stop());
    });
    return this.allowed;
  }

  private async devices(kind: MediaDeviceKind, fallback: string): Promise<Device[]> {
    await this.allow();
    const found = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === kind);
    return found.map((device, n) => ({ id: device.deviceId, name: device.label || `${fallback} ${n + 1}` }));
  }

  cameras() {
    return this.devices("videoinput", "Camera");
  }

  microphones() {
    return this.devices("audioinput", "Microphone");
  }

  async setCamera(deviceId: string | null) {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.cameraOn = false;
    if (deviceId !== null) {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
      this.cameraOn = true;
    }
    this.emit();
  }

  async setMicrophone(_deviceId: string) {}

  async setMuted(muted: boolean) {
    this.muted = muted;
    this.emit();
  }

  async join(_options: JoinOptions) {
    this.state = "joined";
    this.emit();
  }

  async leave() {
    await this.setCamera(null);
    this.state = "idle";
    this.emit();
  }

  async muteParticipant(_acsId: string) {}

  renderVideo(_acsId: string, _element: HTMLElement) {
    return () => {};
  }

  renderLocal(element: HTMLElement) {
    const video = document.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.style.cssText = "width: 100%; height: 100%; object-fit: cover";
    const show = () => {
      if (video.srcObject !== this.stream) video.srcObject = this.stream;
    };
    show();
    element.replaceChildren(video);
    const off = this.onChange(show);
    return () => {
      off();
      video.srcObject = null;
      element.replaceChildren();
    };
  }

  async roomAudio() {
    return null;
  }
}
```

Create `apps/web/src/calls/acs.ts`:

```ts
import type {
  AudioDeviceInfo, Call, CallAgent, CallClient, DeviceManager, LocalVideoStream, RemoteParticipant, RemoteVideoStream,
  VideoDeviceInfo, VideoStreamRenderer,
} from "@azure/communication-calling";
import type { CallState, Device, JoinOptions, Participant, RoomCall } from "./RoomCall";

type Calling = typeof import("@azure/communication-calling");
type Common = typeof import("@azure/communication-common");

let sdk: Promise<[Calling, Common]> | null = null;
/** The calling SDK is large; only pages that use a call load it. */
const load = () => (sdk ??= Promise.all([import("@azure/communication-calling"), import("@azure/communication-common")]));

const idOf = (participant: RemoteParticipant) =>
  participant.identifier.kind === "communicationUser" ? participant.identifier.communicationUserId : "";
const cameraOf = (participant: RemoteParticipant | undefined) =>
  participant?.videoStreams.find((stream) => stream.mediaStreamType === "Video");
const toDevice = (device: VideoDeviceInfo | AudioDeviceInfo): Device => ({ id: device.id, name: device.name });

/** A seat in an Azure Communication Services room. */
export class AcsRoomCall implements RoomCall {
  state: CallState = "idle";
  participants: Participant[] = [];
  muted = true;
  cameraOn = false;
  problem: string | null = null;
  private readonly listeners = new Set<() => void>();
  private calling: Calling | null = null;
  private client: CallClient | null = null;
  private manager: Promise<DeviceManager> | null = null;
  private agent: CallAgent | null = null;
  private call: Call | null = null;
  private local: LocalVideoStream | null = null;

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    for (const listener of [...this.listeners]) listener();
  }

  private async start(): Promise<CallClient> {
    const [calling] = await load();
    this.calling = calling;
    this.client ??= new calling.CallClient();
    return this.client;
  }

  private devices(): Promise<DeviceManager> {
    this.manager ??= (async () => {
      const manager = await (await this.start()).getDeviceManager();
      const access = await manager.askDevicePermission({ audio: true, video: true });
      if (!access.audio && !access.video) throw new Error("The browser was not allowed to use the camera or microphone.");
      return manager;
    })();
    return this.manager;
  }

  async cameras() {
    return (await (await this.devices()).getCameras()).map(toDevice);
  }

  async microphones() {
    return (await (await this.devices()).getMicrophones()).map(toDevice);
  }

  async setCamera(deviceId: string | null) {
    if (deviceId === null) {
      if (this.local && this.call?.isLocalVideoStarted) await this.call.stopVideo(this.local);
      this.local = null;
      this.cameraOn = false;
      this.emit();
      return;
    }
    const camera = (await (await this.devices()).getCameras()).find((device) => device.id === deviceId);
    if (!camera) throw new Error("That camera is no longer connected.");
    if (this.local) {
      await this.local.switchSource(camera);
    } else {
      this.local = new this.calling!.LocalVideoStream(camera);
      if (this.call) await this.call.startVideo(this.local);
    }
    this.cameraOn = true;
    this.emit();
  }

  async setMicrophone(deviceId: string) {
    const manager = await this.devices();
    const microphone = (await manager.getMicrophones()).find((device) => device.id === deviceId);
    if (!microphone) throw new Error("That microphone is no longer connected.");
    await manager.selectMicrophone(microphone);
  }

  async setMuted(muted: boolean) {
    this.muted = muted;
    if (this.call && this.call.isMuted !== muted) await (muted ? this.call.mute() : this.call.unmute());
    this.emit();
  }

  async join({ roomId, token, name, refresh, receiveOnly = false }: JoinOptions) {
    const client = await this.start();
    const [, common] = await load();
    const credential = new common.AzureCommunicationTokenCredential({ token, tokenRefresher: () => refresh(), refreshProactively: true });
    this.agent = await client.createCallAgent(credential, { displayName: name });
    this.problem = null;
    this.state = "joining";
    this.emit();
    const sending = !receiveOnly && this.local ? { localVideoStreams: [this.local] } : undefined;
    const call = this.agent.join({ roomId }, { videoOptions: sending, audioOptions: { muted: receiveOnly || this.muted } });
    this.call = call;
    call.on("stateChanged", () => this.followState(call));
    call.on("remoteParticipantsUpdated", ({ added }) => {
      added.forEach((participant) => this.follow(participant));
      this.collect();
    });
    call.on("remoteAudioStreamsUpdated", () => this.emit());
    call.remoteParticipants.forEach((participant) => this.follow(participant));
    this.collect();
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (call.state === "Connected") resolve();
        else if (call.state === "Disconnected") reject(new Error(this.problem ?? "The call could not be joined."));
      };
      call.on("stateChanged", check);
      check();
    });
  }

  private followState(call: Call) {
    if (call !== this.call) return;
    if (call.state === "Connected") {
      this.state = "joined";
    } else if (call.state === "Disconnected") {
      this.state = "dropped";
      const reason = call.callEndReason;
      this.problem = reason && reason.code !== 0 ? `The call ended (code ${reason.code}${reason.subCode ? `/${reason.subCode}` : ""}).` : null;
    }
    this.emit();
  }

  private follow(participant: RemoteParticipant) {
    const changed = () => this.collect();
    participant.on("displayNameChanged", changed);
    participant.on("isMutedChanged", changed);
    participant.on("isSpeakingChanged", changed);
    participant.on("videoStreamsUpdated", ({ added }) => {
      added.forEach((stream) => stream.on("isAvailableChanged", changed));
      changed();
    });
    participant.videoStreams.forEach((stream) => stream.on("isAvailableChanged", changed));
  }

  private collect() {
    this.participants = (this.call?.remoteParticipants ?? []).map((participant) => ({
      acsId: idOf(participant),
      name: participant.displayName ?? "",
      video: Boolean(cameraOf(participant)?.isAvailable),
      speaking: participant.isSpeaking,
      muted: participant.isMuted,
    }));
    this.emit();
  }

  async leave() {
    const call = this.call;
    const agent = this.agent;
    this.call = null;
    this.agent = null;
    this.participants = [];
    this.state = "idle";
    try {
      if (call && call.state !== "Disconnected") await call.hangUp();
    } finally {
      await agent?.dispose();
      this.emit();
    }
  }

  async muteParticipant(acsId: string) {
    await this.call?.remoteParticipants.find((participant) => idOf(participant) === acsId)?.mute();
  }

  private draw(element: HTMLElement, pick: () => LocalVideoStream | RemoteVideoStream | null): () => void {
    let shown: LocalVideoStream | RemoteVideoStream | null = null;
    let renderer: VideoStreamRenderer | null = null;
    const update = () => {
      const next = pick();
      if (next === shown) return;
      shown = next;
      renderer?.dispose();
      renderer = null;
      element.replaceChildren();
      if (!next || !this.calling) return;
      const made = new this.calling.VideoStreamRenderer(next);
      renderer = made;
      made.createView({ scalingMode: "Crop" }).then(
        (view) => {
          if (renderer === made) element.replaceChildren(view.target);
        },
        () => {
          if (renderer === made) shown = null;
        },
      );
    };
    update();
    const off = this.onChange(update);
    return () => {
      off();
      renderer?.dispose();
      renderer = null;
      element.replaceChildren();
    };
  }

  renderVideo(acsId: string, element: HTMLElement) {
    return this.draw(element, () => {
      const stream = cameraOf(this.call?.remoteParticipants.find((participant) => idOf(participant) === acsId));
      return stream?.isAvailable ? stream : null;
    });
  }

  renderLocal(element: HTMLElement) {
    return this.draw(element, () => this.local);
  }

  async roomAudio() {
    const stream = this.call?.remoteAudioStreams[0];
    return stream ? await stream.getMediaStream() : null;
  }
}
```

The SDK types were checked against `@azure/communication-calling` 2.0.0:
- `CallAgent.join(RoomLocator, JoinCallOptions)`.
- `Call.remoteAudioStreams[].getMediaStream()` and `RemoteParticipant.mute()`.
- `LocalVideoStream.switchSource` and `VideoStreamRenderer.createView({ scalingMode })`.
- `DeviceManager.askDevicePermission`, `getCameras`, `getMicrophones` and `selectMicrophone`.
- `AzureCommunicationTokenCredential({ token, tokenRefresher, refreshProactively })`.

If `pnpm typecheck` disagrees on a detail, follow the installed types and keep the `RoomCall` behaviour.

Create `apps/web/src/calls/open.ts`:

```ts
import type { CallSeat } from "../contracts";
import { AcsRoomCall } from "./acs";
import { LocalRoomCall } from "./local";
import type { RoomCall } from "./RoomCall";

export function openRoomCall(service: CallSeat["service"]): RoomCall {
  return service === "acs" ? new AcsRoomCall() : new LocalRoomCall();
}
```

Create `apps/web/src/calls/useCallUpdates.ts`:

```ts
import { useEffect, useState } from "react";
import type { RoomCall } from "./RoomCall";

/** Re-renders whenever the call changes: who is there, and whether it is joined, muted or showing a camera. */
export function useCallUpdates(call: RoomCall | null): void {
  const [, setTick] = useState(0);
  useEffect(() => call?.onChange(() => setTick((tick) => tick + 1)), [call]);
}
```

Create `apps/web/src/calls/useDevices.ts`:

```ts
import { useEffect, useState } from "react";
import type { Device, RoomCall } from "./RoomCall";

export const deviceProblem = (caught: unknown) =>
  `Your camera or microphone could not be used (${caught instanceof Error ? caught.message : "unknown reason"}). You can still join with them off.`;

export interface Devices {
  cameras: Device[];
  microphones: Device[];
  camera: string | null;
  microphone: string | null;
  problem: string | null;
  chooseCamera(deviceId: string | null): Promise<void>;
  chooseMicrophone(deviceId: string): Promise<void>;
}

/** The call's cameras and microphones. The first of each is turned on once the call exists. */
export function useDevices(call: RoomCall | null): Devices {
  const [cameras, setCameras] = useState<Device[]>([]);
  const [microphones, setMicrophones] = useState<Device[]>([]);
  const [camera, setCamera] = useState<string | null>(null);
  const [microphone, setMicrophone] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!call) return;
    let current = true;
    void (async () => {
      try {
        const foundCameras = await call.cameras();
        const foundMicrophones = await call.microphones();
        if (!current) return;
        setCameras(foundCameras);
        setMicrophones(foundMicrophones);
        if (foundMicrophones[0]) {
          await call.setMicrophone(foundMicrophones[0].id);
          if (current) setMicrophone(foundMicrophones[0].id);
        }
        if (foundCameras[0]) {
          await call.setCamera(foundCameras[0].id);
          if (current) setCamera(foundCameras[0].id);
        }
      } catch (caught) {
        if (current) setProblem(deviceProblem(caught));
      }
    })();
    return () => {
      current = false;
    };
  }, [call]);

  const chooseCamera = async (deviceId: string | null) => {
    try {
      await call?.setCamera(deviceId);
      setCamera(deviceId);
      setProblem(null);
    } catch (caught) {
      setProblem(deviceProblem(caught));
    }
  };
  const chooseMicrophone = async (deviceId: string) => {
    try {
      await call?.setMicrophone(deviceId);
      setMicrophone(deviceId);
      setProblem(null);
    } catch (caught) {
      setProblem(deviceProblem(caught));
    }
  };
  return { cameras, microphones, camera, microphone, problem, chooseCamera, chooseMicrophone };
}
```

Create `apps/web/src/calls/DevicePickers.tsx`:

```tsx
import { Field, Select } from "@fluentui/react-components";
import type { Devices } from "./useDevices";

export function DevicePickers({ devices }: { devices: Devices }) {
  return (
    <>
      <Field label="Camera">
        <Select value={devices.camera ?? ""} onChange={(_, data) => void devices.chooseCamera(data.value === "" ? null : data.value)}>
          <option value="">Camera off</option>
          {devices.cameras.map((device) => (
            <option key={device.id} value={device.id}>{device.name}</option>
          ))}
        </Select>
      </Field>
      <Field label="Microphone">
        <Select value={devices.microphone ?? ""} disabled={devices.microphones.length === 0}
          onChange={(_, data) => void devices.chooseMicrophone(data.value)}>
          {devices.microphones.map((device) => (
            <option key={device.id} value={device.id}>{device.name}</option>
          ))}
        </Select>
      </Field>
    </>
  );
}
```

Create `apps/web/src/calls/VideoBox.tsx`:

```tsx
import { makeStyles, tokens } from "@fluentui/react-components";
import { useEffect, useRef } from "react";
import type { RoomCall } from "./RoomCall";

const useStyles = makeStyles({
  tile: { position: "relative", margin: 0, aspectRatio: "16 / 9", overflow: "hidden", borderRadius: tokens.borderRadiusLarge, backgroundColor: "#101828" },
  video: { position: "absolute", inset: 0, "& video": { width: "100%", height: "100%", objectFit: "cover" } },
  label: {
    position: "absolute", left: tokens.spacingHorizontalS, bottom: tokens.spacingVerticalS, padding: `2px ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium, color: "#FFFFFF", backgroundColor: "rgba(16, 24, 40, 0.8)", fontSize: tokens.fontSizeBase200,
  },
});

/** One person's video from the call; `acsId` null is this page's own camera. */
export function VideoBox({ call, acsId, label }: { call: RoomCall; acsId: string | null; label: string }) {
  const styles = useStyles();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    return acsId === null ? call.renderLocal(element) : call.renderVideo(acsId, element);
  }, [call, acsId]);
  return (
    <figure className={styles.tile}>
      <div ref={box} className={styles.video} data-testid="video-box" />
      <figcaption className={styles.label}>{label}</figcaption>
    </figure>
  );
}
```

Create `apps/web/src/people/api.ts`:

```ts
import type { CallSeat, Guest, People } from "../contracts";
import { send } from "../studio/api";

export type Role = "speaker" | "cohost" | "member";
export const ROLE_NAMES: Record<Role, string> = { speaker: "Speaker", cohost: "Co-host", member: "Member" };

const id = encodeURIComponent;
const base = (broadcastId: string) => `/api/broadcasts/${id(broadcastId)}/people`;
const guestBase = (secret: string) => `/api/guest/${id(secret)}`;

export const peopleStream = (broadcastId: string) => `${base(broadcastId)}/stream`;
export const invite = (broadcastId: string, role: Role, name: string) =>
  send<People>("POST", `${base(broadcastId)}/invites`, name.trim() ? { role, name: name.trim() } : { role });
export const revokeInvite = (broadcastId: string, inviteId: string) => send<People>("DELETE", `${base(broadcastId)}/invites/${id(inviteId)}`);
export const setStage = (broadcastId: string, people: string[]) => send<People>("PUT", `${base(broadcastId)}/stage`, { people });
export const hostSeat = (broadcastId: string, name: string) => send<CallSeat>("POST", `${base(broadcastId)}/host/seat`, { name });
export const programSeat = (broadcastId: string) => send<CallSeat>("POST", `${base(broadcastId)}/program/seat`);

export const guestStream = (secret: string) => `${guestBase(secret)}/stream`;
export const getGuest = (secret: string) => send<Guest>("GET", guestBase(secret));
export const joinAsGuest = (secret: string, name: string) => send<CallSeat>("POST", `${guestBase(secret)}/join`, { name: name.trim() });
export const refreshGuestSeat = (secret: string) => send<CallSeat>("POST", `${guestBase(secret)}/seat/refresh`);

/** The address a guest opens: the public one when there is one, else this page's. */
export const inviteLink = (people: People, link: string, origin = window.location.origin) => `${people.public_origin ?? origin}${link}`;
```

Create `apps/web/src/people/stage.ts`:

```ts
import type { People } from "../contracts";
import type { CameraTile } from "../studio/elements";

/** The people on stage, as the cameras element draws them. */
export const stageTiles = (people: People | null): CameraTile[] =>
  (people?.stage ?? []).map((person) => ({ id: person.id, name: person.name, acsId: person.acs_id ?? null, present: person.present }));
```

Create `apps/web/src/people/roomAudio.ts`:

```ts
import { type ProgramAudio, programAudio } from "../studio/capture";

/**
 * Puts the room's voices on the stream. Chrome lets remote WebRTC sound into Web Audio only while a
 * media element plays it, so a muted one does.
 */
export function connectRoomAudio(stream: MediaStream, program: ProgramAudio = programAudio(), makeAudio = () => new Audio()): () => void {
  const element = makeAudio();
  element.muted = true;
  element.srcObject = stream;
  void element.play().catch(() => {});
  const source = program.context.createMediaStreamSource(stream);
  source.connect(program.input);
  return () => {
    source.disconnect();
    element.pause();
    element.srcObject = null;
  };
}
```

Create `apps/web/src/test/FakeRoomCall.ts`:

```ts
import type { CallState, Device, JoinOptions, Participant, RoomCall } from "../calls/RoomCall";

/** A scriptable call: it records what the page asked for, and the test says who is in the room. */
export class FakeRoomCall implements RoomCall {
  state: CallState = "idle";
  participants: Participant[] = [];
  muted = true;
  cameraOn = false;
  problem: string | null = null;
  cameraList: Device[] = [{ id: "cam1", name: "Front camera" }];
  microphoneList: Device[] = [{ id: "mic1", name: "Headset" }];
  failDevices: string | null = null;
  failJoin: string | null = null;
  audio: MediaStream | null = null;
  joined: JoinOptions[] = [];
  mutedOthers: string[] = [];
  rendered: string[] = [];
  left = 0;
  private readonly listeners = new Set<() => void>();

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit() {
    for (const listener of [...this.listeners]) listener();
  }

  async cameras() {
    if (this.failDevices) throw new Error(this.failDevices);
    return this.cameraList;
  }

  async microphones() {
    if (this.failDevices) throw new Error(this.failDevices);
    return this.microphoneList;
  }

  async setCamera(deviceId: string | null) {
    this.cameraOn = deviceId !== null;
    this.emit();
  }

  async setMicrophone(_deviceId: string) {}

  async setMuted(muted: boolean) {
    this.muted = muted;
    this.emit();
  }

  async join(options: JoinOptions) {
    if (this.failJoin) throw new Error(this.failJoin);
    this.joined.push(options);
    this.state = "joined";
    this.emit();
  }

  async leave() {
    this.left += 1;
    this.state = "idle";
    this.emit();
  }

  async muteParticipant(acsId: string) {
    this.mutedOthers.push(acsId);
  }

  renderVideo(acsId: string, element: HTMLElement) {
    this.rendered.push(acsId);
    element.setAttribute("data-video", acsId);
    return () => element.removeAttribute("data-video");
  }

  renderLocal(element: HTMLElement) {
    element.setAttribute("data-video", "local");
    return () => element.removeAttribute("data-video");
  }

  async roomAudio() {
    return this.audio;
  }

  drop() {
    this.state = "dropped";
    this.emit();
  }
}
```

In `apps/web/src/stream/useLiveDocument.ts`, change the signature to `url: string | null`. Make the first line of the effect:

```ts
    if (url === null) return;
```

Add a doc comment line saying a null url follows nothing.

- [ ] **Step 5: Run the web checks**

Run `pnpm test` and `pnpm typecheck` in `apps/web`.
Expected: all pass.

- [ ] **Step 6: Commit**

```powershell
git add apps/web/package.json pnpm-lock.yaml apps/web/src/calls apps/web/src/people apps/web/src/test/FakeRoomCall.ts apps/web/src/test/fixtures.ts apps/web/src/stream/useLiveDocument.ts apps/web/src/stream/useLiveDocument.test.tsx
git commit -m "Add the room call client: Azure, a local stand-in, devices, video and room audio"
```

Check where pnpm wrote the lockfile: `git status --short`. If it is `apps/web/pnpm-lock.yaml` rather than the root one, stage that path instead.

---

### Task 7: The guest page

**Files:**
- Create: `apps/web/src/people/GuestPage.tsx`.
- Modify: `apps/web/src/main.tsx` (the route) and `apps/web/vite.config.ts` (allow the tunnel's hostnames).
- Test: `apps/web/src/people/GuestPage.test.tsx`.

**Interfaces:**
- Consumes: from Task 6, `openRoomCall`, `useCallUpdates`, `useDevices`, `DevicePickers`, `VideoBox`, `RoomCall`, `guestStream`, `getGuest`, `joinAsGuest`, `refreshGuestSeat` and `ROLE_NAMES`. Also `FakeRoomCall`, `guestDoc` and `callSeat`, `studioPath` from `broadcasts/api` and `StudioRequestError` from `studio/api`.
- Produces `GuestPage({ secret, eventSource?, retryMs?, newCall? })` and `guestBanner(doc: Guest): string`, plus the route `/guest/{secret}`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/people/GuestPage.test.tsx`:

```tsx
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { Guest } from "../contracts";
import { callSeat, FakeEventSource, FakeEventSourceCtor, guestDoc } from "../test/fixtures";
import { FakeRoomCall } from "../test/FakeRoomCall";
import { renderUi } from "../test/render";
import { GuestPage, guestBanner } from "./GuestPage";

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

function serve(answers: Record<string, () => Response> = {}) {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    sent.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const answer = answers[`${method} ${url}`];
    if (answer) return answer();
    return new Response(JSON.stringify(method === "GET" ? guestDoc() : callSeat()), { status: 200 });
  }));
  return sent;
}

function open(doc: Guest = guestDoc(), call = new FakeRoomCall()) {
  renderUi(<GuestPage secret="s3cret" eventSource={FakeEventSourceCtor} retryMs={10} newCall={() => call} />);
  act(() => {
    FakeEventSource.last.open();
    FakeEventSource.last.emitRaw(JSON.stringify(doc));
  });
  return call;
}

const send = (doc: Guest) => act(() => FakeEventSource.last.emitRaw(JSON.stringify(doc)));

async function join(call: FakeRoomCall) {
  await waitFor(() => expect(call.cameraOn).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Join" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
}

beforeEach(() => {
  FakeEventSource.instances = [];
});

test("the banner says where the guest is", () => {
  expect(guestBanner(guestDoc({ on_stage: true, broadcast_state: "live" }))).toBe("You're on stage — you're live");
  expect(guestBanner(guestDoc({ on_stage: true }))).toBe("You're on stage");
  expect(guestBanner(guestDoc({ muted_live: true, broadcast_state: "live" }))).toBe("You're backstage and muted while the broadcast is live");
  expect(guestBanner(guestDoc())).toBe("You're backstage");
});

test("the guest previews their camera, names themselves and joins the room", async () => {
  const sent = serve();
  const call = open();
  expect(FakeEventSource.last.url).toBe("/api/guest/s3cret/stream");
  expect(screen.getByText("Join “Derby day” as Speaker")).toBeTruthy();
  await waitFor(() => expect(call.cameraOn).toBe(true));
  expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("Sam");
  fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Sam Lee" } });
  fireEvent.click(screen.getByRole("button", { name: "Join" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
  expect(sent.find((one) => one.method === "POST")).toMatchObject({ url: "/api/guest/s3cret/join", body: { name: "Sam Lee" } });
  expect(call.joined[0]).toMatchObject({ roomId: "room-1", token: "t1", name: "Sam Lee" });
  expect(call.muted).toBe(false);
  expect(await screen.findByText("You're backstage")).toBeTruthy();
});

test("while the broadcast is live a guest backstage is muted and cannot unmute", async () => {
  serve();
  const call = open();
  await join(call);
  send(guestDoc({ revision: 2, joined: true, broadcast_state: "live", muted_live: true }));
  await waitFor(() => expect(call.muted).toBe(true));
  expect((screen.getByRole("button", { name: "Unmute" }) as HTMLButtonElement).disabled).toBe(true);
  send(guestDoc({ revision: 3, joined: true, broadcast_state: "live", on_stage: true }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Unmute" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByText("You're on stage — you're live")).toBeTruthy();
});

test("an unknown link says the invite is no longer valid", async () => {
  serve({ "GET /api/guest/s3cret": () => new Response(JSON.stringify({ detail: [{ loc: ["body", "invite"], msg: "This invite is no longer valid." }] }), { status: 404 }) });
  renderUi(<GuestPage secret="s3cret" eventSource={FakeEventSourceCtor} retryMs={10} newCall={() => new FakeRoomCall()} />);
  expect(await screen.findByText("This invite is no longer valid")).toBeTruthy();
});

test("a guest whose invite is revoked leaves the room", async () => {
  serve();
  const call = open();
  await join(call);
  send(guestDoc({ revision: 2, valid: false }));
  expect(await screen.findByText("This invite is no longer valid")).toBeTruthy();
  await waitFor(() => expect(call.left).toBeGreaterThan(0));
});

test("a co-host can open the studio once they have joined", async () => {
  serve();
  const call = open(guestDoc({ role: "cohost", broadcast_id: "b1" }));
  await join(call);
  expect(screen.getByRole("link", { name: "Open studio" }).getAttribute("href")).toBe("/broadcasts/b1/studio");
});

test("a camera that cannot be used is explained and the guest can still join", async () => {
  serve();
  const call = new FakeRoomCall();
  call.failDevices = "Permission denied";
  open(guestDoc(), call);
  expect(await screen.findByText(/Your camera or microphone could not be used \(Permission denied\)/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Join" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
});

test("the others in the room are shown with their video", async () => {
  serve();
  const call = open();
  await join(call);
  act(() => {
    call.participants = [{ acsId: "8:fake:9", name: "Kim", video: true, speaking: false, muted: false }];
    call.emit();
  });
  expect(await screen.findByText("Kim")).toBeTruthy();
  expect(call.rendered).toContain("8:fake:9");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test -- src/people/GuestPage`
Expected: FAIL. The module `./GuestPage` is not found.

- [ ] **Step 3: Write the page**

Create `apps/web/src/people/GuestPage.tsx`:

```tsx
import { Button, Field, Input, Link, makeStyles, MessageBar, MessageBarBody, Spinner, Text, tokens } from "@fluentui/react-components";
import { MicOffRegular, MicRegular, VideoOffRegular, VideoRegular } from "@fluentui/react-icons";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { studioPath } from "../broadcasts/api";
import { DevicePickers } from "../calls/DevicePickers";
import { openRoomCall } from "../calls/open";
import type { RoomCall } from "../calls/RoomCall";
import { useCallUpdates } from "../calls/useCallUpdates";
import { useDevices } from "../calls/useDevices";
import { VideoBox } from "../calls/VideoBox";
import type { CallSeat, Guest } from "../contracts";
import { useLiveDocument } from "../stream/useLiveDocument";
import { StudioRequestError } from "../studio/api";
import { getGuest, guestStream, joinAsGuest, refreshGuestSeat, ROLE_NAMES } from "./api";

const useStyles = makeStyles({
  page: { minHeight: "100vh", boxSizing: "border-box", display: "flex", justifyContent: "center", padding: tokens.spacingHorizontalXL, backgroundColor: tokens.colorNeutralBackground2 },
  card: {
    width: "min(960px, 100%)", alignSelf: "flex-start", display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL,
    padding: tokens.spacingHorizontalXL, borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow8,
  },
  preview: { width: "100%", maxWidth: "560px" },
  tiles: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: tokens.spacingHorizontalM },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalM },
});

/** Where the guest is, in words. */
export function guestBanner(doc: Guest): string {
  if (doc.on_stage) return doc.broadcast_state === "live" ? "You're on stage — you're live" : "You're on stage";
  return doc.muted_live ? "You're backstage and muted while the broadcast is live" : "You're backstage";
}

function Shell({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return (
    <main className={styles.page}>
      <div className={styles.card}>{children}</div>
    </main>
  );
}

interface GuestPageProps {
  secret: string;
  eventSource?: new (url: string) => EventSource;
  retryMs?: number;
  newCall?: (service: CallSeat["service"]) => RoomCall;
}

/** What someone opens from an invite link: check the camera, say who they are, and join the broadcast's room. */
export function GuestPage({ secret, eventSource, retryMs, newCall = openRoomCall }: GuestPageProps) {
  const styles = useStyles();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let current = true;
    getGuest(secret).catch((caught: unknown) => {
      if (current && caught instanceof StudioRequestError && caught.status === 404) setMissing(true);
    });
    return () => {
      current = false;
    };
  }, [secret]);
  const { doc } = useLiveDocument<Guest>(missing ? null : guestStream(secret), eventSource, retryMs);
  const valid = !missing && (doc?.valid ?? true);
  const service = valid ? (doc?.service ?? null) : null;
  const call = useMemo(() => (service ? newCall(service) : null), [service, newCall]);
  useCallUpdates(call);
  useEffect(() => () => {
    void call?.leave();
  }, [call]);
  const devices = useDevices(call);
  const [name, setName] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const mutedLive = doc?.muted_live ?? false;
  useEffect(() => {
    if (call && mutedLive) void call.setMuted(true);
  }, [call, mutedLive]);

  if (!valid) {
    return (
      <Shell>
        <Text as="h1" size={600} weight="semibold">This invite is no longer valid</Text>
        <Text>Ask the streamer for a new link.</Text>
      </Shell>
    );
  }
  if (!doc) return <Shell><Spinner label="Opening your invite…" /></Shell>;
  if (!call) return <Shell><Text>Guests are not set up on this Kickstream yet.</Text></Shell>;

  const shownName = name ?? doc.joined_name ?? doc.name ?? "";
  const joined = call.state === "joined";
  const join = async () => {
    setJoining(true);
    try {
      const seat = await joinAsGuest(secret, shownName);
      await call.setMuted(doc.muted_live);
      await call.join({ roomId: seat.room_id, token: seat.token, name: shownName.trim(), refresh: async () => (await refreshGuestSeat(secret)).token });
      setProblem(null);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "You could not join.");
    } finally {
      setJoining(false);
    }
  };

  return (
    <Shell>
      <Text as="h1" size={600} weight="semibold">
        {joined ? `“${doc.broadcast_title}”` : `Join “${doc.broadcast_title}” as ${ROLE_NAMES[doc.role]}`}
      </Text>
      {problem && <MessageBar intent="error"><MessageBarBody>{problem}</MessageBarBody></MessageBar>}
      {devices.problem && <MessageBar intent="warning"><MessageBarBody>{devices.problem}</MessageBarBody></MessageBar>}
      {joined ? (
        <>
          <MessageBar intent={doc.on_stage ? "success" : "info"}><MessageBarBody>{guestBanner(doc)}</MessageBarBody></MessageBar>
          <div className={styles.row}>
            <Button icon={call.muted ? <MicOffRegular /> : <MicRegular />} disabled={call.muted && doc.muted_live}
              onClick={() => void call.setMuted(!call.muted)}>
              {call.muted ? "Unmute" : "Mute"}
            </Button>
            <Button icon={call.cameraOn ? <VideoRegular /> : <VideoOffRegular />}
              onClick={() => void devices.chooseCamera(call.cameraOn ? null : (devices.cameras[0]?.id ?? null))}>
              {call.cameraOn ? "Turn camera off" : "Turn camera on"}
            </Button>
            {doc.role === "cohost" && doc.broadcast_id && <Link href={studioPath(doc.broadcast_id)}>Open studio</Link>}
          </div>
          <div className={styles.tiles}>
            <VideoBox call={call} acsId={null} label={`${shownName} (you)`} />
            {call.participants.map((participant) => (
              <VideoBox key={participant.acsId} call={call} acsId={participant.acsId} label={participant.name} />
            ))}
          </div>
        </>
      ) : (
        <>
          <div className={styles.preview}><VideoBox call={call} acsId={null} label="Preview" /></div>
          <DevicePickers devices={devices} />
          <Field label="Your name">
            <Input value={shownName} maxLength={40} onChange={(_, data) => setName(data.value)} />
          </Field>
          <Button appearance="primary" disabled={joining || shownName.trim() === ""} onClick={() => void join()}>Join</Button>
        </>
      )}
    </Shell>
  );
}
```

In `apps/web/src/main.tsx`, import `GuestPage` from `./people/GuestPage`. Add this before the `/studio` check in `Page`:

```tsx
  const guest = /^\/guest\/([^/]+)$/.exec(path);
  if (guest) return <GuestPage secret={decodeURIComponent(guest[1])} />;
```

Then extend the page list in the doc comment: "...and a guest's page, opened from an invite link."

In `apps/web/vite.config.ts`, read the tunnel's hostnames from the environment, or from the `.env` at the top of the project, so the dev server serves them:

```ts
/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "KICKSTREAM_");
  const publicHosts = (env.KICKSTREAM_PUBLIC_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean);
  return {
    plugins: [react()],
    // KICKSTREAM_API lets the browser tests point their own dev server at their own pipeline.
    // A tunnel's hostnames (KICKSTREAM_PUBLIC_HOSTS) are served too, so guests can open their links.
    server: {
      port: 5173,
      allowedHosts: publicHosts,
      proxy: { "/api": { target: env.KICKSTREAM_API ?? "http://127.0.0.1:8000", ws: true } },
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
      // The first render of the whole dashboard is slow on a cold, busy machine.
      testTimeout: 20_000,
    },
  };
});
```

`loadEnv` merges `process.env`, so the `KICKSTREAM_API` that the end-to-end config passes still applies.

- [ ] **Step 4: Run the web checks**

Run `pnpm test` and `pnpm typecheck` in `apps/web`.
Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add apps/web/src/people/GuestPage.tsx apps/web/src/people/GuestPage.test.tsx apps/web/src/main.tsx apps/web/vite.config.ts
git commit -m "Add the guest page: preview, name and join from an invite link"
```

---

### Task 8: The People panel in the studio

**Files:**
- Create: `apps/web/src/people/PeoplePanel.tsx`.
- Modify: `apps/web/src/studio/StudioPage.tsx`.
- Test: `apps/web/src/people/PeoplePanel.test.tsx` and `apps/web/src/studio/StudioPage.test.tsx`.

**Interfaces:**
- Consumes: from Task 6, `invite`, `revokeInvite`, `setStage`, `hostSeat`, `inviteLink`, `ROLE_NAMES`, `Role`, `peopleStream`, `stageTiles`, `useCallUpdates`, `useDevices`, `DevicePickers`, `VideoBox` and `openRoomCall`. Also `withFallbacks(scene, studio, cameras)` from Task 5.
- Produces `PeoplePanel({ broadcastId, people, live, onPeople, newCall? })`, `HOST = "host"`, `SETUP` and `inviteLabel(invite)`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/people/PeoplePanel.test.tsx`:

```tsx
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { People } from "../contracts";
import { callSeat, invitation, peopleDoc } from "../test/fixtures";
import { FakeRoomCall } from "../test/FakeRoomCall";
import { PeoplePanel, SETUP } from "./PeoplePanel";

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

function serve(answer: People = peopleDoc()) {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    sent.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const body = url.endsWith("/seat") ? callSeat({ acs_id: "8:fake:host" }) : answer;
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  return sent;
}

function show(people: People | null, { live = false, call = new FakeRoomCall() } = {}) {
  const onPeople = vi.fn();
  const ui = (doc: People | null, isLive = live) => (
    <FluentProvider theme={webLightTheme}>
      <PeoplePanel broadcastId="b1" people={doc} live={isLive} onPeople={onPeople} newCall={() => call} />
    </FluentProvider>
  );
  const view = render(ui(people));
  return { onPeople, call, rerender: (doc: People | null, isLive = live) => view.rerender(ui(doc, isLive)) };
}

const joinedSam = invitation({ joined_name: "Sam", acs_id: "8:fake:2", present: true });

test("with no calling service the panel says how to set one up", () => {
  serve();
  show(peopleDoc({ service: null }));
  expect(screen.getByText(SETUP)).toBeTruthy();
});

test("the streamer invites someone with a role and an optional name", async () => {
  const sent = serve();
  const { onPeople } = show(peopleDoc());
  fireEvent.change(screen.getByLabelText("Role"), { target: { value: "cohost" } });
  fireEvent.change(screen.getByLabelText("Name (optional)"), { target: { value: "Kim" } });
  fireEvent.click(screen.getByRole("button", { name: "Invite" }));
  await waitFor(() => expect(onPeople).toHaveBeenCalled());
  expect(sent.at(-1)).toMatchObject({ url: "/api/broadcasts/b1/people/invites", method: "POST", body: { role: "cohost", name: "Kim" } });
});

test("each invite shows its public link to copy, its role and whether the guest is here", async () => {
  serve();
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  show(peopleDoc({ invites: [joinedSam, invitation({ id: "i2", role: "member", name: "Mia", link: "/guest/def" })] }));
  const guests = within(screen.getByRole("list", { name: "Guests" }));
  expect((guests.getByLabelText("Invite link for Sam") as HTMLInputElement).value).toBe("https://guests.example/guest/abc");
  fireEvent.click(guests.getByRole("button", { name: "Copy link for Sam" }));
  expect(writeText).toHaveBeenCalledWith("https://guests.example/guest/abc");
  expect(guests.getByText("Present")).toBeTruthy();
  expect(guests.getByText("Not joined yet")).toBeTruthy();
  expect(guests.getByText("Member")).toBeTruthy();
});

test("joined speakers go on and off the stage, and members never do", async () => {
  const sent = serve();
  const { rerender } = show(peopleDoc({ invites: [joinedSam, invitation({ id: "i2", role: "member", name: "Mia", link: "/guest/def", acs_id: "8:fake:3" })] }));
  expect(screen.queryByRole("button", { name: "Add Mia to stage" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add Sam to stage" }));
  await waitFor(() => expect(sent.at(-1)).toMatchObject({ url: "/api/broadcasts/b1/people/stage", method: "PUT", body: { people: ["i1"] } }));
  rerender(peopleDoc({ invites: [joinedSam], stage: [{ id: "i1", name: "Sam", acs_id: "8:fake:2", present: true }] }));
  fireEvent.click(screen.getByRole("button", { name: "Remove Sam from stage" }));
  await waitFor(() => expect(sent.at(-1)).toMatchObject({ body: { people: [] } }));
});

test("a guest who has not joined cannot be put on stage yet", () => {
  serve();
  show(peopleDoc({ invites: [invitation()] }));
  expect((screen.getByRole("button", { name: "Add Sam to stage" }) as HTMLButtonElement).disabled).toBe(true);
});

test("revoking an invite asks the pipeline to stop the link", async () => {
  const sent = serve();
  show(peopleDoc({ invites: [joinedSam] }));
  fireEvent.click(screen.getByRole("button", { name: "Revoke invite for Sam" }));
  await waitFor(() => expect(sent.at(-1)).toMatchObject({ url: "/api/broadcasts/b1/people/invites/i1", method: "DELETE" }));
});

test("the host joins with their camera and can put themselves on stage", async () => {
  const sent = serve();
  const { call, rerender } = show(peopleDoc());
  fireEvent.click(screen.getByRole("button", { name: "Join with camera" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
  expect(sent.find((one) => one.url.endsWith("/host/seat"))).toMatchObject({ method: "POST", body: { name: "Host" } });
  expect(call.joined[0]).toMatchObject({ roomId: "room-1", name: "Host" });
  rerender(peopleDoc({ host_acs_id: "8:fake:host" }));
  fireEvent.click(screen.getByRole("button", { name: "Add me to stage" }));
  await waitFor(() => expect(sent.at(-1)).toMatchObject({ body: { people: ["host"] } }));
});

test("while live the host off stage is muted and cannot unmute", async () => {
  serve();
  const { call } = show(peopleDoc(), { live: true });
  fireEvent.click(screen.getByRole("button", { name: "Join with camera" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
  expect(call.muted).toBe(true);
  expect((screen.getByRole("button", { name: "Unmute" }) as HTMLButtonElement).disabled).toBe(true);
});

test("the host can mute a guest who is in the room", async () => {
  serve();
  const { call } = show(peopleDoc({ invites: [joinedSam] }));
  fireEvent.click(screen.getByRole("button", { name: "Join with camera" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
  fireEvent.click(await screen.findByRole("button", { name: "Mute Sam" }));
  await waitFor(() => expect(call.mutedOthers).toEqual(["8:fake:2"]));
});
```

Append to `apps/web/src/studio/StudioPage.test.tsx`. Import `broadcast`, `broadcasts` and `peopleDoc` from the fixtures.

```tsx
test("a broadcast's studio has a People panel, and who is on stage reaches the program preview", async () => {
  serve();
  renderUi(<StudioPage broadcastId="b1" eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} />);
  act(() => {
    stream("/api/studio/stream").open();
    stream("/api/studio/stream").emitRaw(JSON.stringify(studio()));
    stream("/api/broadcasts/stream").open();
    stream("/api/broadcasts/stream").emitRaw(JSON.stringify(broadcasts({ broadcasts: [broadcast()], current_id: "b1" })));
    stream("/api/broadcasts/b1/people/stream").open();
    stream("/api/broadcasts/b1/people/stream").emitRaw(JSON.stringify(peopleDoc({ stage: [{ id: "i1", name: "Sam", acs_id: null, present: true }] })));
  });
  expect(within(screen.getByRole("region", { name: "People" })).getByRole("button", { name: "Invite" })).toBeTruthy();
  const preview = within(screen.getByRole("region", { name: "Program preview" }));
  expect(preview.getByTestId("camera-tile").textContent).toContain("Sam");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test -- src/people/PeoplePanel src/studio/StudioPage`
Expected: FAIL. The module `./PeoplePanel` is not found, and there is no People region.

- [ ] **Step 3: Write the panel**

Create `apps/web/src/people/PeoplePanel.tsx`:

```tsx
import { Badge, Button, Field, Input, makeStyles, MessageBar, MessageBarBody, Select, Text, tokens, Tooltip } from "@fluentui/react-components";
import { CopyRegular, DeleteRegular, MicOffRegular, MicRegular, PersonAddRegular, VideoRegular } from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import { DevicePickers } from "../calls/DevicePickers";
import { openRoomCall } from "../calls/open";
import type { RoomCall } from "../calls/RoomCall";
import { useCallUpdates } from "../calls/useCallUpdates";
import { useDevices } from "../calls/useDevices";
import { VideoBox } from "../calls/VideoBox";
import type { CallSeat, Invite, People } from "../contracts";
import { hostSeat, invite, inviteLink, revokeInvite, type Role, ROLE_NAMES, setStage } from "./api";

export const HOST = "host";
export const SETUP = "Guests need Azure Communication Services. Put KICKSTREAM_ACS_CONNECTION_STRING in the .env file at the top of the project, then restart the pipeline.";
const MAX_INVITES = 12;

export const inviteLabel = (item: Invite) => item.joined_name ?? item.name ?? ROLE_NAMES[item.role];

const useStyles = makeStyles({
  panel: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  item: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalXS },
  grow: { flexGrow: 1, minWidth: 0 },
  tiles: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: tokens.spacingHorizontalS },
});

interface PeoplePanelProps {
  broadcastId: string;
  people: People | null;
  /** While the broadcast is live, everyone off stage is muted. */
  live: boolean;
  onPeople(doc: People): void;
  newCall?: (service: CallSeat["service"]) => RoomCall;
}

/** Who takes part in the broadcast: invite links by role, who is here, the stage, and the host's own camera. */
export function PeoplePanel({ broadcastId, people, live, onPeople, newCall = openRoomCall }: PeoplePanelProps) {
  const styles = useStyles();
  const [role, setRole] = useState<Role>("speaker");
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [call, setCall] = useState<RoomCall | null>(null);
  useCallUpdates(call);
  const devices = useDevices(call);
  useEffect(() => () => {
    void call?.leave();
  }, [call]);
  const stage = people?.stage.map((person) => person.id) ?? [];
  const hostOnStage = stage.includes(HOST);
  useEffect(() => {
    if (call && live && !hostOnStage) void call.setMuted(true);
  }, [call, live, hostOnStage]);

  if (!people) return <Text>Loading people…</Text>;
  const service = people.service;
  if (!service) return <MessageBar intent="info"><MessageBarBody>{SETUP}</MessageBarBody></MessageBar>;

  const run = async (request: () => Promise<People>) => {
    try {
      onPeople(await request());
      setProblem(null);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The change was not made.");
    }
  };
  const toggleStage = (personId: string) =>
    void run(() => setStage(broadcastId, stage.includes(personId) ? stage.filter((id) => id !== personId) : [...stage, personId]));
  const joinHost = async () => {
    const made = newCall(service);
    setCall(made);
    try {
      const seat = await hostSeat(broadcastId, people.host_name);
      await made.setMuted(live && !hostOnStage);
      await made.join({ roomId: seat.room_id, token: seat.token, name: people.host_name, refresh: async () => (await hostSeat(broadcastId, people.host_name)).token });
      setProblem(null);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "Your camera could not join.");
    }
  };
  const open = people.invites.filter((item) => !item.revoked);
  const inRoom = call?.state === "joined";

  return (
    <div className={styles.panel}>
      {problem && <MessageBar intent="error"><MessageBarBody>{problem}</MessageBarBody></MessageBar>}
      {devices.problem && <MessageBar intent="warning"><MessageBarBody>{devices.problem}</MessageBarBody></MessageBar>}
      <div className={styles.item}>
        <div className={styles.row}>
          <Text weight="semibold" className={styles.grow}>{`${people.host_name} (you)`}</Text>
          {hostOnStage && <Badge color="danger">On stage</Badge>}
        </div>
        {call === null ? (
          <Button icon={<VideoRegular />} onClick={() => void joinHost()}>Join with camera</Button>
        ) : (
          <>
            <VideoBox call={call} acsId={null} label="You" />
            <DevicePickers devices={devices} />
            <div className={styles.row}>
              <Button size="small" icon={call.muted ? <MicOffRegular /> : <MicRegular />} disabled={call.muted && live && !hostOnStage}
                onClick={() => void call.setMuted(!call.muted)}>
                {call.muted ? "Unmute" : "Mute"}
              </Button>
              <Button size="small" disabled={!hostOnStage && !people.host_acs_id} onClick={() => toggleStage(HOST)}>
                {hostOnStage ? "Remove me from stage" : "Add me to stage"}
              </Button>
            </div>
          </>
        )}
      </div>
      <ul className={styles.list} aria-label="Guests">
        {open.map((item) => {
          const label = inviteLabel(item);
          const onStage = stage.includes(item.id);
          const url = inviteLink(people, item.link);
          return (
            <li key={item.id} className={styles.item}>
              <div className={styles.row}>
                <Text weight="semibold" className={styles.grow}>{label}</Text>
                <Badge appearance="tint">{ROLE_NAMES[item.role]}</Badge>
                <Badge appearance="outline" color={item.present ? "success" : "informative"}>
                  {item.present ? "Present" : item.acs_id ? "Away" : "Not joined yet"}
                </Badge>
                {onStage && <Badge color="danger">On stage</Badge>}
              </div>
              <div className={styles.row}>
                <Input readOnly size="small" className={styles.grow} aria-label={`Invite link for ${label}`} value={url} />
                <Tooltip content="Copy link" relationship="description">
                  <Button size="small" appearance="subtle" icon={<CopyRegular />} aria-label={`Copy link for ${label}`}
                    onClick={() => void navigator.clipboard?.writeText(url)} />
                </Tooltip>
              </div>
              <div className={styles.row}>
                {item.role !== "member" && (
                  <Button size="small" disabled={!onStage && !item.acs_id} onClick={() => toggleStage(item.id)}>
                    {onStage ? `Remove ${label} from stage` : `Add ${label} to stage`}
                  </Button>
                )}
                {inRoom && item.present && item.acs_id && (
                  <Button size="small" icon={<MicOffRegular />} aria-label={`Mute ${label}`} onClick={() => void call.muteParticipant(item.acs_id!)}>Mute</Button>
                )}
                <Button size="small" appearance="subtle" icon={<DeleteRegular />} aria-label={`Revoke invite for ${label}`}
                  onClick={() => void run(() => revokeInvite(broadcastId, item.id))}>
                  Revoke
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {inRoom && call.participants.length > 0 && (
        <div className={styles.tiles} aria-label="In the room">
          {call.participants.map((participant) => (
            <VideoBox key={participant.acsId} call={call} acsId={participant.acsId} label={participant.name} />
          ))}
        </div>
      )}
      <div className={styles.row}>
        <Field label="Role">
          <Select value={role} onChange={(_, data) => setRole(data.value as Role)}>
            <option value="speaker">Speaker</option>
            <option value="cohost">Co-host</option>
            <option value="member">Member</option>
          </Select>
        </Field>
        <Field label="Name (optional)" className={styles.grow}>
          <Input value={name} maxLength={40} onChange={(_, data) => setName(data.value)} />
        </Field>
      </div>
      <Button appearance="primary" icon={<PersonAddRegular />} disabled={open.length >= MAX_INVITES}
        onClick={() => void run(async () => {
          const doc = await invite(broadcastId, role, name);
          setName("");
          return doc;
        })}>
        Invite
      </Button>
    </div>
  );
}
```

The stage buttons have visible text such as "Add Sam to stage", so their accessible name matches the tests without an `aria-label`.

- [ ] **Step 4: Put the panel in the studio**

In `apps/web/src/studio/StudioPage.tsx`:
- Imports: add `PeopleTeamRegular` to the icons; `People` to the contracts import; `peopleStream` from `../people/api`; `PeoplePanel` from `../people/PeoplePanel`; and `stageTiles` from `../people/stage`.
- After the `useLiveDocument<Output>` line, add:

  ```tsx
  const { doc: people, accept: acceptPeople } = useLiveDocument<People>(broadcastId !== undefined ? peopleStream(broadcastId) : null, eventSource, retryMs);
  ```

- After `const editing = ...`, add `const cameras = stageTiles(people);`, and change `data` to `{ match, studio, now, language: studio.settings.language, cameras }`.
- In the program preview, use `withFallbacks(onAir, studio, cameras)`.
- Replace the scenes card `<div className={mergeClasses(styles.card, styles.scenes)}> <SceneList .../> </div>` with:

  ```tsx
        <div className={mergeClasses(styles.column, styles.scenes)}>
          <div className={styles.card}>
            <SceneList ...the same props as before... />
          </div>
          {broadcastId !== undefined && (
            <section className={styles.card} aria-label="People">
              <Heading icon={<PeopleTeamRegular />} title="People" />
              <PeoplePanel broadcastId={broadcastId} people={people} live={link.broadcast?.state === "live"} onPeople={acceptPeople} />
            </section>
          )}
        </div>
  ```

- [ ] **Step 5: Run the web checks**

Run `pnpm test` and `pnpm typecheck` in `apps/web`.
Expected: all pass.

- [ ] **Step 6: Commit**

```powershell
git add apps/web/src/people/PeoplePanel.tsx apps/web/src/people/PeoplePanel.test.tsx apps/web/src/studio/StudioPage.tsx apps/web/src/studio/StudioPage.test.tsx
git commit -m "Add the studio's People panel: invites, stage, mute, revoke and the host's camera"
```

---

### Task 9: The program joins the room

**Files:**
- Create: `apps/web/src/people/useProgramCall.ts`.
- Modify: `apps/web/src/studio/ProgramPage.tsx` and `services/pipeline/kickstream/adapters/chromium_capture.py`.
- Test: `apps/web/src/studio/ProgramPage.test.tsx` and `services/pipeline/tests/test_output_browser.py` (a unit test for the user agent).

**Interfaces:**
- Consumes: from Task 6, `openRoomCall`, `programSeat`, `peopleStream`, `stageTiles`, `connectRoomAudio`, `useCallUpdates` and `FakeRoomCall`. From Task 5, `CameraTile`, `ProgramData.cameras` and `renderVideo`.
- Produces `useProgramCall(options: ProgramCallOptions) -> { cameras: CameraTile[]; renderVideo?: (acsId, element) => () => void }`. `ProgramCallOptions` holds `eventSource?`, `retryMs?`, `newCall?`, `seat?`, `connectAudio?` and `rejoinMs?`. `ProgramPage` accepts the same options as props.
- Produces `honest_user_agent(agent) -> str` in `chromium_capture.py`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/studio/ProgramPage.test.tsx`. Import `broadcast`, `broadcasts`, `callSeat` and `peopleDoc` from the fixtures, and `FakeRoomCall` from `../test/FakeRoomCall`.

```tsx
function serveSeats() {
  const asked: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    asked.push(url);
    if (url.endsWith("/program/seat")) return new Response(JSON.stringify(callSeat({ acs_id: "8:fake:program" })), { status: 200 });
    return new Response("{}", { status: 404 });
  }));
  return asked;
}

function showWithGuests(call: FakeRoomCall, connectAudio = vi.fn(() => () => {})) {
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} newCall={() => call} connectAudio={connectAudio} rejoinMs={10} />);
  push(studio());
  act(() => {
    const doc = stream("/api/broadcasts/stream")!;
    doc.open();
    doc.emitRaw(JSON.stringify(broadcasts({ broadcasts: [broadcast({ state: "live" })], current_id: "b1" })));
  });
  act(() => {
    const doc = stream("/api/broadcasts/b1/people/stream")!;
    doc.open();
    doc.emitRaw(JSON.stringify(peopleDoc({ stage: [{ id: "i1", name: "Sam", acs_id: "8:fake:2", present: true }] })));
  });
  return connectAudio;
}

test("the program joins the room of the broadcast on air, shows who is on stage and carries their voices", async () => {
  const asked = serveSeats();
  const call = new FakeRoomCall();
  call.audio = {} as MediaStream;
  const connectAudio = showWithGuests(call);
  await waitFor(() => expect(call.joined).toHaveLength(1));
  expect(asked).toContain("/api/broadcasts/b1/people/program/seat");
  expect(call.joined[0]).toMatchObject({ roomId: "room-1", token: "t1", name: "Program", receiveOnly: true });
  expect(screen.getByTestId("camera-tile").textContent).toContain("Sam");
  await waitFor(() => expect(call.rendered).toContain("8:fake:2"));
  await waitFor(() => expect(connectAudio).toHaveBeenCalledWith(call.audio));
});

test("the program rejoins by itself when the call drops", async () => {
  serveSeats();
  const call = new FakeRoomCall();
  showWithGuests(call);
  await waitFor(() => expect(call.joined).toHaveLength(1));
  act(() => call.drop());
  await waitFor(() => expect(call.joined).toHaveLength(2));
});

test("with no room the program joins nothing", async () => {
  serveSeats();
  const call = new FakeRoomCall();
  renderUi(<ProgramPage eventSource={FakeEventSourceCtor} retryMs={10} pollMs={10} newCall={() => call} />);
  push(studio());
  act(() => {
    const doc = stream("/api/broadcasts/stream")!;
    doc.open();
    doc.emitRaw(JSON.stringify(broadcasts({ broadcasts: [broadcast()], current_id: "b1" })));
  });
  act(() => {
    const doc = stream("/api/broadcasts/b1/people/stream")!;
    doc.open();
    doc.emitRaw(JSON.stringify(peopleDoc({ room_id: null })));
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(call.joined).toHaveLength(0);
});
```

Append to `services/pipeline/tests/test_output_browser.py`. Import `honest_user_agent` from `kickstream.adapters.chromium_capture`.

```python
def test_the_hidden_browser_does_not_call_itself_headless():
    agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36"
    assert honest_user_agent(agent) == agent.replace("HeadlessChrome", "Chrome")
    assert honest_user_agent("Mozilla/5.0 Chrome/141.0") == "Mozilla/5.0 Chrome/141.0"
```

- [ ] **Step 2: Run them to see them fail**

Run `pnpm test -- src/studio/ProgramPage` in `apps/web`, then `uv run pytest -q tests/test_output_browser.py -k headless` in `services/pipeline`.
Expected: FAIL. `call.joined` stays empty, and `honest_user_agent` cannot be imported.

- [ ] **Step 3: Write the hook**

Create `apps/web/src/people/useProgramCall.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import { BROADCASTS_STREAM } from "../broadcasts/api";
import { openRoomCall } from "../calls/open";
import type { RoomCall } from "../calls/RoomCall";
import { useCallUpdates } from "../calls/useCallUpdates";
import type { Broadcasts, CallSeat, People } from "../contracts";
import { useLiveDocument } from "../stream/useLiveDocument";
import type { CameraTile } from "../studio/elements";
import { peopleStream, programSeat } from "./api";
import { connectRoomAudio } from "./roomAudio";
import { stageTiles } from "./stage";

export interface ProgramCallOptions {
  eventSource?: new (url: string) => EventSource;
  retryMs?: number;
  newCall?: (service: CallSeat["service"]) => RoomCall;
  seat?: (broadcastId: string) => Promise<CallSeat>;
  connectAudio?: (stream: MediaStream) => () => void;
  rejoinMs?: number;
}

/**
 * The program's receive-only seat in the room of the broadcast on air, else of the current one: who
 * is on stage, their video, and their voices on the stream.
 */
export function useProgramCall({
  eventSource, retryMs, newCall = openRoomCall, seat = programSeat, connectAudio = connectRoomAudio, rejoinMs = 3000,
}: ProgramCallOptions = {}): { cameras: CameraTile[]; renderVideo?: (acsId: string, element: HTMLElement) => () => void } {
  const { doc: broadcasts } = useLiveDocument<Broadcasts>(BROADCASTS_STREAM, eventSource, retryMs);
  const target = broadcasts?.broadcasts.find((item) => item.state === "live")?.id ?? broadcasts?.current_id ?? null;
  const { doc } = useLiveDocument<People>(target ? peopleStream(target) : null, eventSource, retryMs);
  const people = doc?.broadcast_id === target ? doc : null;
  const roomId = people?.room_id ?? null;
  const service = people?.service ?? null;

  const [call, setCall] = useState<RoomCall | null>(null);
  const [attempt, setAttempt] = useState(0);
  useCallUpdates(call);

  useEffect(() => {
    if (!target || !roomId || !service) return;
    const made = newCall(service);
    let gone = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const again = () => {
      if (gone || retry !== undefined) return;
      retry = setTimeout(() => setAttempt((count) => count + 1), rejoinMs);
    };
    const off = made.onChange(() => {
      if (made.state === "dropped") again();
    });
    setCall(made);
    seat(target)
      .then((given) => (gone ? undefined : made.join({
        roomId: given.room_id, token: given.token, name: "Program", receiveOnly: true, refresh: async () => (await seat(target)).token,
      })))
      .catch(again);
    return () => {
      gone = true;
      clearTimeout(retry);
      off();
      setCall(null);
      void made.leave();
    };
  }, [target, roomId, service, attempt, newCall, seat, rejoinMs]);

  const joined = call?.state === "joined";
  useEffect(() => {
    if (!call || !joined) return;
    let gone = false;
    let undo: (() => void) | null = null;
    const attach = () => {
      if (undo || gone) return;
      void call.roomAudio().then((stream) => {
        if (!gone && stream && !undo) undo = connectAudio(stream);
      });
    };
    attach();
    const off = call.onChange(attach);
    return () => {
      gone = true;
      off();
      undo?.();
    };
  }, [call, joined, connectAudio]);

  const renderVideo = useCallback((acsId: string, element: HTMLElement) => call?.renderVideo(acsId, element) ?? (() => {}), [call]);
  return { cameras: stageTiles(people), renderVideo: call ? renderVideo : undefined };
}
```

- [ ] **Step 4: Use it on the program page**

In `apps/web/src/studio/ProgramPage.tsx`, import `type ProgramCallOptions` and `useProgramCall` from `../people/useProgramCall`. Change the signature to:

```tsx
export function ProgramPage({
  eventSource, retryMs, pollMs, capture = startCapture, newCall, seat, connectAudio, rejoinMs,
}: CurrentMatchOptions & ProgramCallOptions & { capture?: typeof startCapture }) {
```

After `const size = useWindowSize();`, add `const guests = useProgramCall({ eventSource, retryMs, newCall, seat, connectAudio, rejoinMs });`. Then change the canvas to:

```tsx
        <SceneCanvas scene={withFallbacks(active, studio, guests.cameras)} scale={fitScale(size.width, size.height)}
          data={{ match, studio, now, language: studio.settings.language, cameras: guests.cameras, renderVideo: guests.renderVideo }} />
```

- [ ] **Step 5: Make the capture browser report a non-headless user agent**

In `services/pipeline/kickstream/adapters/chromium_capture.py`, add after `_without_token`:

```python
def honest_user_agent(agent: str) -> str:
    """Calling services turn away browsers that say they are headless, and the program page joins calls."""
    return agent.replace("HeadlessChrome", "Chrome")
```

Add a method to `ChromiumCapture`:

```python
    async def _honest_user_agent(self) -> None:
        answer = await self._call("Runtime.evaluate", expression="navigator.userAgent", returnByValue=True)
        agent = answer.get("result", {}).get("value")
        if isinstance(agent, str) and agent != honest_user_agent(agent):
            await self._call("Emulation.setUserAgentOverride", userAgent=honest_user_agent(agent))
```

In `start`, just before `await self._within(browser_late, self._call("Page.navigate", url=url))`, add:

```python
            await self._within(browser_late, self._honest_user_agent())
```

- [ ] **Step 6: Run the checks**

Run `pnpm test` and `pnpm typecheck` in `apps/web`. In `services/pipeline`, run `uv run pytest -q tests/test_output_browser.py`, `uv run ruff check .` and `uv run ruff format --check .`.
Expected: all pass. The browser test file passes when run alone.

- [ ] **Step 7: Commit**

```powershell
git add apps/web/src/people/useProgramCall.ts apps/web/src/studio/ProgramPage.tsx apps/web/src/studio/ProgramPage.test.tsx services/pipeline/kickstream/adapters/chromium_capture.py services/pipeline/tests/test_output_browser.py
git commit -m "The program joins the broadcast's room: cameras on stage and their voices on the stream"
```

---

### Task 10: End to end, the Azure run, and the docs

**Files:**
- Modify: `apps/web/playwright.config.ts` and `apps/web/package.json` (the `e2e:acs` script).
- Create: `apps/web/playwright.acs.config.ts`, `apps/web/e2e/guests.spec.ts` and `apps/web/e2e-acs/guests-acs.spec.ts`.
- Modify: `README.md`.

**Interfaces:**
- Consumes: every route and page from Tasks 1–9; `openStudio(page, request, title)` from `e2e/broadcasts.ts`.
- Produces `webServers(env)`, exported from `playwright.config.ts`.

- [ ] **Step 1: Run the end-to-end tests with fake rooms, a public host and fake devices**

Replace `apps/web/playwright.config.ts` with:

```ts
import { defineConfig } from "@playwright/test";

// No model endpoint is configured, so the whole run uses scripted narratives.
const NO_MODEL = { KICKSTREAM_LLM_BASE_URL: "", KICKSTREAM_LLM_MODEL: "", KICKSTREAM_LLM_API_KEY: "" };
// The tests run their own pipeline and dev server, on their own ports and data directory, so they
// never touch the scenes or match of a developer who has Kickstream running.
export const API = "http://127.0.0.1:8010";
export const WEB = "http://127.0.0.1:5183";
/** The tunnel the tests pretend guests come through. */
export const PUBLIC_HOST = "guests.example";
// A fresh data directory for every run, so one run's scenes and broadcasts never meet the next.
// The hidden browser must open the program page on the tests' own dev server, not a developer's.
// Guests use in-memory rooms, so no test needs Azure.
const TEST_SERVER = {
  ...NO_MODEL, KICKSTREAM_DATA_DIR: `.data-e2e/${Date.now()}`, KICKSTREAM_PROGRAM_URL: `${WEB}/studio?output`,
  KICKSTREAM_ROOMS: "fake", KICKSTREAM_PUBLIC_HOSTS: PUBLIC_HOST,
};

export function webServers(env: Record<string, string> = {}) {
  return [
    {
      command: "uv run --project ../../services/pipeline uvicorn kickstream.app:create_app --factory --port 8010",
      url: `${API}/api/teams`,
      env: { ...TEST_SERVER, ...env },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "pnpm dev --host 127.0.0.1 --port 5183 --strictPort",
      url: WEB,
      env: { KICKSTREAM_API: API, KICKSTREAM_PUBLIC_HOSTS: PUBLIC_HOST },
      reuseExistingServer: false,
    },
  ];
}

export default defineConfig({
  testDir: "e2e",
  // The server runs one match at a time, so tests that start matches must not overlap.
  workers: 1,
  timeout: 120_000,
  use: {
    baseURL: WEB,
    // A test pattern and a beep stand in for a guest's camera and microphone.
    permissions: ["camera", "microphone"],
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  },
  webServer: webServers(),
});
```

- [ ] **Step 2: Write the always-on guests test**

Create `apps/web/e2e/guests.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { openStudio } from "./broadcasts";

// The test pipeline and dev server; see playwright.config.ts.
const API = "http://127.0.0.1:8010/api";
const WEB = "http://127.0.0.1:5183";
const PUBLIC_HOST = "guests.example";

test("the streamer invites guests by link, puts a speaker on stage, and revokes the invite", async ({ page, browser, request }) => {
  await openStudio(page, request, `Guests test ${Date.now()}`);
  const people = page.getByRole("region", { name: "People" });
  await people.getByLabel("Name (optional)").fill("Sam");
  await people.getByRole("button", { name: "Invite" }).click();
  const link = people.getByLabel("Invite link for Sam");
  await expect(link).toHaveValue(new RegExp(`^https://${PUBLIC_HOST}/guest/`));
  // The link names the public address; the test opens the same path on the local one.
  const path = new URL(await link.inputValue()).pathname;
  await people.getByLabel("Role").selectOption("member");
  await people.getByLabel("Name (optional)").fill("Mia");
  await people.getByRole("button", { name: "Invite" }).click();
  await expect(people.getByLabel("Invite link for Mia")).toBeVisible();
  await expect(people.getByRole("button", { name: "Add Mia to stage" })).toHaveCount(0);

  const guestContext = await browser.newContext({ permissions: ["camera", "microphone"] });
  try {
    const guest = await guestContext.newPage();
    await guest.goto(path);
    await expect(guest.getByText(/Join “Guests test \d+” as Speaker/)).toBeVisible();
    await expect(guest.getByLabel("Your name")).toHaveValue("Sam");
    await guest.getByRole("button", { name: "Join" }).click();
    await expect(guest.getByText("You're backstage")).toBeVisible();
    await expect(people.getByText("Present")).toBeVisible();

    await people.getByRole("button", { name: "Add Sam to stage" }).click();
    await expect(guest.getByText("You're on stage")).toBeVisible();
    // The program shows who is on stage: a picture-in-picture box, since the scene has no cameras.
    await expect(page.getByRole("region", { name: "Program preview" }).getByTestId("camera-tile")).toHaveCount(1);

    await people.getByRole("button", { name: "Revoke invite for Sam" }).click();
    await expect(guest.getByText("This invite is no longer valid")).toBeVisible();
  } finally {
    await guestContext.close();
  }
});

test("through the tunnel only a guest's routes answer", async ({ request }) => {
  const made = await (await request.post(`${API}/broadcasts`, { data: { title: `Gate test ${Date.now()}`, description: "", record: false } })).json();
  const doc = await (await request.post(`${API}/broadcasts/${made.current_id}/people/invites`, { data: { role: "speaker" } })).json();
  const secret = doc.invites[0].link.split("/").pop();
  const tunnel = { "x-forwarded-host": PUBLIC_HOST, "x-forwarded-for": "203.0.113.9" };
  expect((await request.get(`${WEB}/api/broadcasts`, { headers: tunnel })).status()).toBe(404);
  expect((await request.get(`${WEB}/api/studio`, { headers: tunnel })).status()).toBe(404);
  expect((await request.get(`${WEB}/api/guest/${secret}`, { headers: tunnel })).status()).toBe(200);
  expect((await request.get(`${WEB}/api/broadcasts`)).status()).toBe(200);
});
```

- [ ] **Step 3: Run the end-to-end suite**

In `apps/web`, PowerShell:

```powershell
foreach ($p in 8010,5183) { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force } }; pnpm e2e --reporter=line
```

Expected: every test passes, including the two new guests tests. If the tunnel test's last line (a local request through the dev server) returns 404, the dev server's proxy is adding a forwarding header. Set `xfwd: false` explicitly on the `/api` proxy in `vite.config.ts` and re-run. If one test times out once under load, re-run once before investigating.

- [ ] **Step 4: Write the Azure run**

Create `apps/web/playwright.acs.config.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { defineConfig } from "@playwright/test";
import base, { webServers } from "./playwright.config";

// The connection string stays in the .env file at the top of the project; it is passed to the test
// pipeline only, never printed.
const file = resolve(import.meta.dirname, "../../.env");
const fromFile = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
const connection = process.env.KICKSTREAM_ACS_CONNECTION_STRING ?? fromFile.KICKSTREAM_ACS_CONNECTION_STRING ?? "";

export default defineConfig({
  ...base,
  testDir: "e2e-acs",
  timeout: 240_000,
  metadata: { acs: connection !== "" },
  webServer: webServers({ KICKSTREAM_ROOMS: "", KICKSTREAM_ACS_CONNECTION_STRING: connection }),
});
```

Create `apps/web/e2e-acs/guests-acs.spec.ts`:

```ts
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openStudio } from "../e2e/broadcasts";

// The test pipeline; see playwright.config.ts.
const OUTPUT = "http://127.0.0.1:8010/api/studio/output";

/** The loudest the file's sound gets, in dB; null when ffmpeg is not installed. */
function loudest(path: string): number | null {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-i", path, "-vn", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  if ((run.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
  const found = /max_volume: (-?[\d.]+) dB/.exec(run.stderr ?? "");
  return found ? Number(found[1]) : -Infinity;
}

function find(file: string): string {
  const data = ".data-e2e";
  const found = readdirSync(data).map((run) => join(data, run, "recordings", file)).filter(existsSync);
  expect(found, `${file} should be in exactly one run's data directory`).toHaveLength(1);
  return found[0];
}

test("a guest's camera reaches the program and their voice reaches the recording", async ({ page, browser, request }) => {
  test.skip(!test.info().config.metadata.acs, "put KICKSTREAM_ACS_CONNECTION_STRING in the .env file to run against Azure");
  await openStudio(page, request, `ACS test ${Date.now()}`);
  const people = page.getByRole("region", { name: "People" });
  await people.getByLabel("Name (optional)").fill("Riley");
  await people.getByRole("button", { name: "Invite" }).click();
  const path = new URL(await people.getByLabel("Invite link for Riley").inputValue()).pathname;

  const guestContext = await browser.newContext({ permissions: ["camera", "microphone"] });
  try {
    const guest = await guestContext.newPage();
    await guest.goto(path);
    await guest.getByRole("button", { name: "Join" }).click();
    await expect(guest.getByText("You're backstage")).toBeVisible({ timeout: 60_000 });
    await expect(people.getByText("Present")).toBeVisible();
    await people.getByRole("button", { name: "Add Riley to stage" }).click();
    await expect(guest.getByText("You're on stage")).toBeVisible();

    const program = await page.context().newPage();
    await program.goto("/studio?output");
    await expect(program.getByTestId("camera-tile").locator("video")).toBeVisible({ timeout: 60_000 });
    await program.close();

    await page.getByLabel("Platform").selectOption("file");
    await page.getByRole("button", { name: "Add destination" }).click();
    await page.getByRole("button", { name: "Go live", exact: true }).click();
    const stream = page.getByRole("region", { name: "Stream", exact: true });
    await expect(stream.getByText("Live", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(guest.getByText("You're on stage — you're live")).toBeVisible();
    await page.waitForTimeout(10_000);
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(stream.getByText("Off air")).toBeVisible({ timeout: 15_000 });

    const doc = await (await request.get(OUTPUT)).json();
    const level = loudest(find(doc.recordings[0].file));
    test.info().annotations.push({ type: "ffmpeg", description: level === null ? "not installed: the sound was not checked" : `loudest ${level} dB` });
    if (level !== null) expect(level).toBeGreaterThan(-50);
  } finally {
    await request.post(`${OUTPUT}/stop`);
    const doc = await (await request.get(OUTPUT)).json();
    for (const item of doc.destinations) await request.delete(`${OUTPUT}/destinations/${item.id}`);
    await guestContext.close();
  }
});
```

In `apps/web/package.json` `scripts`, add `"e2e:acs": "playwright test --config playwright.acs.config.ts"`.

Run it without a connection string to check that it skips cleanly. In PowerShell, from `apps/web`:

```powershell
foreach ($p in 8010,5183) { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force } }; pnpm e2e:acs --reporter=line
```

Expected: 1 skipped, unless the user's `.env` has the string. In that case it runs against Azure: report the result, and never print the string.

- [ ] **Step 5: Document guests in the README**

In `README.md`:
- In the pages table, add a row: ``| `/guest/{secret}` | A guest's page, opened from an invite link: check the camera and microphone, give a name, and join |``.
- In the studio's pages table, extend the `/broadcasts/{id}/studio` description with ", and invite guests" at the end.
- Add a `## Guests` section after "Broadcasts and reels":

```markdown
## Guests

In a broadcast's studio, the **People** panel invites guests by link, as on StreamYard. Each invite has a role:

| Role | Camera and mic | On stage | Studio |
|---|---|---|---|
| Speaker | yes | when you put them there | no |
| Co-host | yes | when you put them there | can open it |
| Member | yes | never | no |

Copy the link and send it. The guest checks their camera and microphone, gives a name, and joins. You add up to four people to the stage, including yourself with **Join with camera** and **Add me to stage**. Who is on stage appears in the scene's **Cameras** element (the **Interview** template has one), or in a picture-in-picture box when the scene has none, and their voices are on the stream. While the broadcast is live, everyone backstage is muted. **Revoke** stops a link at once; ending or deleting the broadcast stops them all.

Calls go through Azure Communication Services Rooms. Create a Communication Services resource in the Azure portal, then put its connection string in a `.env` file at the top of the project (it is ignored by git):

    KICKSTREAM_ACS_CONNECTION_STRING=endpoint=https://<resource>.communication.azure.com/;accesskey=<key>

To try guests without Azure, set `KICKSTREAM_ROOMS=fake` instead: invites, the stage and the guest page work, but no one sees or hears anyone else.

Guests on other networks reach you through an HTTPS tunnel (Cloudflare Tunnel or ngrok) to the web server on port 5173; browsers allow cameras only on `https://` pages or `localhost`. Put the tunnel's hostname in `KICKSTREAM_PUBLIC_HOSTS` (in `.env` too). On that address only the guest routes answer, and a co-host's studio routes; everything else stays on your machine.

| Variable | Use |
|---|---|
| `KICKSTREAM_ACS_CONNECTION_STRING` | The Azure Communication Services resource guests' calls use |
| `KICKSTREAM_ROOMS` | `fake`: in-memory rooms, for trying guests without Azure |
| `KICKSTREAM_PUBLIC_HOSTS` | The tunnel's hostnames, comma-separated; invite links use the first |

| Endpoint | Use |
|---|---|
| `GET /api/broadcasts/{id}/people`, `/socket` | The broadcast's people: invites, who is present, the stage |
| `POST /api/broadcasts/{id}/people/invites` | `{role, name?}`: make an invite link |
| `DELETE /api/broadcasts/{id}/people/invites/{invite}` | Revoke it |
| `PUT /api/broadcasts/{id}/people/stage` | `{people}`: who is on stage, in order |
| `GET /api/guest/{secret}`, `/socket` | What a guest's page shows |
| `POST /api/guest/{secret}/join` | `{name}`: join the room |
```

- In the testing block, add `(cd apps/web && pnpm e2e:acs)           # guests over Azure; runs only with KICKSTREAM_ACS_CONNECTION_STRING in .env`, and change the `pnpm e2e` comment to "home, broadcasts and reels, studio, output, guests and match data, in a real browser".
- In the Layout table, add ``| `services/pipeline/kickstream/people/` | Invites, the stage and call rooms for guests |``.
- Change "Moving to Azure means adding adapters for the four ports" so that it lists the call rooms too, if the sentence names the ports.

- [ ] **Step 6: Run everything**

Run:
- `uv run pytest -q`, `uv run ruff check .` and `uv run ruff format --check .` in `services/pipeline`.
- `pnpm test` and `pnpm typecheck` in `apps/web`.
- The end-to-end command from Step 3.

Expected: all pass. `tests/test_output_browser.py` may fail only under load and must pass when run alone.

- [ ] **Step 7: Commit**

```powershell
git add apps/web/playwright.config.ts apps/web/playwright.acs.config.ts apps/web/package.json apps/web/e2e/guests.spec.ts apps/web/e2e-acs/guests-acs.spec.ts README.md
git commit -m "Test guests end to end with fake rooms, add the Azure run, and document guests"
```
