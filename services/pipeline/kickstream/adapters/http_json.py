"""HTTP GET for the football data sources, with urllib so no dependency is needed."""

import http.client
import json
import urllib.request
from collections.abc import Callable, Mapping
from typing import Any

from kickstream.ports.match_source import SourceFailure

Get = Callable[[str, Mapping[str, str]], tuple[bytes, dict[str, str]]]
USER_AGENT = "Kickstream"


def http_get(url: str, headers: Mapping[str, str], timeout: float = 30.0) -> tuple[bytes, dict[str, str]]:
    """GET with urllib (`User-Agent: Kickstream`). Response headers are lower-cased. Raises HTTPError and URLError
    unchanged so each adapter writes its own message."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **headers})  # noqa: S310 - https URLs
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
        return response.read(), {name.lower(): value for name, value in response.headers.items()}


def get_json(
    get: Get, url: str, headers: Mapping[str, str], *, unreachable: str, unreadable: str
) -> tuple[Any, dict[str, str]]:
    """The parsed body and the response headers. A failed request raises SourceFailure(unreachable), and a body
    that is not JSON raises SourceFailure(unreadable)."""
    try:
        body, received = get(url, headers)
    except (OSError, http.client.HTTPException) as exc:  # URLError, HTTPError and timeouts are OSErrors
        raise SourceFailure(unreachable) from exc
    try:
        return json.loads(body.decode("utf-8")), received
    except ValueError as exc:
        raise SourceFailure(unreadable) from exc
