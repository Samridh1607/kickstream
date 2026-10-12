import asyncio
import logging

from kickstream.adapters.clocks import InstantClock, RealClock
from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.adapters.memory_store import InMemoryMatchStore
from kickstream.adapters.sse_broadcaster import InProcessBroadcaster
from kickstream.ports.bus import EVENTS, INSIGHTS

from tests.factories import MATCH, event


async def _take(subscription, count):
    received = []
    async for message in subscription:
        received.append(message)
        if len(received) == count:
            break
    return received


async def test_bus_delivers_in_order_only_to_matching_topics():
    bus = InMemoryEventBus()
    events = bus.subscribe(EVENTS)
    both = bus.subscribe(EVENTS, INSIGHTS)
    await bus.publish(EVENTS, MATCH, event(1, "kickoff"))
    await bus.publish(INSIGHTS, MATCH, event(2, "pass"))
    await bus.publish(EVENTS, MATCH, event(3, "pass"))
    assert [m.payload.seq for m in await _take(events, 2)] == [1, 3]
    assert [(m.topic, m.payload.seq) for m in await _take(both, 3)] == [(EVENTS, 1), (INSIGHTS, 2), (EVENTS, 3)]


async def test_bus_drops_and_logs_invalid_payloads(caplog):
    bus = InMemoryEventBus()
    subscription = bus.subscribe(EVENTS)
    broken = event(1, "pass").model_copy(update={"minute": "soon"})
    with caplog.at_level(logging.WARNING):
        await bus.publish(EVENTS, MATCH, broken)
    await bus.publish(EVENTS, MATCH, event(2, "pass"))
    assert [m.payload.seq for m in await _take(subscription, 1)] == [2]
    assert "dropped invalid MatchEvent on events" in caplog.text


async def test_bus_applies_backpressure_when_a_subscriber_is_full():
    bus = InMemoryEventBus()
    subscription = bus.subscribe(EVENTS, maxsize=1)
    await bus.publish(EVENTS, MATCH, event(1, "pass"))
    blocked = asyncio.create_task(bus.publish(EVENTS, MATCH, event(2, "pass")))
    await asyncio.sleep(0.01)
    assert not blocked.done()
    await _take(subscription, 1)
    await asyncio.wait_for(blocked, 1)


async def test_closed_subscription_ends_iteration_and_stops_receiving():
    bus = InMemoryEventBus()
    subscription = bus.subscribe(EVENTS)
    subscription.close()
    assert [m async for m in subscription] == []
    await asyncio.wait_for(bus.publish(EVENTS, MATCH, event(1, "pass")), 1)


def test_store_assigns_increasing_ids_per_match_and_reads_after_an_id():
    store = InMemoryMatchStore()
    assert not store.has(MATCH)
    first = store.append(MATCH, "match_event", 0, event(1, "kickoff"))
    second = store.append(MATCH, "match_event", 1, event(2, "pass"), team_id="nbr", player_id="nbr-9")
    other = store.append("m-2", "match_event", 0, event(1, "kickoff"))
    assert (first.id, second.id, other.id) == (1, 2, 1)
    assert store.has(MATCH)
    assert [item.id for item in store.read(MATCH)] == [1, 2]
    assert [item.id for item in store.read(MATCH, after_id=1)] == [2]
    assert store.read("unknown") == []
    assert second.team_id == "nbr" and second.player_id == "nbr-9"


async def test_broadcaster_fans_out_per_match():
    store, broadcaster = InMemoryMatchStore(), InProcessBroadcaster()
    one, two, elsewhere = broadcaster.subscribe(MATCH), broadcaster.subscribe(MATCH), broadcaster.subscribe("m-2")
    item = store.append(MATCH, "match_event", 0, event(1, "kickoff"))
    broadcaster.publish(item)
    assert (await anext(aiter(one))).id == 1
    assert (await anext(aiter(two))).id == 1
    assert elsewhere.queue.empty()


async def test_broadcaster_ends_a_feed_that_cannot_keep_up():
    store, broadcaster = InMemoryMatchStore(), InProcessBroadcaster()
    slow = broadcaster.subscribe(MATCH, maxsize=2)
    for seq in range(1, 4):
        broadcaster.publish(store.append(MATCH, "match_event", 0, event(seq, "pass")))
    assert [item async for item in slow] == []
    broadcaster.publish(store.append(MATCH, "match_event", 0, event(4, "pass")))


async def test_closing_a_feed_unsubscribes_it():
    store, broadcaster = InMemoryMatchStore(), InProcessBroadcaster()
    feed = broadcaster.subscribe(MATCH)
    feed.close()
    broadcaster.publish(store.append(MATCH, "match_event", 0, event(1, "pass")))
    assert [item async for item in feed] == []


async def test_real_clock_divides_match_time_by_speed(monkeypatch):
    slept = []

    async def fake_sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(asyncio, "sleep", fake_sleep)
    await RealClock(30).sleep(60)
    await RealClock(30).sleep(0)
    assert slept == [2.0]


async def test_instant_clock_yields_without_waiting():
    await asyncio.wait_for(InstantClock().sleep(5400), 0.5)
