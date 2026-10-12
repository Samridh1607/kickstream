import json
from pathlib import Path


class DiskCache:
    """One JSON file per key. Replaying a seeded match reuses earlier model output."""

    def __init__(self, directory: Path) -> None:
        self._directory = Path(directory)
        self._directory.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        return self._directory / f"{key}.json"

    def get(self, key: str) -> dict | None:
        try:
            value = json.loads(self._path(key).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return value if isinstance(value, dict) else None

    def put(self, key: str, value: dict) -> None:
        temporary = self._path(key).with_suffix(".tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        temporary.replace(self._path(key))
