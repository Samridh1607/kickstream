from typing import Protocol


class AudienceStore(Protocol):
    def load(self) -> dict | None:
        """The saved record, or None when there is none to use."""

    def save(self, record: dict) -> None:
        """Persist the record. Raises OSError when it could not be written."""

    def set_aside(self) -> None:
        """Move the saved record out of the way, so the next load finds nothing."""
