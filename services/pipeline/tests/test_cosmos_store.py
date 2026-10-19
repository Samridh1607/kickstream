from azure.core.exceptions import ServiceRequestError

from kickstream.adapters.cosmos_store import CosmosMatchStore
from kickstream.adapters.memory_store import InMemoryMatchStore
from kickstream.app import Settings, _store
from kickstream.contracts import MatchEvent
from tests.factories import moment


class FakeContainer:
    """The two Cosmos DB container calls the store makes, kept in a dict."""

    def __init__(self, fail_writes: int = 0) -> None:
        self.documents: dict[str, dict] = {}
        self.queries = 0
        self._fail_writes = fail_writes

    def upsert_item(self, body: dict) -> dict:
        if self._fail_writes:
            self._fail_writes -= 1
            raise ServiceRequestError("unreachable")
        self.documents[body["id"]] = body
        return body

    def query_items(self, query: str, parameters: list[dict], partition_key: str):
        self.queries += 1
        found = [doc for doc in self.documents.values() if doc["match_id"] == partition_key]
        return sorted(found, key=lambda doc: doc["seq"])


def _event(seq: int) -> MatchEvent:
    return MatchEvent(
        id=f"m-1-e{seq}",
        match_id="m-1",
        seq=seq,
        minute=seq,
        second=0,
        type="pass",
        team="home",
        x=40,
        y=50,
        pass_distance=18.2,
        ball_speed=17.0,
    )


def test_each_item_is_served_from_memory_and_written_behind_to_cosmos_db():
    container = FakeContainer()
    store = CosmosMatchStore(container)
    first = store.append("m-1", "match_event", 1, _event(1), team_id="nb", player_id="p7")
    store.append("m-1", "key_moment", 2, moment(minute=2), language="en", mode="fan")
    assert [item.id for item in store.read("m-1")] == [1, 2] and first.player_id == "p7"
    store.flush()
    assert sorted(container.documents) == ["m-1:1", "m-1:2"]
    assert container.documents["m-1:1"]["payload"]["ball_speed"] == 17.0
    store.close()


def test_a_match_no_longer_in_memory_is_read_back_from_cosmos_db_with_its_payload_types():
    container = FakeContainer()
    writer = CosmosMatchStore(container)
    writer.append("m-1", "match_event", 1, _event(1), team_id="nb")
    writer.append("m-1", "match_event", 2, _event(2))
    writer.flush()
    writer.close()

    restarted = CosmosMatchStore(container)
    assert restarted.has("m-1")
    items = restarted.read("m-1", after_id=1)
    assert [item.id for item in items] == [2] and isinstance(items[0].payload, MatchEvent)
    assert restarted.read("m-1")[0].team_id == "nb"
    assert not restarted.has("m-9") and not restarted.has("m-9") and container.queries == 2
    restarted.close()


def test_a_failed_write_is_counted_and_never_reaches_the_caller():
    container = FakeContainer(fail_writes=1)
    store = CosmosMatchStore(container)
    store.append("m-1", "match_event", 1, _event(1))
    store.append("m-1", "match_event", 2, _event(2))
    store.flush()
    assert store.failures == 1 and sorted(container.documents) == ["m-1:2"]
    assert len(store.read("m-1")) == 2
    store.close()


def test_local_runs_keep_the_match_log_in_memory(tmp_path):
    settings = Settings(None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data")
    assert isinstance(_store(settings), InMemoryMatchStore)
    assert Settings.from_env(
        {"KICKSTREAM_COSMOS_ENDPOINT": "https://kick.documents.azure.com:443/"}
    ).cosmos_endpoint
