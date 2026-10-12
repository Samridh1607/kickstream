"""Composition root. The only module that names concrete adapters."""

import asyncio
import os
import secrets
from collections.abc import Callable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI

from kickstream.adapters.agent_writer import AgentNarrativeWriter
from kickstream.adapters.clocks import RealClock
from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.adapters.memory_store import InMemoryMatchStore
from kickstream.adapters.scripted_writer import ScriptedNarrativeWriter
from kickstream.adapters.sse_broadcaster import InProcessBroadcaster
from kickstream.analytics.stage import AnalyticsStage
from kickstream.control import MatchController
from kickstream.domain.teams import AWAY, HOME
from kickstream.gateway.api import build_router
from kickstream.gateway.recorder import Recorder
from kickstream.narration.budget import Budget
from kickstream.narration.cache import DiskCache
from kickstream.narration.service import NarrationService
from kickstream.narration.stage import NarrationStage
from kickstream.overlay.stage import OverlayStage
from kickstream.ports.clock import Clock
from kickstream.ports.writer import NarrativeWriter


@dataclass(frozen=True)
class Settings:
    llm_base_url: str | None
    llm_model: str | None
    llm_api_key: str | None
    llm_max_calls: int = 60  # per match; a key moment costs 3 calls, a recap 2
    llm_reserve: int = 15  # kept back for goals and recaps
    llm_min_gap_s: float = 2.0  # between non-priority model calls
    cache_dir: Path = Path(".cache/narration")

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "Settings":
        return cls(
            llm_base_url=env.get("KICKSTREAM_LLM_BASE_URL") or None,
            llm_model=env.get("KICKSTREAM_LLM_MODEL") or None,
            llm_api_key=env.get("KICKSTREAM_LLM_API_KEY") or None,
            llm_max_calls=int(env.get("KICKSTREAM_LLM_MAX_CALLS", "60")),
            cache_dir=Path(env.get("KICKSTREAM_CACHE_DIR", ".cache/narration")),
        )

    @property
    def llm_configured(self) -> bool:
        return bool(self.llm_base_url and self.llm_model and self.llm_api_key)


@dataclass
class Pipeline:
    bus: InMemoryEventBus
    store: InMemoryMatchStore
    broadcaster: InProcessBroadcaster
    controller: MatchController
    stages: list
    tasks: list[asyncio.Task] = field(default_factory=list)

    def start(self) -> None:
        self.tasks = [asyncio.create_task(stage.run()) for stage in self.stages]

    async def stop(self) -> None:
        await self.controller.stop()
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.tasks = []


def build_pipeline(
    settings: Settings,
    *,
    clock_factory: Callable[[float], Clock] = RealClock,
    writer: NarrativeWriter | None = None,
    match_prefix: str = "m",
) -> Pipeline:
    bus, store, broadcaster = InMemoryEventBus(), InMemoryMatchStore(), InProcessBroadcaster()
    primary = writer
    if primary is None and settings.llm_configured:
        primary = AgentNarrativeWriter(settings.llm_base_url, settings.llm_model, settings.llm_api_key)
    service = NarrationService(
        ScriptedNarrativeWriter(),
        primary,
        budget=Budget(settings.llm_max_calls, settings.llm_reserve, settings.llm_min_gap_s),
        cache=DiskCache(settings.cache_dir) if primary is not None else None,
    )
    # Every stage subscribes in its constructor, so nothing published after this point is missed.
    stages = [
        AnalyticsStage(bus),
        NarrationStage(bus, service),
        OverlayStage(bus),
        Recorder(bus, store, broadcaster),
    ]
    return Pipeline(
        bus, store, broadcaster, MatchController(bus, clock_factory, HOME, AWAY, prefix=match_prefix), stages
    )


def create_app(
    settings: Settings | None = None,
    *,
    clock_factory: Callable[[float], Clock] = RealClock,
    writer: NarrativeWriter | None = None,
    match_prefix: str | None = None,
) -> FastAPI:
    # Match IDs are unique to this process, so an ID a browser kept from before a restart is
    # reported as unknown instead of silently naming a different match.
    pipeline = build_pipeline(
        settings or Settings.from_env(),
        clock_factory=clock_factory,
        writer=writer,
        match_prefix=match_prefix or f"m{secrets.token_hex(3)}",
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        pipeline.start()
        yield
        await pipeline.stop()

    app = FastAPI(title="Kickstream", lifespan=lifespan)
    app.state.pipeline = pipeline
    app.include_router(
        build_router(
            store=pipeline.store,
            broadcaster=pipeline.broadcaster,
            teams=(HOME, AWAY),
            start_match=pipeline.controller.start,
            current_match=lambda: pipeline.controller.current,
            match_exists=pipeline.controller.exists,
        )
    )
    return app
