from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol

from pydantic import BaseModel

EVENTS = "events"
INSIGHTS = "insights"
NARRATIVES = "narratives"
OVERLAYS = "overlays"
STATUS = "status"
AGENTS = "agents"


@dataclass(frozen=True)
class BusMessage:
    topic: str
    match_id: str
    payload: BaseModel


class Subscription(Protocol):
    def __aiter__(self) -> AsyncIterator[BusMessage]: ...

    def close(self) -> None: ...


class EventBus(Protocol):
    async def publish(self, topic: str, match_id: str, payload: BaseModel) -> None: ...

    def subscribe(self, *topics: str, maxsize: int = 256) -> Subscription: ...
