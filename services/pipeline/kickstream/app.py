"""Composition root. The only module that names concrete adapters."""

import asyncio
import os
import secrets
import time
from collections.abc import Callable, Collection, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.requests import cookie_parser

from kickstream.adapters.acs_rooms import AcsRooms
from kickstream.adapters.agent_copilot import AgentCopilotWriter
from kickstream.adapters.agent_explainer import AgentExplainer
from kickstream.adapters.agent_reels import AgentReelProducer
from kickstream.adapters.agent_writer import AgentNarrativeWriter
from kickstream.adapters.api_football import API_FOOTBALL, ApiFootball, DailyBudget
from kickstream.adapters.chromium_capture import ChromiumCapture
from kickstream.adapters.clocks import RealClock
from kickstream.adapters.demo_feed import DemoFeed
from kickstream.adapters.dir_image_store import DirImageStore
from kickstream.adapters.fake_rooms import FakeRooms
from kickstream.adapters.ffmpeg import FfmpegEncoder, FfmpegSender
from kickstream.adapters.ffmpeg_clips import FfmpegClipCutter
from kickstream.adapters.json_record_store import JsonRecordStore
from kickstream.adapters.json_studio_store import JsonStudioStore
from kickstream.adapters.memory_bus import InMemoryEventBus
from kickstream.adapters.memory_store import InMemoryMatchStore
from kickstream.adapters.openligadb import OPENLIGADB, OpenLigaDb
from kickstream.adapters.scripted_explainer import ScriptedExplainer
from kickstream.adapters.scripted_reels import ScriptedReelProducer
from kickstream.adapters.scripted_writer import ScriptedNarrativeWriter
from kickstream.adapters.sse_broadcaster import InProcessBroadcaster
from kickstream.adapters.statsbomb import OPEN_DATA, StatsBombOpenData
from kickstream.adapters.web_search import TavilySearch, WikipediaSearch
from kickstream.adapters.x_feed import XRecentSearch
from kickstream.agents.api import build_agents_router
from kickstream.agents.explain import ExplainService
from kickstream.agents.registry import AgentSwitches
from kickstream.agents.stage import AgentsStage
from kickstream.analytics.stage import AnalyticsStage
from kickstream.broadcasts.api import build_broadcasts_router
from kickstream.broadcasts.service import BroadcastService
from kickstream.broadcasts.stage import BroadcastStage
from kickstream.contracts import QueuedMatch
from kickstream.control import MatchController
from kickstream.copilot.api import build_copilot_router
from kickstream.copilot.service import CopilotService
from kickstream.copilot.stage import CopilotStage
from kickstream.copilot.view import MatchArchive
from kickstream.domain.demo import DEMO_SEED
from kickstream.domain.errors import Refusal
from kickstream.domain.teams import AWAY, HOME
from kickstream.fans.api import build_fans_router
from kickstream.fans.service import FanService
from kickstream.fans.stage import FanStage
from kickstream.gateway.api import build_router
from kickstream.gateway.recorder import Recorder
from kickstream.narration.budget import Budget
from kickstream.narration.cache import DiskCache
from kickstream.narration.service import NarrationService
from kickstream.narration.stage import NarrationStage
from kickstream.output.api import build_output_router
from kickstream.output.service import OutputService
from kickstream.overlay.stage import OverlayStage
from kickstream.people.api import COHOST_COOKIE, build_people_router
from kickstream.people.service import PeopleService
from kickstream.ports.calls import CallRooms
from kickstream.ports.clock import Clock
from kickstream.ports.copilot import CopilotWriter, WebSearch
from kickstream.ports.explainer import Explainer
from kickstream.ports.match_source import LiveSource, ReplaySource
from kickstream.ports.output import Encoder, ProgramCapture, Sender
from kickstream.ports.reels import ClipCutter, ReelProducer
from kickstream.ports.social import SocialFeed
from kickstream.ports.writer import NarrativeWriter
from kickstream.sources.api import build_sources_router
from kickstream.studio.api import build_studio_router, find_moment
from kickstream.studio.rules import sanitize_raw
from kickstream.studio.service import StudioService
from kickstream.studio.stage import StudioStage
from kickstream.web_files import build_web_router

STUDIO_MATCH_SPEED = 30.0  # playback speed of a match the studio starts at the end of a countdown
OPENLIGADB_LEAGUES = ("pl", "la1", "ucl")
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


