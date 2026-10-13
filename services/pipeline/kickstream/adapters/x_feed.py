"""Fan comments from X: recent posts matching a search, read with the streamer's own API access.

Uses the X API v2 recent search (`GET /2/tweets/search/recent`) with an app-only bearer token. X sets
how often it may be called by the access tier of the token; this asks no more than once every
`interval_s` seconds and reports a refusal to the streamer instead of retrying harder.
"""

import asyncio
import json
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from datetime import datetime

from kickstream.ports.social import FeedBatch, FeedContext, FeedFailure, IncomingComment

SEARCH_URL = "https://api.x.com/2/tweets/search/recent"
_REFUSALS = {
    401: "X did not accept the token. Check KICKSTREAM_X_BEARER_TOKEN.",
    403: "X does not allow this token to search posts. Check the access tier of the app.",
    429: "X's limit on searches was reached. Trying again in a minute.",
}


def _get(url: str, token: str) -> dict:
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})  # noqa: S310 - fixed https URL
    try:
        with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise FeedFailure(_REFUSALS.get(exc.code, f"X answered with an error ({exc.code}).")) from exc
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise FeedFailure("X could not be reached.") from exc


def _posted_at(value: object) -> float | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def comments_from(body: dict) -> list[IncomingComment]:
    """The posts in one search response, oldest first."""
    users = {
        user.get("id"): user for user in body.get("includes", {}).get("users", []) if isinstance(user, dict)
    }
    found = []
    for post in body.get("data", []) or []:
        if not isinstance(post, dict) or not post.get("id") or not post.get("text"):
            continue
        user = users.get(post.get("author_id"), {})
        username = user.get("username")
        metrics = post.get("public_metrics")
        likes = metrics.get("like_count", 0) if isinstance(metrics, dict) else 0
        found.append(
            IncomingComment(
                id=f"x-{post['id']}",
                platform="x",
                author=str(user.get("name") or username or "Someone on X"),
                handle=f"@{username}" if username else None,
                text=str(post["text"]),
                likes=likes if isinstance(likes, int) else 0,
                at=_posted_at(post.get("created_at")),
            )
        )
    return list(reversed(found))  # X lists the newest first


class XRecentSearch:
    demo = False
    interval_s = 20.0

    def __init__(self, bearer_token: str, query: str, get: Callable[[str, str], dict] = _get) -> None:
        self._token = bearer_token
        self._query = query
        self._get = get
        self._since_id: str | None = None

    def _url(self) -> str:
        params = {
            "query": self._query,
            "max_results": "25",
            "tweet.fields": "created_at,public_metrics,author_id",
            "expansions": "author_id",
            "user.fields": "name,username",
        }
        if self._since_id:
            params["since_id"] = self._since_id
        return f"{SEARCH_URL}?{urllib.parse.urlencode(params)}"

    async def fetch(self, context: FeedContext) -> FeedBatch:
        body = await asyncio.to_thread(self._get, self._url(), self._token)
        if not isinstance(body, dict):
            raise FeedFailure("X sent something that is not a search result.")
        newest = body.get("meta", {}).get("newest_id") if isinstance(body.get("meta"), dict) else None
        if isinstance(newest, str):
            self._since_id = newest
        return FeedBatch(comments=tuple(comments_from(body)))
