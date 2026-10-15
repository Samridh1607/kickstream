from typing import Protocol


class SpeechFailure(Exception):
    """The voice service could not speak the text. The message is safe to show."""


class SpeechSynth(Protocol):
    """Turns text into spoken audio (MP3)."""

    region: str | None

    def available(self) -> bool: ...

    async def synthesize(self, text: str, voice: str, rate: float) -> bytes: ...
