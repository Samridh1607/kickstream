"""Composition root. The only module that names concrete adapters."""

import asyncio
import os
import secrets
import time
from collections.abc import Callable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from kickstream.adapters.agent_reels import AgentReelProducer
from kickstream.adapters.agent_writer import AgentNarrativeWriter
from kickstream.adapters.chromium_capture import ChromiumCapture
from kickstream.adapters.clocks import RealClock
from kickstream.adapters.dir_image_store import DirImageStore
from kickstream.adapters.ffmpeg import FfmpegEncoder, FfmpegSender
from kickstream.adapters.ffmpeg_clips import FfmpegClipCutter
from kickstream.adapters.json_record_store import JsonRecordStore
from kickstream.adapters.json_studio_store import JsonStudioStore
from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.adapters.memory_store import InMemoryMatchStore
from kickstream.adapters.scripted_reels import ScriptedReelProducer
from kickstream.adapters.scripted_writer import ScriptedNarrativeWriter
from kickstream.adapters.sse_broadcaster import InProcessBroadcaster
from kickstream.analytics.stage import AnalyticsStage
from kickstream.broadcasts.api import build_broadcasts_router
from kickstream.broadcasts.service import BroadcastService
from kickstream.broadcasts.stage import BroadcastStage
from kickstream.control import MatchController
from kickstream.domain.demo import DEMO_SEED
from kickstream.domain.errors import Refusal
from kickstream.domain.teams import AWAY, HOME
from kickstream.gateway.api import build_router
from kickstream.gateway.recorder import Recorder
from kickstream.narration.budget import Budget
from kickstream.narration.cache import DiskCache
from kickstream.narration.service import NarrationService
from kickstream.narration.stage import NarrationStage
from kickstream.output.api import build_output_router
from kickstream.output.service import OutputService
from kickstream.overlay.stage import OverlayStage
from kickstream.ports.clock import Clock
from kickstream.ports.output import Encoder, ProgramCapture, Sender
from kickstream.ports.reels import ClipCutter, ReelProducer
from kickstream.ports.writer import NarrativeWriter
from kickstream.studio.api import build_studio_router, find_moment
from kickstream.studio.rules import sanitize_raw
from kickstream.studio.service import StudioService
from kickstream.studio.stage import StudioStage

STUDIO_MATCH_SPEED = 30.0  # playback speed of a match the studio starts at the end of a countdown
_READ_ONLY_METHODS = {"GET", "HEAD", "OPTIONS"}


class SameOriginWrites:
    """Refuses a changing request that a browser sent on behalf of another web site.

    Kickstream has no sign-in, and browsers let any page send a simple POST to a local port.
    Without this, a page open in the streamer's browser could switch scenes or start matches.
    Tools like curl send neither header and are let through.
    """

    def __init__(self, app) -> None:
        self._app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "http" and scope["method"] not in _READ_ONLY_METHODS:
            if self._from_another_site(dict(scope["headers"])):
                detail = "Requests from other sites cannot change Kickstream."
                await JSONResponse(status_code=403, content={"detail": detail})(scope, receive, send)
                return
        await self._app(scope, receive, send)

    @staticmethod
    def _from_another_site(headers: dict[bytes, bytes]) -> bool:
        # Browsers state the relationship themselves, and a page cannot forge this header.
        # It also survives a proxy, where Host no longer matches the page's origin.
        relation = headers.get(b"sec-fetch-site")
        if relation is not None:
            return relation == b"cross-site"
        # Older browsers: fall back to comparing the page's origin with the host it called.
        origin = headers.get(b"origin")
        if origin is None:
            return False
        return urlsplit(origin.decode("latin-1")).netloc != headers.get(b"host", b"").decode("latin-1")


MAX_BODY_BYTES = 3 * 1024 * 1024  # above the 2 MB image limit, with room for its framing


