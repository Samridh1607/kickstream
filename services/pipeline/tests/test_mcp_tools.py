import pytest

from kickstream.copilot.tools import PATH
from tests.test_copilot import make_client, play_match

MCP = f"http://localhost{PATH}"
HEADERS = {"accept": "application/json, text/event-stream", "content-type": "application/json"}


def rpc(client, method: str, params: dict | None = None, url: str = MCP):
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    return client.post(url, json=body, headers=HEADERS)


def call(client, tool: str, **arguments) -> dict:
    response = rpc(client, "tools/call", {"name": tool, "arguments": arguments})
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert not result["isError"], result
    return result["structuredContent"]


@pytest.fixture
def client(tmp_path):
    with make_client(tmp_path) as test_client:
        yield test_client


def test_the_copilot_answers_are_listed_as_read_only_tools(client):
    response = rpc(client, "tools/list")
    assert response.status_code == 200, response.text
    tools = {tool["name"]: tool for tool in response.json()["result"]["tools"]}
    assert set(tools) == {
        "ask_copilot",
        "match_state",
        "win_prediction",
        "tactics",
        "player_report",
        "head_to_head",
        "highlight",
        "play_history",
        "why_it_matters",
        "where_play_is",
    }
    assert all(tool["annotations"]["readOnlyHint"] for tool in tools.values())
    assert tools["player_report"]["inputSchema"]["required"] == ["player"]


def test_a_tool_answers_from_the_match_facts_the_chat_pane_uses(client):
    assert call(client, "match_state")["answer"].startswith("No match has been started yet")
    match_id = play_match(client)
    state = call(client, "match_state", match_id=match_id)
    chat = client.post(
        "/api/copilot/ask", json={"question": "What is the score and how are the stats?"}
    ).json()
    assert state["answer"] == chat["answer"] and state["facts"]
    assert call(client, "tactics", mode="analyst")["intent"] == "tactics"
    tagged = call(client, "ask_copilot", question="@prediction who will win from here?")
    assert tagged == call(client, "win_prediction") and tagged["facts"]


def test_a_bad_question_is_a_tool_error_and_a_foreign_host_is_refused(client):
    response = rpc(client, "tools/call", {"name": "ask_copilot", "arguments": {"question": "x" * 2000}})
    assert response.json()["result"]["isError"]
    assert rpc(client, "tools/list", url=f"http://evil.example{PATH}").status_code == 421
