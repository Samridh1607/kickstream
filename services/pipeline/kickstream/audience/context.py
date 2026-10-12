from kickstream.contracts import KeyMoment, MatchStatus, Narrative, StatsSnapshot
from kickstream.ports.expert import MatchContext


class MatchTracker:
    """Keeps what the expert may draw on for the match being played, from bus messages."""

    def __init__(self) -> None:
        self._status: MatchStatus | None = None
        self._stats: StatsSnapshot | None = None
        self._moments: dict[str, KeyMoment] = {}
        self._narratives: dict[str, str] = {}

    def observe(self, match_id: str, payload) -> None:
        current = self._status.match_id if self._status is not None else None
        if isinstance(payload, MatchStatus):
            if match_id != current:
                if payload.state == "abandoned":
                    return
                self._stats, self._moments, self._narratives = None, {}, {}
            self._status = payload
        elif match_id != current:
            return  # a straggler from a match that has been replaced
        elif isinstance(payload, StatsSnapshot):
            self._stats = payload
        elif isinstance(payload, KeyMoment):
            self._moments[payload.id] = payload
        elif isinstance(payload, Narrative) and (payload.mode, payload.language) == ("analyst", "en"):
            # The analyst's English text is the most factual account of a moment.
            self._narratives[payload.moment_id] = payload.text

    def context(self) -> MatchContext | None:
        if self._status is None:
            return None
        moments = tuple((moment, self._narratives.get(moment.id)) for moment in self._moments.values())
        return MatchContext(home=self._status.home, away=self._status.away, status=self._status, stats=self._stats,
                            moments=moments)

    def teams(self) -> tuple[str, str] | None:
        return None if self._status is None else (self._status.home.name, self._status.away.name)
