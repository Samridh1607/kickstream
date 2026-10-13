"""The program page in a hidden Chromium, told over the DevTools protocol to record itself."""

import asyncio
import contextlib
import itertools
import json
import os
import shutil
import tempfile
import time
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
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "about:blank",
    ]


def _page_socket(port: int) -> str:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5) as response:
        targets = json.load(response)
    address = next(
        (target["webSocketDebuggerUrl"] for target in targets if target.get("type") == "page"), None
    )
    if address is None:
        raise OSError("the browser opened no page")
    return address


def _remove(profile: Path) -> None:
    """Windows keeps a killed browser's files locked for a moment, so try a few times."""
    for _ in range(20):
        shutil.rmtree(profile, ignore_errors=True)
        if not profile.exists():
            return
        time.sleep(0.1)


class ChromiumCapture:
    def __init__(self, browser: str | None = None, *, ready_timeout_s: float = 15.0) -> None:
        self._configured = browser
        self._ready_timeout_s = ready_timeout_s
        self._process: asyncio.subprocess.Process | None = None
        self._group: KillOnExit | None = None
        self._devtools = None
        self._profile: Path | None = None
        self._ids = itertools.count(1)

    def available(self) -> str | None:
        return None if find_browser(self._configured) else _MISSING

    async def start(self, url: str, width: int, height: int) -> None:
        binary = find_browser(self._configured)
        if binary is None:
            raise OutputFailure(_MISSING)
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
            port = await self._debugging_port()
            address = await asyncio.to_thread(_page_socket, port)
            # Kept open for the life of the capture: the page size set below lasts only as long as it.
            self._devtools = await websockets.connect(address, max_size=None, ping_interval=None)
            await self._call(
                "Emulation.setDeviceMetricsOverride",
                width=width,
                height=height,
                deviceScaleFactor=1,
                mobile=False,
            )
            await self._call("Page.navigate", url=url)
            await self._until_ready(url)
            # A page may only ask to be captured in answer to a user's action; this stands in for one.
            started = await self._call(
                "Runtime.evaluate", expression=_START, awaitPromise=True, userGesture=True
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

    async def _debugging_port(self) -> int:
        """The browser writes the port it chose into its profile once it is listening."""
        port_file = self._profile / "DevToolsActivePort"
        for _ in range(100):
            with contextlib.suppress(OSError, ValueError, IndexError):
                return int(port_file.read_text(encoding="utf-8").splitlines()[0])
            if self._process.returncode is not None:
                raise OSError("the browser exited at once")
            await asyncio.sleep(0.1)
        raise TimeoutError

    async def _call(self, method: str, **params) -> dict:
        call_id = next(self._ids)
        await self._devtools.send(json.dumps({"id": call_id, "method": method, "params": params}))
        while True:
            message = json.loads(await asyncio.wait_for(self._devtools.recv(), 30))
            if message.get("id") == call_id:
                if "error" in message:
                    raise OutputFailure(f"The hidden browser refused {method}.")
                return message.get("result", {})

    async def _until_ready(self, url: str) -> None:
        deadline = asyncio.get_running_loop().time() + self._ready_timeout_s
        while asyncio.get_running_loop().time() < deadline:
            answer = await self._call("Runtime.evaluate", expression=_READY, returnByValue=True)
            if answer.get("result", {}).get("value") is True:
                return
            await asyncio.sleep(0.25)
        # The address is shown without its query, which carries the run's token.
        raise OutputFailure(f"The program page did not start. Check that it opens at {url.split('?')[0]}")

    async def wait(self) -> None:
        if self._process is not None:
            await self._process.wait()

    async def stop(self) -> None:
        devtools, self._devtools = self._devtools, None
        if devtools is not None:
            with contextlib.suppress(Exception):
                await devtools.close()
        group, self._group = self._group, None
        if group is not None:
            group.close()
        process = self._process
        if process is not None and process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()
        profile, self._profile = self._profile, None
        if profile is not None:
            await asyncio.to_thread(_remove, profile)
