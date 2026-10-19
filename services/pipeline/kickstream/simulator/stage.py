from kickstream.contracts import MatchEvent, MatchStatus, TeamSheet
from kickstream.ports.bus import EVENTS, STATUS, EventBus
from kickstream.ports.clock import Clock


class Scoreboard:
    """Publishes a match's events and keeps its status (score, state, minute) in step with them."""

    def __init__(
        self, bus: EventBus, match_id: str, home: TeamSheet, away: TeamSheet, speed: float, **about
    ) -> None:
        self._bus = bus
        self._match_id = match_id
        self._home = home
        self._away = away
        self._speed = speed
        self._about = about
        self._score = {"home": 0, "away": 0}
        self.status: MatchStatus | None = None

    async def publish_status(self, state: str, minute: int) -> None:
        self.status = MatchStatus(
            match_id=self._match_id,
            state=state,
            minute=minute,
            score_home=self._score["home"],
            score_away=self._score["away"],
            speed=self._speed,
            home=self._home,
            away=self._away,
            **self._about,
        )
        await self._bus.publish(STATUS, self._match_id, self.status)

    async def publish(self, event: MatchEvent) -> None:
        await self._bus.publish(EVENTS, self._match_id, event)
        if event.type == "goal" and event.team in self._score:
            self._score[event.team] += 1
            await self.publish_status("live", event.minute)
        elif event.type == "half_time":
            await self.publish_status("half_time", event.minute)
        elif event.type == "kickoff" and self.status is not None and self.status.state == "half_time":
            await self.publish_status("live", event.minute)
        elif event.type == "full_time":
            await self.publish_status("finished", event.minute)


class Simulator:
    """Releases a generated or replayed match onto the bus in match-time order."""

    def __init__(self, bus: EventBus, clock: Clock) -> None:
        self._bus = bus
        self._clock = clock
        self._board: Scoreboard | None = None

    @property
    def status(self) -> MatchStatus | None:
        return self._board.status if self._board is not None else None

    async def play(
        self,
        match_id: str,
        events: list[MatchEvent],
        home: TeamSheet,
        away: TeamSheet,
        speed: float,
        *,
        source: str = "simulated",
        detail: str = "full",
        credit: str | None = None,
        competition: str | None = None,
    ) -> None:
        board = self._board = Scoreboard(
            self._bus,
            match_id,
            home,
            away,
            speed,
            source=source,
            detail=detail,
            credit=credit,
            competition=competition,
        )
        await board.publish_status("live", 0)
        previous = 0.0
        for event in events:
            at = event.minute * 60 + event.second
            await self._clock.sleep(max(0.0, at - previous))
            previous = at
            await board.publish(event)
