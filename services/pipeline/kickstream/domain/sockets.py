"""Shared plumbing for the WebSocket form of a live stream.

Browsers allow only six HTTP connections to one server, and every Server-Sent Events stream
holds one for as long as the page is open. A streamer with the studio and the program open in
one browser would use them all, and no button press could reach the server. WebSockets are
not counted in that limit, so pages follow live data over these sockets; the SSE routes stay
for tools that want them.
"""

import asyncio
import contextlib
from collections.abc import AsyncIterator
from urllib.parse import urlsplit

from starlette.websockets import WebSocket, WebSocketDisconnect

REFUSED = 1008  # policy violation: the page asking is not one of ours
NOT_FOUND = 4404  # the thing to follow does not exist; the page should not retry


def same_host(websocket: WebSocket) -> bool:
    """Whether the page that opened the socket was served from this host.

    The browser's same-origin rule does not cover WebSockets, so any site could otherwise
    read these streams from a streamer's browser. Ports are ignored: the dev server and the
    pipeline share a host but not a port. A client that sends no Origin is not a browser page.
    """
    origin = websocket.headers.get("origin")
    if origin is None:
        return True
    host = websocket.headers.get("host", "")
    return urlsplit(origin).hostname == urlsplit(f"//{host}").hostname


async def _send_all(websocket: WebSocket, messages: AsyncIterator[str]) -> None:
    """Send every message, then close: a stream that ends (a viewer too slow to keep up) ends the socket."""
    async with contextlib.aclosing(messages):
        async for message in messages:
            await websocket.send_text(message)
    await websocket.close()


async def pump(websocket: WebSocket, messages: AsyncIterator[str]) -> None:
    """Accept the socket and send each message until the stream ends or the page goes away."""
    if not same_host(websocket):
        await websocket.close(code=REFUSED)
        return
    await websocket.accept()
    sender = asyncio.create_task(_send_all(websocket, messages))
    try:
        # Nothing is expected from the page; reading is how its departure is noticed.
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        sender.cancel()
        await asyncio.gather(sender, return_exceptions=True)