class BodyLimit:
    """Refuses a request body over the limit without taking it into memory.

    Nothing here needs a large body, and with no sign-in anyone who can reach the port could
    otherwise make the server buffer as much as they care to send.
    """

    def __init__(self, app) -> None:
        self._app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        declared = dict(scope["headers"]).get(b"content-length", b"")
        if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            await self._refuse(scope, receive, send)
            return
        received = 0
        too_large = False

        async def counted():
            nonlocal received, too_large
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > MAX_BODY_BYTES:
                    too_large = True
                    # Tell the application the client went away, so it stops reading.
                    return {"type": "http.disconnect"}
            return message

        answered = False

        async def guarded(message):
            nonlocal answered
            if too_large and not answered:
                answered = True
                await self._refuse(scope, receive, send)
            elif not too_large:
                await send(message)

        try:
            await self._app(scope, counted, guarded)
        except Exception:
            # Cutting the body short makes some handlers fail mid-read. That is this limit at
            # work, not a fault; anything else is re-raised.
            if not too_large:
                raise
        if too_large and not answered:
            await self._refuse(scope, receive, send)

    @staticmethod
    async def _refuse(scope, receive, send) -> None:
        refusal = JSONResponse(status_code=413, content={"detail": "The request is too large."})
        await refusal(scope, receive, send)


