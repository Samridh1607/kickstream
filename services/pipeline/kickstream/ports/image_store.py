from typing import Protocol


class ImageStoreFull(Exception):
    """The store already holds as many images as it allows."""


class ImageStore(Protocol):
    def save(self, content: bytes, media_type: str) -> str:
        """Store an image and return its ID. Raises ImageStoreFull at the limit."""

    def get(self, image_id: str) -> tuple[bytes, str] | None:
        """The image's bytes and media type, or None when there is no such image."""

    def ids(self) -> list[str]:
        """The IDs of every stored image."""

    def delete(self, image_id: str) -> None:
        """Remove an image. Removing one that does not exist is not an error."""
