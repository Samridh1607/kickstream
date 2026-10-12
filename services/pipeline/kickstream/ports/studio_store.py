from typing import Protocol

from kickstream.contracts import Studio


class StudioStore(Protocol):
    def load(self) -> Studio | None:
        """The saved studio, or None when there is none to use."""

    def save(self, studio: Studio) -> None:
        """Persist the studio. Raises OSError when it could not be written."""
