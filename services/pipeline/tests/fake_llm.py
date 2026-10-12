"""A local OpenAI-compatible Chat Completions endpoint for tests. No test calls a live model."""

import json
import socket
import threading
import time

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

ROLES = ("commentator", "tactical_analyst", "recap_writer", "localizer", "match_expert")
RECAP_JSON = json.dumps(
    {
        "fan": {"title": "Fan title", "bullets": ["f1", "f2", "f3"], "text": "Fan recap."},
        "analyst": {"title": "Analyst title", "bullets": ["a1", "a2", "a3"], "text": "Analyst recap."},
    }
)


def _text(content) -> str:
    if isinstance(content, str):
        return content
    return "".join(part.get("text", "") for part in content or [] if isinstance(part, dict))


def _tag(value, tag: str):
    if isinstance(value, str):
        return f"{tag}:{value}"
    if isinstance(value, list):
        return [_tag(item, tag) for item in value]
    return {key: _tag(item, tag) for key, item in value.items()}


class FakeLLM:
    def __init__(self) -> None:
        self.calls: list[dict] = []  # {"role": ..., "user": ...} per request
        self.replies: dict[str, str] = {}  # role -> canned reply overriding the default
        self.app = Starlette(routes=[Route("/v1/chat/completions", self._complete, methods=["POST"])])
        self._server = None
        self._thread = None
        self.base_url = ""

    def reset(self) -> None:
        self.calls.clear()
        self.replies.clear()

    def _reply(self, role: str, user: str) -> str:
        if role in self.replies:
            return self.replies[role]
        if role == "match_expert":
            return "The press came from fresh legs after the substitution."
        if role == "commentator":
            return "Fan line."
        if role == "tactical_analyst":
            return "Analyst line."
        if role == "recap_writer":
            return RECAP_JSON
        english = json.loads(user)
        return json.dumps({"es": _tag(english, "es"), "hi": _tag(english, "hi")}, ensure_ascii=False)

    async def _complete(self, request: Request):
        body = await request.json()
        messages = body["messages"]
        blob = " ".join(_text(m.get("content")) for m in messages)
        role = next((r for r in ROLES if f"[role:{r}]" in blob), "unknown")
        user = next((_text(m.get("content")) for m in reversed(messages) if m.get("role") == "user"), "")
        system = " ".join(_text(m.get("content")) for m in messages if m.get("role") in ("system", "developer"))
        self.calls.append({"role": role, "user": user, "system": system})
        reply = self._reply(role, user)
        if body.get("stream"):
            return StreamingResponse(self._chunks(reply), media_type="text/event-stream")
        return JSONResponse(
            {
                "id": "chatcmpl-fake",
                "object": "chat.completion",
                "created": 0,
                "model": body.get("model", "fake"),
                "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }
        )

    @staticmethod
    async def _chunks(reply: str):
        def chunk(delta, finish=None):
            payload = {
                "id": "chatcmpl-fake",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "fake",
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            }
            return f"data: {json.dumps(payload)}\n\n"

        yield chunk({"role": "assistant", "content": reply})
        yield chunk({}, "stop")
        yield "data: [DONE]\n\n"

    def start(self) -> None:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        self.base_url = f"http://127.0.0.1:{port}/v1"
        self._server = uvicorn.Server(
            uvicorn.Config(self.app, host="127.0.0.1", port=port, log_level="warning")
        )
        self._thread = threading.Thread(target=self._server.run, daemon=True)
        self._thread.start()
        while not self._server.started:
            time.sleep(0.01)

    def stop(self) -> None:
        self._server.should_exit = True
        self._thread.join(timeout=5)
