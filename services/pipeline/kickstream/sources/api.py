from collections.abc import Callable, Mapping
from datetime import date
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query

from kickstream.contracts import Competition, Fixture, MatchListing, RunningMatch, SourceInfo, Sources
from kickstream.domain.errors import Refusal
from kickstream.ports.match_source import LiveSource, ReplaySource, SourceFailure, SourceUnavailable

SIMULATED = SourceInfo(
    id="simulated", name="Simulated match", kind="simulated", detail="full", available=True
)


class SourceRefusal(Refusal):
    """A source could not answer. 409 when it is unavailable as configured, 502 when it failed."""

    def __init__(self, failure: SourceFailure) -> None:
        status = 409 if isinstance(failure, SourceUnavailable) else 502
        super().__init__(status, "source", failure.message)


def _replay_info(source: ReplaySource) -> SourceInfo:
    return SourceInfo(
        id=source.id, name=source.name, kind="replay", detail="full", available=True, credit=source.credit
    )


def _live_info(source: LiveSource) -> SourceInfo:
    used, limit = source.budget() or (None, None)
    return SourceInfo(
        id=source.id,
        name=source.name,
        kind="live",
        detail="key_events",
        available=source.available,
        credit=source.credit,
        setup=source.setup,
        budget_used=used,
        budget_limit=limit,
    )


def build_sources_router(
    *,
    replays: Mapping[str, ReplaySource],
    live: Mapping[str, LiveSource],
    running: Callable[[], RunningMatch | None],
    today: Callable[[], date] = date.today,
) -> APIRouter:
    router = APIRouter(prefix="/api/sources")

    def replay_source(source: str) -> ReplaySource:
        if source not in replays:
            raise HTTPException(status_code=404, detail=f"no replay source {source}")
        return replays[source]

    @router.get("")
    async def get_sources() -> Sources:
        listed = [SIMULATED, *map(_replay_info, replays.values()), *map(_live_info, live.values())]
        return Sources(sources=listed, running=running())

    @router.get("/{source}/competitions")
    async def get_competitions(source: str) -> list[Competition]:
        try:
            return await replay_source(source).competitions()
        except SourceFailure as exc:
            raise SourceRefusal(exc) from exc

    @router.get("/{source}/competitions/{competition_id}/{season_id}/matches")
    async def get_matches(source: str, competition_id: int, season_id: int) -> list[MatchListing]:
        try:
            return await replay_source(source).matches(competition_id, season_id)
        except SourceFailure as exc:
            raise SourceRefusal(exc) from exc

    @router.get("/{source}/fixtures")
    async def get_fixtures(
        source: str, day: Annotated[date | None, Query(alias="date")] = None
    ) -> list[Fixture]:
        if source not in live:
            raise HTTPException(status_code=404, detail=f"no live source {source}")
        try:
            return await live[source].fixtures(day or today())
        except SourceFailure as exc:
            raise SourceRefusal(exc) from exc

    return router