_PROXIED = (b"x-forwarded-for", b"x-forwarded-host", b"forwarded", b"cf-connecting-ip")


class PublicHostGate:
    """On a public address only the guest routes answer, and the studio's only for a co-host.

    Guests reach Kickstream through a tunnel to the web server, and the studio has no sign-in. A
    request is public when it names a public host or came through any proxy: a tunnel that rewrites
    Host to the local address must not open the studio.

    Deployed, a sign-in proxy stands in front and names the signed-in user in `signed_in_header`;
    it lets only the people it allows through, and strips that header from everyone else's
    requests. When the pipeline serves the web app itself, the app's pages and files are open too:
    they hold no data, and the guest page is one of them.
    """

    def __init__(
        self,
        app,
        *,
        public_hosts: Collection[str],
        is_cohost: Callable[[str], bool],
        signed_in_header: str | None = None,
        serves_pages: bool = False,
    ) -> None:
        self._app = app
        self._public_hosts = frozenset(public_hosts)
        self._is_cohost = is_cohost
        self._signed_in_header = signed_in_header.lower().encode("latin-1") if signed_in_header else None
        self._serves_pages = serves_pages

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] in ("http", "websocket") and self._public_hosts:
            headers = dict(scope["headers"])
            if self._is_public(headers) and not self._allowed(scope["path"], headers):
                if scope["type"] == "websocket":
                    await receive()
                    await send({"type": "websocket.close", "code": 1008})
                else:
                    await JSONResponse(status_code=404, content={"detail": "Not Found"})(scope, receive, send)
                return
        await self._app(scope, receive, send)

    def _is_public(self, headers: dict[bytes, bytes]) -> bool:
        if any(name in headers for name in _PROXIED):
            return True
        named = urlsplit("//" + headers.get(b"host", b"").decode("latin-1")).hostname
        return named in self._public_hosts

    def _allowed(self, path: str, headers: dict[bytes, bytes]) -> bool:
        if path.startswith("/api/guest/"):
            return True
        if self._serves_pages and path != "/api" and not path.startswith("/api/"):
            return True
        if self._signed_in_header is not None and headers.get(self._signed_in_header, b"").strip():
            return True
        secret = cookie_parser(headers.get(b"cookie", b"").decode("latin-1")).get(COHOST_COOKIE)
        return secret is not None and self._is_cohost(secret)


def read_env_file(path: Path) -> dict[str, str]:
    """`KEY=value` lines from a .env file, if there is one, read as the web server reads them.

    Quotes around a value are dropped; an unquoted value ends at a `#`, which starts a comment.
    """
    if not path.is_file():
        return {}
    found = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip().removeprefix("export ").strip(), value.strip()
        closing = value.find(value[0], 1) if value[:1] in ("'", '"') else -1
        found[key] = value[1:closing] if closing > 0 else value.split("#", 1)[0].rstrip()
    return found


def environment(path: Path, base: Mapping[str, str]) -> dict[str, str]:
    """The settings' sources: the .env file, overridden by the real environment."""
    return {**read_env_file(path), **base}


def _hosts(text: str) -> tuple[str, ...]:
    return tuple(host.strip().lower() for host in text.split(",") if host.strip())


def _names(text: str) -> tuple[str, ...]:
    return tuple(name.strip() for name in text.split(",") if name.strip())


def _seconds(text: str | None) -> float | None:
    return float(text) if text else None


