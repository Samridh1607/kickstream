from kickstream.contracts import MatchEvent, MatchStatus, TeamSheet
from kickstream.ports.bus import EVENTS, STATUS, EventBus
from kickstream.ports.clock import Clock


class Simulator:
    """Releases a generated match onto the bus in match-time order."""

    def __init__(self, bus: EventBus, clock: Clock) -> None:
        self._bus = bus
        self._clock = clock
        self.status: MatchStatus | None = None

    async def play(
        self, match_id: str, events: list[MatchEvent], home: TeamSheet, away: TeamSheet, speed: float
    ) -> None:
        score = {"home": 0, "away": 0}

        async def publish_status(state: str, minute: int) -> None:
            self.status = MatchStatus(
                match_id=match_id,
                state=state,
                minute=minute,
                score_home=score["home"],
                score_away=score["away"],
                speed=speed,
                home=home,
                away=away,
            )
            await self._bus.publish(STATUS, match_id, self.status)

        await publish_status("live", 0)
        previous = 0.0
        for event in events:
            at = event.minute * 60 + event.second
            await self._clock.sleep(at - previous)
            previous = at
            await self._bus.publish(EVENTS, match_id, event)
            if event.type == "goal":
                score[event.team] += 1
                await publish_status("live", event.minute)
            elif event.type == "half_time":
                await publish_status("half_time", event.minute)
            elif event.type == "kickoff" and self.status.state == "half_time":
                await publish_status("live", event.minute)
            elif event.type == "full_time":
                await publish_status("finished", event.minute)
