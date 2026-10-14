"""The built web app, served by the pipeline itself where no dev server runs beside it (a deployment).

Every path that is not an API route or one of the build's files is a page of the app, so it gets
index.html and the app's router picks the page. Built assets carry a content hash in their name,
so they can be cached for good; index.html must be fetched again to pick up a new build.
"""

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

_FOREVER = "public, max-age=31536000, immutable"


def build_web_router(root: Path) -> APIRouter:
    root = root.resolve()
    router = APIRouter()

    @router.get("/{path:path}", include_in_schema=False)
    def page(path: str) -> FileResponse:
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404)
        found = _built_file(root, path)
        if found is None:
            return FileResponse(root / "index.html", headers={"Cache-Control": "no-cache"})
        cache = _FOREVER if path.startswith("assets/") else "no-cache"
        return FileResponse(found, headers={"Cache-Control": cache})

    return router


def _built_file(root: Path, path: str) -> Path | None:
    """The build's file at `path`, never one outside it or a hidden one such as a stray .env."""
    if not path or any(part.startswith(".") for part in path.replace("\\", "/").split("/")):
        return None
    candidate = (root / path).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        return None
    return candidate
