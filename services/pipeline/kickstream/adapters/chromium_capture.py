"""The program page in a hidden Chromium, told over the DevTools protocol to record itself."""

import asyncio
import contextlib
import itertools
import json
import logging
import os
import shutil
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

import websockets

from kickstream.adapters.process_group import KillOnExit
from kickstream.ports.output import OutputFailure

_MISSING = "No Chromium-based browser was found. Install Microsoft Edge, or set KICKSTREAM_BROWSER to a browser's path."
_NAMES = ("msedge", "microsoft-edge", "google-chrome", "chromium", "chromium-browser", "chrome")
_START = "window.__kickstreamStartCapture()"
_READY = "typeof window.__kickstreamStartCapture === 'function'"


def _installed() -> list[Path]:
    roots = [os.environ.get(name) for name in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA")]
    windows = [
        Path(root) / vendor
        for root in roots
        if root
        for vendor in ("Microsoft/Edge/Application/msedge.exe", "Google/Chrome/Application/chrome.exe")
    ]
    mac = [
        Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ]
    return [*windows, *mac]


def find_browser(configured: str | None) -> str | None:
    """The browser to use: the configured one, else Edge, else another Chromium."""
    if configured:
        return configured if Path(configured).is_file() else shutil.which(configured)
    for path in _installed():
        if path.is_file():
            return str(path)
    return next((found for name in _NAMES if (found := shutil.which(name))), None)


def browser_args(profile: Path, width: int, height: int) -> list[str]:
    # `--use-fake-ui-for-media-stream` must never appear here: with it the browser offers the
    # whole screen, and the streamer's desktop would go on air.
    return [
        "--headless=new",
        f"--user-data-dir={profile}",
        "--remote-debugging-port=0",
        "--auto-accept-this-tab-capture",
        "--autoplay-policy=no-user-gesture-required",
        f"--window-size={width},{height}",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        # Tab capture otherwise adds a bar that takes 47 pixels off the top of the page after recording starts.
        "--disable-infobars",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "about:blank",
    ]


# The library logs every frame at DEBUG, and the navigation frame carries the page address with its token.
_QUIET = logging.getLogger("kickstream.devtools_frames")
_QUIET.setLevel(logging.CRITICAL)
_QUIET.propagate = False


def _page_socket(port: int, timeout: float) -> str:
    # Loopback must not go through a proxy from the environment or the system settings.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f"http://127.0.0.1:{port}/json/list", timeout=timeout) as response:
        targets = json.load(response)
    address = next(
        (target["webSocketDebuggerUrl"] for target in targets if target.get("type") == "page"), None
    )
    if address is None:
        raise OSError("the browser opened no page")
    return address


def _without_token(url: str) -> str:
    """The address as the streamer can open it: the run's token is a secret and stays out of messages."""
    parts = urllib.parse.urlsplit(url)
    query = [
        (name, value)
        for name, value in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        if name != "capture"
    ]
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


def honest_user_agent(agent: str) -> str:
    """Calling services turn away browsers that say they are headless, and the program page joins calls."""
    return agent.replace("HeadlessChrome", "Chrome")


def _remove(profile: Path) -> None:
    """Windows keeps a killed browser's files locked for a moment, so try a few times."""
    for _ in range(20):
        shutil.rmtree(profile, ignore_errors=True)
        if not profile.exists():
            return
        time.sleep(0.1)


class ChromiumCapture:
    def __init__(self, browser: str | None = None, *, start_timeout_s: float = 15.0) -> None:
        self._configured = browser
        self._start_timeout_s = start_timeout_s
        self._deadline = 0.0
        self._process: asyncio.subprocess.Process | None = None
        self._group: KillOnExit | None = None
        self._devtools = None
        self._profile: Path | None = None
        self._ids = itertools.count(1)

    def available(self) -> str | None:
        return None if find_browser(self._configured) else _MISSING

    def _left(self) -> float:
        return max(0.0, self._deadline - asyncio.get_running_loop().time())

    async def _within(self, stage: str, work):
        """Run `work` in what is left of the start deadline; running out reports which stage it was in."""
        try:
            return await asyncio.wait_for(work, self._left())
        except TimeoutError:
            raise OutputFailure(stage) from None

    async def start(self, url: str, width: int, height: int) -> None:
        binary = find_browser(self._configured)
        if binary is None:
            raise OutputFailure(_MISSING)
        self._deadline = asyncio.get_running_loop().time() + self._start_timeout_s
        browser_late = "The hidden browser did not start in time."
        page_late = f"The program page did not start. Check that it opens at {_without_token(url)}"
        record_late = "The program page did not begin recording in time."
        self._profile = Path(tempfile.mkdtemp(prefix="kickstream-browser-"))
        try:
            self._process = await asyncio.create_subprocess_exec(
                binary,
                *browser_args(self._profile, width, height),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            self._group = KillOnExit()
            self._group.add(self._process.pid)
            port = await self._within(browser_late, self._debugging_port())
            address = await self._within(
                browser_late, asyncio.to_thread(_page_socket, port, max(0.1, min(5.0, self._left())))
            )
            # Kept open for the life of the capture.
            self._devtools = await self._within(
                browser_late,
                websockets.connect(
                    address,
                    max_size=None,
                    ping_interval=None,
                    proxy=None,
                    logger=_QUIET,
                    open_timeout=max(0.1, self._left()),
                    close_timeout=1,
                ),
            )
            await self._within(browser_late, self._honest_user_agent())
            # The program shows this computer's camera and carries its microphone when the studio
            # asks for them. Only those two, and only for the program's own address: never the screen.
            parts = urllib.parse.urlsplit(url)
            await self._within(
                browser_late,
                self._call(
                    "Browser.grantPermissions",
                    origin=f"{parts.scheme}://{parts.netloc}",
                    permissions=["videoCapture", "audioCapture"],
                ),
            )
            await self._within(browser_late, self._call("Page.navigate", url=url))
            await self._within(page_late, self._until_ready())
            await self._within(browser_late, self._size_content(width, height))
            # A page may only ask to be captured in answer to a user's action; this stands in for one.
            started = await self._within(
                record_late,
                self._call("Runtime.evaluate", expression=_START, awaitPromise=True, userGesture=True),
            )
            if "exceptionDetails" in started:
                why = started["exceptionDetails"].get("exception", {}).get("description", "unknown reason")
                raise OutputFailure(f"The program page could not record itself: {why.splitlines()[0]}")
        except OutputFailure:
            await self.stop()
            raise
        except (OSError, TimeoutError, NotImplementedError, websockets.WebSocketException) as exc:
            await self.stop()
            raise OutputFailure(f"The hidden browser could not be started ({type(exc).__name__}).") from exc

    async def _size_content(self, width: int, height: int) -> None:
        """Make the page's own area exactly width x height, at a pixel ratio of 1.

        The window the browser was given includes its own frame, so its page area comes out smaller than
        asked, and tab capture records that area. Emulating the size instead would lay the page out for
        one size while recording another, so the window is resized by what the frame takes.
        """
        window = (await self._call("Browser.getWindowForTarget"))["windowId"]
        for _ in range(3):
            inner = (
                await self._call(
                    "Runtime.evaluate",
                    expression="[innerWidth, innerHeight]",
                    returnByValue=True,
                )
            )["result"]["value"]
            lack_w, lack_h = width - inner[0], height - inner[1]
            if lack_w == 0 and lack_h == 0:
                return
            bounds = (await self._call("Browser.getWindowBounds", windowId=window))["bounds"]
            await self._call(
                "Browser.setWindowBounds",
                windowId=window,
                bounds={
                    "windowState": "normal",
                    "width": bounds["width"] + lack_w,
                    "height": bounds["height"] + lack_h,
                },
            )
        raise OutputFailure("The hidden browser could not be given the chosen picture size.")

    async def _debugging_port(self) -> int:
        """The browser writes the port it chose into its profile once it is listening."""
        port_file = self._profile / "DevToolsActivePort"
        while True:
            with contextlib.suppress(OSError, ValueError, IndexError):
                return int(port_file.read_text(encoding="utf-8").splitlines()[0])
            if self._process.returncode is not None:
                raise OSError("the browser exited at once")
            await asyncio.sleep(0.1)

    async def _call(self, method: str, **params) -> dict:
        call_id = next(self._ids)
        await self._devtools.send(json.dumps({"id": call_id, "method": method, "params": params}))
        while True:
            message = json.loads(await self._devtools.recv())
            if message.get("id") == call_id:
                if "error" in message:
                    raise OutputFailure(f"The hidden browser refused {method}.")
                return message.get("result", {})

    async def _honest_user_agent(self) -> None:
        answer = await self._call("Runtime.evaluate", expression="navigator.userAgent", returnByValue=True)
        agent = answer.get("result", {}).get("value")
        if isinstance(agent, str) and agent != honest_user_agent(agent):
            await self._call("Emulation.setUserAgentOverride", userAgent=honest_user_agent(agent))

    async def _until_ready(self) -> None:
        while True:
            answer = await self._call("Runtime.evaluate", expression=_READY, returnByValue=True)
            if answer.get("result", {}).get("value") is True:
                return
            await asyncio.sleep(0.25)

    async def wait(self) -> None:
        if self._process is not None:
            await self._process.wait()

    async def stop(self) -> None:
        # End the browser first: a frozen one would never answer a close handshake.
        group, self._group = self._group, None
        if group is not None:
            group.close()
        process = self._process
        if process is not None and process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(process.wait(), 5)
        devtools, self._devtools = self._devtools, None
        if devtools is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(devtools.close(), 2)
        profile, self._profile = self._profile, None
        if profile is not None:
            await asyncio.to_thread(_remove, profile)
