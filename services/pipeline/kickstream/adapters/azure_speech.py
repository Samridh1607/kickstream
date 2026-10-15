"""Azure AI Speech text to speech, over its REST API."""

from xml.sax.saxutils import escape, quoteattr

import httpx

from kickstream.ports.speech import SpeechFailure

FORMAT = "audio-24khz-96kbitrate-mono-mp3"
_REFUSED = {
    400: "Azure Speech could not use that voice or text.",
    401: "Azure Speech refused the key. Check KICKSTREAM_SPEECH_KEY and KICKSTREAM_SPEECH_REGION.",
    403: "Azure Speech refused the key. Check KICKSTREAM_SPEECH_KEY and KICKSTREAM_SPEECH_REGION.",
    429: "Azure Speech is busy: too many requests for this resource's tier.",
}


def ssml(text: str, voice: str, rate: float) -> str:
    """The text in the voice, at the rate (1.0 is the voice's own pace)."""
    language = "-".join(voice.split("-")[:2])
    percent = f"{(rate - 1) * 100:+.0f}%"
    return (
        f"<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang={quoteattr(language)}>"
        f"<voice name={quoteattr(voice)}><prosody rate={quoteattr(percent)}>{escape(text)}</prosody></voice>"
        "</speak>"
    )


class AzureSpeech:
    def __init__(
        self,
        key: str | None,
        region: str | None,
        *,
        endpoint: str | None = None,
        timeout_s: float = 20.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._key = key
        self.region = region
        self._endpoint = endpoint or (
            f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1" if region else None
        )
        self._timeout_s = timeout_s
        self._transport = transport

    def available(self) -> bool:
        return bool(self._key and self._endpoint)

    async def synthesize(self, text: str, voice: str, rate: float) -> bytes:
        if not self.available():
            raise SpeechFailure("Azure Speech is not set up.")
        headers = {
            "Ocp-Apim-Subscription-Key": self._key or "",
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": FORMAT,
            "User-Agent": "Kickstream",
        }
        try:
            async with httpx.AsyncClient(timeout=self._timeout_s, transport=self._transport) as client:
                response = await client.post(
                    self._endpoint or "", content=ssml(text, voice, rate).encode("utf-8"), headers=headers
                )
        except httpx.HTTPError as exc:
            raise SpeechFailure("Azure Speech could not be reached.") from exc
        if response.status_code != 200:
            raise SpeechFailure(
                _REFUSED.get(response.status_code, f"Azure Speech answered {response.status_code}.")
            )
        if not response.content:
            raise SpeechFailure("Azure Speech sent no audio.")
        return response.content
