import math
from collections import deque


class RateWindow:
    """Allows each key a number of actions within a sliding window.

    A fan's ID is chosen by their browser, so a limit per ID stops nothing deliberate. This one
    is keyed by network address, which a single machine cannot rotate.
    """

    def __init__(self, limit: int, window_s: float) -> None:
        self._limit = limit
        self._window_s = window_s
        self._seen: dict[str, deque[float]] = {}

    def take(self, key: str, now: float) -> int | None:
        """Use one of the key's actions. Returns None when allowed, else the seconds to wait."""
        self._forget(now)
        times = self._seen.setdefault(key, deque())
        if len(times) >= self._limit:
            return max(1, math.ceil(times[0] + self._window_s - now))
        times.append(now)
        return None

    def give_back(self, key: str) -> None:
        """Undo the last `take`, for an action that was then refused for another reason."""
        times = self._seen.get(key)
        if times:
            times.pop()

    def _forget(self, now: float) -> None:
        for key in list(self._seen):
            times = self._seen[key]
            while times and now - times[0] >= self._window_s:
                times.popleft()
            if not times:
                del self._seen[key]
