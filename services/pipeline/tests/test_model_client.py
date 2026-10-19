from agent_framework.foundry import FoundryChatClient
from agent_framework.openai import OpenAIChatCompletionClient
from azure.identity.aio import DefaultAzureCredential

from kickstream.app import Settings, _chat_clients, build_pipeline

ENDPOINT = "https://kickstream.services.ai.azure.com/api/projects/kickstream"
FOUNDRY = {"foundry_project_endpoint": ENDPOINT, "foundry_deployment": "gpt-5-mini"}


def settings(tmp_path, *llm, **extra) -> Settings:
    return Settings(
        *(llm or (None, None, None)), cache_dir=tmp_path / "cache", data_dir=tmp_path / "data", **extra
    )


async def test_a_foundry_project_is_used_before_the_llm_endpoint_and_its_client_is_shared(tmp_path):
    credential = DefaultAzureCredential()
    try:
        both = settings(tmp_path, "http://127.0.0.1:9/v1", "compat-model", "test-key", **FOUNDRY)
        new_client, model = _chat_clients(both, credential)
        client = new_client()
        assert model == "gpt-5-mini"
        assert isinstance(client, FoundryChatClient) and client.model == "gpt-5-mini"
        assert new_client() is client
    finally:
        await credential.close()


def test_the_llm_endpoint_gives_each_agent_its_own_client(tmp_path):
    new_client, model = _chat_clients(
        settings(tmp_path, "http://127.0.0.1:9/v1", "compat-model", "test-key"), None
    )
    assert model == "compat-model"
    assert isinstance(new_client(), OpenAIChatCompletionClient)
    assert new_client() is not new_client()


def test_without_a_model_there_are_no_agents(tmp_path):
    assert _chat_clients(settings(tmp_path), None) is None
    assert _chat_clients(settings(tmp_path, foundry_project_endpoint=ENDPOINT), None) is None


def test_foundry_settings_are_read_from_the_environment():
    env = {"KICKSTREAM_FOUNDRY_PROJECT_ENDPOINT": ENDPOINT, "KICKSTREAM_FOUNDRY_DEPLOYMENT": "gpt-5-mini"}
    read = Settings.from_env(env)
    assert (read.foundry_project_endpoint, read.foundry_deployment) == (ENDPOINT, "gpt-5-mini")
    assert read.foundry_configured and not read.llm_configured


async def test_the_pipeline_runs_its_agents_on_the_foundry_project_and_closes_the_credential(tmp_path):
    pipeline = build_pipeline(settings(tmp_path, **FOUNDRY))
    assert isinstance(pipeline.credential, DefaultAzureCredential)
    assert pipeline.explainer.has_model
    await pipeline.stop()


async def test_the_pipeline_holds_no_credential_without_foundry(tmp_path):
    pipeline = build_pipeline(settings(tmp_path))
    assert pipeline.credential is None and not pipeline.explainer.has_model
    await pipeline.stop()
