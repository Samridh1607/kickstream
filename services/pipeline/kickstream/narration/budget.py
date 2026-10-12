import time
from collections.abc import Callable


class Budget:
    """Bounds model calls per match. Goals and recaps (priority) are served first."""

    def __init__(
        self, max_calls: int, reserve: int, min_gap_s: float, now: Callable[[], float] = time.monotonic
    ) -> None:
        self._max_calls = max_calls
        self._reserve = reserve
        self._min_gap_s = min_gap_s
        self._now = now
        self._used: dict[str, int] = {}
        self._last: dict[str, float] = {}

    def try_spend(self, match_id: str, cost: int, priority: bool) -> bool:
        remaining = self._max_calls - self._used.get(match_id, 0)
        if cost > remaining:
            return False
        if not priority:
            if remaining - cost < self._reserve:
                return False
            last = self._last.get(match_id)
            if last is not None and self._now() - last < self._min_gap_s:
                return False
        self._used[match_id] = self._used.get(match_id, 0) + cost
        self._last[match_id] = self._now()
        return True