@dataclass(frozen=True)
class Settings:
    llm_base_url: str | None
    llm_model: str | None
    llm_api_key: str | None
    llm_max_calls: int = 60  # per match; a key moment costs 3 calls, a recap 2
    llm_reserve: int = 15  # kept back for goals and recaps
    llm_min_gap_s: float = 2.0  # between non-priority model calls
    cache_dir: Path = Path(".cache/narration")
    data_dir: Path = Path(".data")  # the studio document and uploaded images
    # Public hostnames pages are served from, when a reverse proxy rewrites Host. See domain/sockets.py.
    allowed_hosts: tuple[str, ...] = ()
    program_url: str = (
        "http://127.0.0.1:5173/studio?output"  # where the hidden browser finds the program picture
    )
    browser: str | None = None  # a Chromium-based browser; Microsoft Edge is looked for when unset
    ffmpeg: str = "ffmpeg"

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "Settings":
        return cls(
            llm_base_url=env.get("KICKSTREAM_LLM_BASE_URL") or None,
            llm_model=env.get("KICKSTREAM_LLM_MODEL") or None,
            llm_api_key=env.get("KICKSTREAM_LLM_API_KEY") or None,
            llm_max_calls=int(env.get("KICKSTREAM_LLM_MAX_CALLS", "60")),
            cache_dir=Path(env.get("KICKSTREAM_CACHE_DIR", ".cache/narration")),
            data_dir=Path(env.get("KICKSTREAM_DATA_DIR", ".data")),
            allowed_hosts=tuple(
                host.strip().lower()
                for host in env.get("KICKSTREAM_ALLOWED_HOSTS", "").split(",")
                if host.strip()
            ),
            program_url=env.get("KICKSTREAM_PROGRAM_URL") or "http://127.0.0.1:5173/studio?output",
            browser=env.get("KICKSTREAM_BROWSER") or None,
            ffmpeg=env.get("KICKSTREAM_FFMPEG") or "ffmpeg",
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
    studio: StudioService
    output: OutputService
    broadcasts: BroadcastService
    stages: list
    tasks: list[asyncio.Task] = field(default_factory=list)

    def start(self) -> None:
        self.tasks = [asyncio.create_task(stage.run()) for stage in self.stages]
        self.tasks.append(asyncio.create_task(self.studio.run()))
        self.tasks.append(asyncio.create_task(self.broadcasts.run()))

    async def stop(self) -> None:
        await self.broadcasts.stop()
        await self.output.stop()
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
    now: Callable[[], float] = time.time,
    capture: ProgramCapture | None = None,
    encoder: Encoder | None = None,
    new_sender: Callable[[], Sender] | None = None,
    reel_producer: ReelProducer | None = None,
    cutter: ClipCutter | None = None,
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
    controller = MatchController(bus, clock_factory, HOME, AWAY, prefix=match_prefix)
    studio = StudioService(
        JsonStudioStore(settings.data_dir / "studio.json", sanitize=sanitize_raw),
        DirImageStore(settings.data_dir / "images"),
        now=now,
        start_match=lambda: controller.start(DEMO_SEED, STUDIO_MATCH_SPEED),
        find_moment=lambda match_id, moment_id: find_moment(store, match_id, moment_id),
    )
    output = OutputService(
        JsonRecordStore(settings.data_dir / "output.json"),
        JsonRecordStore(settings.data_dir / "output-keys.json", private=True),
        capture=capture or ChromiumCapture(settings.browser),
        encoder=encoder or FfmpegEncoder(settings.ffmpeg),
        new_sender=new_sender or (lambda: FfmpegSender(settings.ffmpeg)),
        program_url=settings.program_url,
        recordings_dir=settings.data_dir / "recordings",
        now=now,
    )
    if reel_producer is None and settings.llm_configured:
        reel_producer = AgentReelProducer(settings.llm_base_url, settings.llm_model, settings.llm_api_key)
    broadcasts = BroadcastService(
        JsonRecordStore(settings.data_dir / "broadcasts.json"),
        output=output,
        producer=reel_producer,
        fallback=ScriptedReelProducer(),
        cutter=cutter or FfmpegClipCutter(settings.ffmpeg),
        recordings_dir=settings.data_dir / "recordings",
        reels_dir=settings.data_dir / "reels",
        now=now,
    )
    # Every stage subscribes in its constructor, so nothing published after this point is missed.
    stages = [
        AnalyticsStage(bus),
        NarrationStage(bus, service),
        OverlayStage(bus),
        Recorder(bus, store, broadcaster),
        StudioStage(bus, studio),
        BroadcastStage(bus, broadcasts),
    ]
    return Pipeline(bus, store, broadcaster, controller, studio, output, broadcasts, stages)


def create_app(
    settings: Settings | None = None,
    *,
    clock_factory: Callable[[float], Clock] = RealClock,
    writer: NarrativeWriter | None = None,
    match_prefix: str | None = None,
    now: Callable[[], float] = time.time,
    capture: ProgramCapture | None = None,
    encoder: Encoder | None = None,
    new_sender: Callable[[], Sender] | None = None,
    reel_producer: ReelProducer | None = None,
    cutter: ClipCutter | None = None,
) -> FastAPI:
    # Match IDs are unique to this process, so an ID a browser kept from before a restart is
    # reported as unknown instead of silently naming a different match.
    settings = settings or Settings.from_env()
    pipeline = build_pipeline(
        settings,
        clock_factory=clock_factory,
        writer=writer,
        match_prefix=match_prefix or f"m{secrets.token_hex(3)}",
        now=now,
        capture=capture,
        encoder=encoder,
        new_sender=new_sender,
        reel_producer=reel_producer,
        cutter=cutter,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        pipeline.start()
        yield
        await pipeline.stop()

    app = FastAPI(title="Kickstream", lifespan=lifespan)
    app.state.pipeline = pipeline
    app.add_middleware(SameOriginWrites)
    app.add_middleware(BodyLimit)

    @app.exception_handler(Refusal)
    async def refused(_: Request, exc: Refusal) -> JSONResponse:
        # The same shape FastAPI uses for its own validation errors, so clients read one format.
        detail = [{"loc": ["body", exc.field], "msg": exc.message, "type": "refusal"}]
        headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after is not None else None
        return JSONResponse(status_code=exc.status, content={"detail": detail}, headers=headers)

    app.include_router(
        build_router(
            store=pipeline.store,
            broadcaster=pipeline.broadcaster,
            teams=(HOME, AWAY),
            start_match=pipeline.controller.start,
            current_match=lambda: pipeline.controller.current,
            match_exists=pipeline.controller.exists,
            socket_hosts=settings.allowed_hosts,
        )
    )
    app.include_router(
        build_studio_router(
            service=pipeline.studio, store=pipeline.store, socket_hosts=settings.allowed_hosts
        )
    )
    app.include_router(build_output_router(service=pipeline.output, socket_hosts=settings.allowed_hosts))
    app.include_router(
        build_broadcasts_router(service=pipeline.broadcasts, socket_hosts=settings.allowed_hosts)
    )
    return app