@dataclass(frozen=True)
class Settings:
    llm_base_url: str | None
    llm_model: str | None
    llm_api_key: str | None
    llm_max_calls: int = 60  # per match; a key moment costs 3 calls, a recap 2
    llm_reserve: int = 15  # kept back for goals and recaps
    llm_min_gap_s: float = 2.0  # between non-priority model calls
    llm_max_explanations: int = 20  # per match; an explanation costs 1 call
    cache_dir: Path = Path(".cache/narration")
    data_dir: Path = Path(".data")  # the studio document and uploaded images
    # Public hostnames pages are served from, when a reverse proxy rewrites Host. See domain/sockets.py.
    allowed_hosts: tuple[str, ...] = ()
    program_url: str = (
        "http://127.0.0.1:5173/studio?output"  # where the hidden browser finds the program picture
    )
    browser: str | None = None  # a Chromium-based browser; Microsoft Edge is looked for when unset
    ffmpeg: str = "ffmpeg"
    # A tunnel's hostnames. There, only the guest routes answer. See PublicHostGate.
    public_hosts: tuple[str, ...] = ()
    acs_connection_string: str | None = field(default=None, repr=False)
    # "fake": in-memory rooms, for the end-to-end tests and trying guests without Azure.
    rooms: str | None = None
    # The streamer's own X API access, and the search whose posts are the fans' comments.
    x_bearer_token: str | None = field(default=None, repr=False)
    x_query: str | None = None
    # Ask Copilot's web search: Wikipedia unless a Tavily key is given; "off" turns it off.
    web_search: str | None = None
    tavily_api_key: str | None = field(default=None, repr=False)
    # Real match data. The addresses change only for tests, which serve recorded answers locally.
    api_football_key: str | None = field(default=None, repr=False)
    statsbomb_url: str = OPEN_DATA
    api_football_url: str = API_FOOTBALL
    openligadb_url: str = OPENLIGADB
    openligadb_leagues: tuple[str, ...] = OPENLIGADB_LEAGUES
    live_poll_s: float | None = None  # tests only: poll every N seconds instead of the source's schedule
    # The built web app, served by the pipeline where no dev server runs beside it. See web_files.py.
    web_dir: Path | None = None
    # The header a sign-in proxy in front names the signed-in user in. See PublicHostGate.
    signed_in_header: str | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "Settings":
        return cls(
            llm_base_url=env.get("KICKSTREAM_LLM_BASE_URL") or None,
            llm_model=env.get("KICKSTREAM_LLM_MODEL") or None,
            llm_api_key=env.get("KICKSTREAM_LLM_API_KEY") or None,
            llm_max_calls=int(env.get("KICKSTREAM_LLM_MAX_CALLS", "60")),
            cache_dir=Path(env.get("KICKSTREAM_CACHE_DIR", ".cache/narration")),
            data_dir=Path(env.get("KICKSTREAM_DATA_DIR", ".data")),
            allowed_hosts=_hosts(env.get("KICKSTREAM_ALLOWED_HOSTS", "")),
            program_url=env.get("KICKSTREAM_PROGRAM_URL") or "http://127.0.0.1:5173/studio?output",
            browser=env.get("KICKSTREAM_BROWSER") or None,
            ffmpeg=env.get("KICKSTREAM_FFMPEG") or "ffmpeg",
            public_hosts=_hosts(env.get("KICKSTREAM_PUBLIC_HOSTS", "")),
            acs_connection_string=env.get("KICKSTREAM_ACS_CONNECTION_STRING") or None,
            rooms=env.get("KICKSTREAM_ROOMS") or None,
            x_bearer_token=env.get("KICKSTREAM_X_BEARER_TOKEN") or None,
            x_query=env.get("KICKSTREAM_X_QUERY") or None,
            web_search=env.get("KICKSTREAM_WEB_SEARCH") or None,
            tavily_api_key=env.get("KICKSTREAM_TAVILY_API_KEY") or None,
            api_football_key=env.get("KICKSTREAM_API_FOOTBALL_KEY") or None,
            statsbomb_url=env.get("KICKSTREAM_STATSBOMB_URL") or OPEN_DATA,
            api_football_url=env.get("KICKSTREAM_API_FOOTBALL_URL") or API_FOOTBALL,
            openligadb_url=env.get("KICKSTREAM_OPENLIGADB_URL") or OPENLIGADB,
            openligadb_leagues=_names(env.get("KICKSTREAM_OPENLIGADB_LEAGUES", "")) or OPENLIGADB_LEAGUES,
            live_poll_s=_seconds(env.get("KICKSTREAM_LIVE_POLL_S")),
            web_dir=Path(env["KICKSTREAM_WEB_DIR"]) if env.get("KICKSTREAM_WEB_DIR") else None,
            signed_in_header=(env.get("KICKSTREAM_SIGNED_IN_HEADER") or "").strip().lower() or None,
        )

    @property
    def llm_configured(self) -> bool:
        return bool(self.llm_base_url and self.llm_model and self.llm_api_key)

    @property
    def socket_hosts(self) -> tuple[str, ...]:
        return (*self.allowed_hosts, *self.public_hosts)

    @property
    def public_origin(self) -> str | None:
        return f"https://{self.public_hosts[0]}" if self.public_hosts else None


