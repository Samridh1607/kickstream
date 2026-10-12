from collections.abc import AsyncIterator
from typing import Protocol

from kickstream.ports.store import LogItem


class Feed(Protocol):
    def __aiter__(self) -> AsyncIterator[LogItem]: ...

    def close(self) -> None: ...


class Broadcaster(Protocol):
    def publish(self, item: LogItem) -> None: ...

    def subscribe(self, match_id: str, maxsize: int = 512) -> Feed: ...
