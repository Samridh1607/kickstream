import asyncio
import logging

from pydantic import BaseModel, ValidationError

from kickstream.ports.bus import BusMessage

log = logging.getLogger(__name__)
_CLOSED = object()


class _Subscription:
    def __init__(self, topics: tuple[str, ...], maxsize: int, on_close) -> None:
        self.topics = frozenset(topics)
        self.queue: asyncio.Queue = asyncio.Queue(maxsize)
        self.closed = False
        self._on_close = on_close

    def __aiter__(self):
        return self

    async def __anext__(self) -> BusMessage:
        if self.closed and self.queue.empty():
            raise StopAsyncIteration
        item = await self.queue.get()
        if item is _CLOSED:
            raise StopAsyncIteration
        return item

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self._on_close(self)
        while not self.queue.empty():
            self.queue.get_nowait()
        self.queue.put_nowait(_CLOSED)


class InMemoryEventBus:
    """Ordered, bounded, in-process pub/sub. Publishing waits when a subscriber is full."""

    def __init__(self) -> None:
        self._subscriptions: list[_Subscription] = []

    def subscribe(self, *topics: str, maxsize: int = 256) -> _Subscription:
        subscription = _Subscription(topics, maxsize, self._subscriptions.remove)
        self._subscriptions.append(subscription)
        return subscription

    async def publish(self, topic: str, match_id: str, payload: BaseModel) -> None:
        try:
            type(payload).model_validate(payload.model_dump(warnings=False))
        except ValidationError as exc:
            log.warning("dropped invalid %s on %s: %s", type(payload).__name__, topic, exc.errors()[0]["msg"])
            return
        message = BusMessage(topic, match_id, payload)
        for subscription in list(self._subscriptions):
            if topic in subscription.topics and not subscription.closed:
                await subscription.queue.put(message)