@dataclass
class Pipeline:
    bus: InMemoryEventBus
    store: InMemoryMatchStore
    broadcaster: InProcessBroadcaster
    controller: MatchController
    studio: StudioService
    output: OutputService
    broadcasts: BroadcastService
    people: PeopleService
    agents: AgentSwitches
    explainer: ExplainService
    fans: FanService
    copilot: CopilotService
    stages: list
    replays: Mapping[str, ReplaySource]
    live: Mapping[str, LiveSource]
    tasks: list[asyncio.Task] = field(default_factory=list)

    def start(self) -> None:
        self.tasks = [asyncio.create_task(stage.run()) for stage in self.stages]
        self.tasks.append(asyncio.create_task(self.studio.run()))
        self.tasks.append(asyncio.create_task(self.broadcasts.run()))
        self.tasks.append(asyncio.create_task(self.people.run()))
        self.tasks.append(asyncio.create_task(self.fans.run()))

    async def stop(self) -> None:
        await self.broadcasts.stop()
        await self.output.stop()
        await self.controller.stop()
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.tasks = []


def _feeds(settings: Settings) -> dict[str, SocialFeed]:
    feeds: dict[str, SocialFeed] = {"demo": DemoFeed()}
    if settings.x_bearer_token and settings.x_query:
        feeds["x"] = XRecentSearch(settings.x_bearer_token, settings.x_query)
    return feeds


def _search(settings: Settings) -> WebSearch | None:
    if settings.web_search == "off":
        return None
    if settings.tavily_api_key:
        return TavilySearch(settings.tavily_api_key)
    return WikipediaSearch()


def _replays(settings: Settings) -> dict[str, ReplaySource]:
    return {"statsbomb": StatsBombOpenData(settings.data_dir / "statsbomb", settings.statsbomb_url)}


def _live(settings: Settings) -> dict[str, LiveSource]:
    budget = DailyBudget(JsonRecordStore(settings.data_dir / "api-football-budget.json"))
    return {
        "api_football": ApiFootball(settings.api_football_key, budget, settings.api_football_url),
        "openligadb": OpenLigaDb(settings.openligadb_leagues, settings.openligadb_url),
    }


