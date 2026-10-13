import contextlib
import json
import logging
import os
from pathlib import Path

log = logging.getLogger(__name__)


def _write_owner_only(path: Path, text: str) -> None:
    """Create the file owner-only before any content goes in. A leftover file is removed, never reused."""
    with contextlib.suppress(FileNotFoundError):
        path.unlink()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)


class JsonRecordStore:
    """A plain record as one JSON file, replaced atomically on every save."""

    def __init__(self, path: Path, *, private: bool = False) -> None:
        self._path = Path(path)
        self._private = private  # holds secrets: readable only by its owner, where the system has file modes

    def load(self) -> dict | None:
        if not self._path.exists():
            return None
        try:
            record = json.loads(self._path.read_text(encoding="utf-8"))
        except ValueError:
            record = None
        if not isinstance(record, dict):
            self.set_aside()
            return None
        return record

    def save(self, record: dict) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(".tmp")
        text = json.dumps(record, ensure_ascii=False)
        if self._private:
            _write_owner_only(temporary, text)
        else:
            temporary.write_text(text, encoding="utf-8")
        temporary.replace(self._path)

    def set_aside(self) -> None:
        if self._path.exists():
            aside = self._path.with_name(self._path.name + ".corrupt")
            log.warning("record %s is unusable; moved to %s", self._path, aside)
            self._path.replace(aside)
