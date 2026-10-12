import json
import logging
from collections.abc import Callable
from pathlib import Path

from pydantic import ValidationError

from kickstream.contracts import Studio

log = logging.getLogger(__name__)


class JsonStudioStore:
    """The studio document as one JSON file, replaced atomically on every save."""

    def __init__(self, path: Path, sanitize: Callable[[dict], dict] = lambda raw: raw) -> None:
        self._path = Path(path)
        self._sanitize = sanitize

    def load(self) -> Studio | None:
        if not self._path.exists():
            return None
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raise ValueError("the studio file does not hold an object")
            return Studio.model_validate(self._sanitize(raw))
        except (OSError, ValueError, ValidationError, AttributeError, TypeError) as exc:
            aside = self._path.with_name(self._path.name + ".corrupt")
            log.warning(
                "studio file %s is unreadable (%s); moved to %s", self._path, type(exc).__name__, aside
            )
            self._path.replace(aside)
            return None

    def save(self, studio: Studio) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(".tmp")
        temporary.write_text(studio.model_dump_json(), encoding="utf-8")
        temporary.replace(self._path)
