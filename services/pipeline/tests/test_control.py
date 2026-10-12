import asyncio

from kickstream.adapters.clocks import InstantClock
from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.control import MatchController
from kickstream.domain.teams import AWAY, HOME
from kickstream.ports.bus import STATUS


class StuckClock:
    """Lets the first status out, then never advances."""

    async def sleep(self, match_seconds):
        if match_seconds > 0:
            await asyncio.Event().wait()


def controller(clock_type):
    bus = InMemoryEventBus()
    statuses = bus.subscribe(STATUS, maxsize=5000)
    bus.subscribe("events", maxsize=5000)
    return MatchController(bus, lambda speed: clock_type(), HOME, AWAY), statuses


def drain(subscription):
    out = []
    while not subscription.queue.empty():
        out.append(subscription.queue.get_nowait().payload)
    return out


async def test_matches_get_sequential_ids_and_the_latest_is_current():
    control, _ = controller(InstantClock)
    assert control.current is None and not control.exists("m-1")
    first = await control.start(11, 30)
    assert (first, control.current) == ("m-1", "m-1") and control.exists("m-1")
    second = await control.start(12, 30)
    assert (second, control.current) == ("m-2", "m-2")
    assert control.exists("m-1") and control.exists("m-2") and not control.exists("m-3")
    await control.stop()


async def test_replacing_a_running_match_tells_its_viewers_it_was_abandoned():
    control, statuses = controller(StuckClock)
    await control.start(11, 30)
    await asyncio.sleep(0.05)
    await control.start(11, 30)
    await asyncio.sleep(0.05)
    seen = [(s.match_id, s.state) for s in drain(statuses)]
    assert seen == [("m-1", "live"), ("m-1", "abandoned"), ("m-2", "live")]
    await control.stop()


async def test_the_new_match_is_current_by_the_time_viewers_hear_of_the_abandonment():
    control, statuses = controller(StuckClock)
    await control.start(11, 30)
    await asyncio.sleep(0.05)
    current_when_heard = []
    original = control._bus.publish

    async def spy(topic, match_id, payload):
        if getattr(payload, "state", None) == "abandoned":
            current_when_heard.append(control.current)
        await original(topic, match_id, payload)

    control._bus.publish = spy
    await control.start(11, 30)
    assert current_when_heard == ["m-2"]
    await control.stop()


async def test_a_finished_match_is_not_marked_abandoned():
    control, statuses = controller(InstantClock)
    await control.start(11, 30)
    await asyncio.wait_for(control.wait(), 20)
    await control.start(11, 30)
    await asyncio.wait_for(control.wait(), 20)
    states = [(s.match_id, s.state) for s in drain(statuses)]
    assert ("m-1", "finished") in states and ("m-1", "abandoned") not in states
    await control.stop()


async def test_stop_is_safe_to_call_with_nothing_running():
    control, _ = controller(InstantClock)
    await control.stop()
    await control.wait()
