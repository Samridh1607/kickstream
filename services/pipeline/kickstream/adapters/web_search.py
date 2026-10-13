"""Web search for Ask Copilot.

Wikipedia needs no key and is the default. Tavily searches the whole web and is used when its key is
set. Both are asked only when the person turns web search on for a question, and are sent that question.
"""

import asyncio
import html
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable

from kickstream.ports.copilot import SearchFailure, SearchResult

WIKIPEDIA_URL = "https://en.wikipedia.org/w/api.php"
TAVILY_URL = "https://api.tavily.com/search"
USER_AGENT = "Kickstream/0.1 (live-streaming studio; Ask Copilot web search)"
_TAG = re.compile(r"<[^>]+>")
_MAX_SNIPPET = 320


def _request(url: str, *, body: dict | None = None, headers: dict[str, str] | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode("utf-8")
    sent = {"User-Agent": USER_AGENT, **({"Content-Type": "application/json"} if body is not None else {})}
    request = urllib.request.Request(url, data=data, headers={**sent, **(headers or {})})  # noqa: S310 - fixed https URLs
    try:
        with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310
            parsed = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise SearchFailure("The web search refused the key it was given.") from exc
        if exc.code == 429:
            raise SearchFailure("The web search is being asked too often. Try again in a minute.") from exc
        raise SearchFailure(f"The web search answered with an error ({exc.code}).") from exc
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise SearchFailure("The web could not be reached.") from exc
    if not isinstance(parsed, dict):
        raise SearchFailure("The web search sent something that is not a result.")
    return parsed


def plain(text: object) -> str:
    """Search text as plain text: no markup, entities decoded, cut to a readable length."""
    cleaned = " ".join(html.unescape(_TAG.sub("", str(text or ""))).split())
    return cleaned if len(cleaned) <= _MAX_SNIPPET else cleaned[: _MAX_SNIPPET - 1].rstrip() + "…"


def wikipedia_results(body: dict) -> list[SearchResult]:
    found = []
    query = body.get("query")
    for item in (query.get("search", []) if isinstance(query, dict) else []) or []:
        if not isinstance(item, dict) or not item.get("title"):
            continue
        title = str(item["title"])
        page = urllib.parse.quote(title.replace(" ", "_"))
        found.append(SearchResult(title, f"https://en.wikipedia.org/wiki/{page}", plain(item.get("snippet"))))
    return found


def tavily_results(body: dict) -> list[SearchResult]:
    found = []
    for item in body.get("results", []) or []:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "")
        if not url.startswith(("https://", "http://")):
            continue  # only links a page may safely offer
        found.append(SearchResult(plain(item.get("title")) or url, url, plain(item.get("content"))))
    return found


class WikipediaSearch:
    name = "Wikipedia"

    def __init__(self, get: Callable[..., dict] = _request) -> None:
        self._get = get

    async def search(self, query: str, limit: int) -> list[SearchResult]:
        params = {
            "action": "query",
            "list": "search",
            "srsearch": query,
            "srlimit": str(limit),
            "format": "json",
            "utf8": "1",
        }
        body = await asyncio.to_thread(self._get, f"{WIKIPEDIA_URL}?{urllib.parse.urlencode(params)}")
        return wikipedia_results(body)[:limit]


class TavilySearch:
    name = "the web"

    def __init__(self, api_key: str, post: Callable[..., dict] = _request) -> None:
        self._api_key = api_key
        self._post = post

    async def search(self, query: str, limit: int) -> list[SearchResult]:
        body = await asyncio.to_thread(
            self._post,
            TAVILY_URL,
            body={"query": query, "max_results": limit},
            headers={"Authorization": f"Bearer {self._api_key}"},
        )
        return tavily_results(body)[:limit]
