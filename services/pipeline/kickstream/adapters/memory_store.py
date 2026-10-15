from pydantic import BaseModel

from kickstream.domain.recent import make_room
from kickstream.ports.store import LogItem


class InMemoryMatchStore:
    """The logs of the newest matches. An older match is forgotten, so a pipeline running for days stays bounded."""

    def __init__(self, remembered: int = 6) -> None:
        self._logs: dict[str, list[LogItem]] = {}
        self._remembered = remembered

    def append(
        self,
        match_id: str,
        type: str,
        minute: int,
        payload: BaseModel,
        *,
        language: str | None = None,
        mode: str | None = None,
        team_id: str | None = None,
        player_id: str | None = None,
    ) -> LogItem:
        make_room(self._logs, match_id, self._remembered)
        log = self._logs.setdefault(match_id, [])
        item = LogItem(
            id=len(log) + 1,
            match_id=match_id,
            type=type,
            minute=minute,
            payload=payload,
            language=language,
            mode=mode,
            team_id=team_id,
            player_id=player_id,
        )
        log.append(item)
        return item

    def read(self, match_id: str, after_id: int = 0) -> list[LogItem]:
        return self._logs.get(match_id, [])[max(0, after_id) :]

    def has(self, match_id: str) -> bool:
        return match_id in self._logs
