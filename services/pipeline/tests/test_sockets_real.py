"""Socket behaviour over a real server and a real WebSocket client.

The in-process test client reports a close code even when the server never completed the
handshake. A browser does not: it sees only a failed connection. These tests use the real
thing, so a refusal is only counted as delivered when a real client receives its code.
"""

import json
import socket
import threading
import time

import pytest
import uvicorn
from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect

from kickstream.adapters.clocks import InstantClock
from kickstream.app import Settings, create_app


class Server:
    def __init__(self, tmp_path, **settings):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        config = Settings(
            None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data", **settings
        )
        app = create_app(config, clock_factory=lambda speed: InstantClock(), match_prefix="m")
        self._server = uvicorn.Server(
            uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="warning")
        )
        self._thread = threading.Thread(target=self._server.run, daemon=True)

    def __enter__(self):
        self._thread.start()
        while not self._server.started:
            time.sleep(0.01)
        return self

    def __exit__(self, *_):
        self._server.should_exit = True
        self._thread.join(timeout=10)

    def url(self, path):
        return f"ws://127.0.0.1:{self.port}{path}"


@pytest.fixture
def server(tmp_path):
    with Server(tmp_path) as running:
        yield running


def close_code(url, **kwargs):
    with connect(url, open_timeout=5, **kwargs) as client:
        with pytest.raises(ConnectionClosed) as closed:
            client.recv(timeout=5)
    return closed.value.rcvd.code


def test_a_real_client_receives_the_studio_document(server):
    with connect(server.url("/api/studio/socket"), open_timeout=5) as client:
        assert json.loads(client.recv(timeout=5))["revision"] == 0


def test_a_real_client_is_told_the_match_is_unknown_so_it_can_stop_retrying(server):
    assert close_code(server.url("/api/matches/m-99/socket")) == 4404


def test_a_real_client_from_another_site_is_told_it_is_refused(server):
    assert close_code(server.url("/api/studio/socket"), origin="https://evil.example") == 1008


def test_a_page_served_from_another_port_of_this_host_is_let_in(server):
    with connect(
        server.url("/api/audience/socket"), origin="http://127.0.0.1:5173", open_timeout=5
    ) as client:
        assert json.loads(client.recv(timeout=5))["revision"] == 0


def test_behind_a_proxy_the_public_host_is_let_in_once_it_is_configured(tmp_path):
    """A reverse proxy usually rewrites Host, so the page's origin no longer matches it."""
    assert_refused = None
    with Server(tmp_path / "a") as plain:
        assert_refused = close_code(plain.url("/api/audience/socket"), origin="https://kick.example")
    assert assert_refused == 1008
    with Server(tmp_path / "b", allowed_hosts=("kick.example",)) as configured:
        with connect(
            configured.url("/api/audience/socket"), origin="https://kick.example", open_timeout=5
        ) as client:
            assert json.loads(client.recv(timeout=5))["revision"] == 0
        assert close_code(configured.url("/api/audience/socket"), origin="https://evil.example") == 1008
