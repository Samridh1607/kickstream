from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from kickstream.contracts import CopilotAnswer, CopilotInfo
from kickstream.copilot.mentions import AgentId
from kickstream.copilot.service import CopilotService
from kickstream.domain.types import Mode

_TEXT = 2000  # generous bound on request text; the service gives the question its real limit and message


class Ask(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(max_length=_TEXT)
    match_id: str | None = Field(default=None, max_length=100)
    mode: Mode = "fan"
    web: bool = False
    # The agent the question is put to. One tagged in the question with an @ is used when this is unset.
    agent: AgentId | None = None


def build_copilot_router(*, service: CopilotService) -> APIRouter:
    router = APIRouter(prefix="/api/copilot")

    @router.get("")
    async def get_info() -> CopilotInfo:
        return service.info()

    @router.post("/ask")
    async def post_ask(body: Ask) -> CopilotAnswer:
        return await service.ask(
            body.question, match_id=body.match_id, mode=body.mode, web=body.web, agent=body.agent
        )

    return router