def _rooms(settings: Settings) -> CallRooms | None:
    if settings.acs_connection_string:
        return AcsRooms(settings.acs_connection_string)
    if settings.rooms == "fake":
        return FakeRooms()
    return None


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
    rooms: CallRooms | None = None,
    explainer: Explainer | None = None,
    feeds: Mapping[str, SocialFeed] | None = None,
    search: WebSearch | None = None,
    copilot_writer: CopilotWriter | None = None,
    replays: Mapping[str, ReplaySource] | None = None,
    live: Mapping[str, LiveSource] | None = None,
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
    replays = replays if replays is not None else _replays(settings)
    live = live if live is not None else _live(settings)
    controller = MatchController(
        bus,
        clock_factory,
        HOME,
        AWAY,
        prefix=match_prefix,
        replays=replays,
        live=live,
        live_poll_s=settings.live_poll_s,
    )

    async def start_studio_match(chosen: QueuedMatch | None) -> str:
        if chosen is None:
            return await controller.start(DEMO_SEED, STUDIO_MATCH_SPEED)
        return await controller.start(DEMO_SEED, chosen.speed, source=chosen.source, ref=chosen.ref)

    studio = StudioService(
        JsonStudioStore(settings.data_dir / "studio.json", sanitize=sanitize_raw),
        DirImageStore(settings.data_dir / "images"),
        now=now,
        start_match=start_studio_match,
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
    people = PeopleService(
        JsonRecordStore(settings.data_dir / "people.json", private=True),
        rooms if rooms is not None else _rooms(settings),
        find_broadcast=lambda broadcast_id: next(
            (item for item in broadcasts.view().broadcasts if item.id == broadcast_id), None
        ),
        broadcast_changes=broadcasts.changes,
        public_origin=settings.public_origin,
        now=now,
    )
    if explainer is None and settings.llm_configured:
        explainer = AgentExplainer(settings.llm_base_url, settings.llm_model, settings.llm_api_key)
    explain = ExplainService(ScriptedExplainer(), explainer, max_calls=settings.llm_max_explanations)
    agents = AgentSwitches(JsonRecordStore(settings.data_dir / "agents.json"))
    fans = FanService(
        JsonRecordStore(settings.data_dir / "fans.json"),
        feeds if feeds is not None else _feeds(settings),
        now=now,
    )
    if copilot_writer is None and settings.llm_configured:
        copilot_writer = AgentCopilotWriter(settings.llm_base_url, settings.llm_model, settings.llm_api_key)
    copilot = CopilotService(
        store,
        MatchArchive(JsonRecordStore(settings.data_dir / "matches.json")),
        current_match=lambda: controller.current,
        match_exists=controller.exists,
        search=search if search is not None else _search(settings),
        writer=copilot_writer,
        agents=agents.catalog(model=False).agents,
        now=now,
    )
    # Every stage subscribes in its constructor, so nothing published after this point is missed.
    stages = [
        AnalyticsStage(bus),
        AgentsStage(bus, agents, explain),
        NarrationStage(bus, service),
        OverlayStage(bus),
        Recorder(bus, store, broadcaster),
        StudioStage(bus, studio),
        BroadcastStage(bus, broadcasts),
        FanStage(bus, fans),
        CopilotStage(bus, copilot),
    ]
    return Pipeline(
        bus,
        store,
        broadcaster,
        controller,
        studio,
        output,
        broadcasts,
        people,
        agents,
        explain,
        fans,
        copilot,
        stages,
        replays,
        live,
    )


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
    rooms: CallRooms | None = None,
    explainer: Explainer | None = None,
    feeds: Mapping[str, SocialFeed] | None = None,
    search: WebSearch | None = None,
    copilot_writer: CopilotWriter | None = None,
    replays: Mapping[str, ReplaySource] | None = None,
    live: Mapping[str, LiveSource] | None = None,
) -> FastAPI:
    # Match IDs are unique to this process, so an ID a browser kept from before a restart is
    # reported as unknown instead of silently naming a different match.
    settings = settings or Settings.from_env(environment(Path(".env"), os.environ))
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
        rooms=rooms,
        explainer=explainer,
        feeds=feeds,
        search=search,
        copilot_writer=copilot_writer,
        replays=replays,
        live=live,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        pipeline.start()
        yield
        await pipeline.stop()

    # Serving the web app means a deployment; the API's own docs pages stay a local tool.
    docs = {} if settings.web_dir is None else {"docs_url": None, "redoc_url": None, "openapi_url": None}
    app = FastAPI(title="Kickstream", lifespan=lifespan, **docs)
    app.state.pipeline = pipeline
    app.add_middleware(SameOriginWrites)
    app.add_middleware(BodyLimit)
    app.add_middleware(
        PublicHostGate,
        public_hosts=settings.public_hosts,
        is_cohost=pipeline.people.is_cohost,
        signed_in_header=settings.signed_in_header,
        serves_pages=settings.web_dir is not None,
    )

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
            teams=lambda: pipeline.controller.teams,
            start_match=pipeline.controller.start,
            stop_match=pipeline.controller.stop,
            current_match=lambda: pipeline.controller.current,
            match_exists=pipeline.controller.exists,
            socket_hosts=settings.socket_hosts,
        )
    )
    app.include_router(
        build_sources_router(
            replays=pipeline.replays, live=pipeline.live, running=pipeline.controller.running
        )
    )
    app.include_router(
        build_studio_router(service=pipeline.studio, store=pipeline.store, socket_hosts=settings.socket_hosts)
    )
    app.include_router(build_output_router(service=pipeline.output, socket_hosts=settings.socket_hosts))
    app.include_router(
        build_broadcasts_router(service=pipeline.broadcasts, socket_hosts=settings.socket_hosts)
    )
    app.include_router(build_people_router(service=pipeline.people, socket_hosts=settings.socket_hosts))
    app.include_router(build_copilot_router(service=pipeline.copilot))
    app.include_router(build_fans_router(service=pipeline.fans, socket_hosts=settings.socket_hosts))
    app.include_router(
        build_agents_router(
            switches=pipeline.agents,
            store=pipeline.store,
            match_exists=pipeline.controller.exists,
            model=pipeline.explainer.has_model,
        )
    )
    if settings.web_dir is not None:
        app.include_router(build_web_router(settings.web_dir))  # last: it answers every other path
    return app
