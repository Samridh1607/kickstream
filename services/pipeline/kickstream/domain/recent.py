"""Per-match memory that a pipeline running for days must not let grow."""

from collections.abc import Hashable, MutableMapping

REMEMBERED_MATCHES = 4


def make_room(mapping: MutableMapping, key: Hashable, keep: int = REMEMBERED_MATCHES) -> None:
    """Before `key` is added, drop the oldest entries so that at most `keep` remain with it."""
    if key in mapping:
        return
    while mapping and len(mapping) >= keep:
        del mapping[next(iter(mapping))]
