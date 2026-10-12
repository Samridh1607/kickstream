import re
import uuid
from pathlib import Path

from kickstream.ports.image_store import ImageStoreFull

_EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
_MEDIA_TYPES = {extension: media_type for media_type, extension in _EXTENSIONS.items()}
# IDs are generated here and nothing else is ever read, so a request cannot name another file.
_ID = re.compile(r"[0-9a-f]{32}\.(png|jpg|webp)")


class DirImageStore:
    def __init__(self, directory: Path, max_images: int = 50) -> None:
        self._directory = Path(directory)
        self._max_images = max_images

    def save(self, content: bytes, media_type: str) -> str:
        if media_type not in _EXTENSIONS:
            raise ValueError(f"unsupported media type {media_type}")
        self._directory.mkdir(parents=True, exist_ok=True)
        if sum(1 for _ in self._directory.iterdir()) >= self._max_images:
            raise ImageStoreFull
        image_id = f"{uuid.uuid4().hex}.{_EXTENSIONS[media_type]}"
        (self._directory / image_id).write_bytes(content)
        return image_id

    def get(self, image_id: str) -> tuple[bytes, str] | None:
        match = _ID.fullmatch(image_id)
        if match is None:
            return None
        try:
            return (self._directory / image_id).read_bytes(), _MEDIA_TYPES[match.group(1)]
        except OSError:
            return None

    def ids(self) -> list[str]:
        if not self._directory.exists():
            return []
        return [path.name for path in self._directory.iterdir() if _ID.fullmatch(path.name)]

    def delete(self, image_id: str) -> None:
        if _ID.fullmatch(image_id):
            (self._directory / image_id).unlink(missing_ok=True)
