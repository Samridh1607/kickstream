"""The model behind the Microsoft Agent Framework agents: a Microsoft Foundry project deployment, or any
OpenAI-compatible Chat Completions endpoint.

Agents ask a factory for their client, so each provider decides whether agents share one.
"""

from collections.abc import Callable

from agent_framework import SupportsChatGetResponse
from agent_framework.foundry import FoundryChatClient
from agent_framework.openai import OpenAIChatCompletionClient
from azure.core.credentials_async import AsyncTokenCredential

ClientFactory = Callable[[], SupportsChatGetResponse]


def openai_compatible(base_url: str, model: str, api_key: str) -> ClientFactory:
    # One client per agent: the Chat Completions client must not serve overlapping calls.
    return lambda: OpenAIChatCompletionClient(model=model, base_url=base_url, api_key=api_key)


def foundry_project(endpoint: str, deployment: str, credential: AsyncTokenCredential) -> ClientFactory:
    client = FoundryChatClient(project_endpoint=endpoint, model=deployment, credential=credential)
    return lambda: client
