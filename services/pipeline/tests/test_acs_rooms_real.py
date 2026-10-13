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
        await rooms.unseat(room_id, seat.user_id)
    finally:
        await rooms.close_room(room_id)
