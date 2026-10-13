import stat
import sys

import pytest

from kickstream.adapters.json_record_store import JsonRecordStore


def test_a_private_record_round_trips(tmp_path):
    store = JsonRecordStore(tmp_path / "data" / "keys.json", private=True)
    assert store.load() is None
    store.save({"keys": {"d1": "sk-live"}})
    assert JsonRecordStore(tmp_path / "data" / "keys.json", private=True).load() == {
        "keys": {"d1": "sk-live"}
    }


@pytest.mark.skipif(sys.platform == "win32", reason="Windows has no owner-only file mode")
def test_a_private_record_is_readable_only_by_its_owner(tmp_path):
    path = tmp_path / "keys.json"
    JsonRecordStore(path, private=True).save({"keys": {}})
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_a_private_record_that_is_not_json_is_set_aside(tmp_path):
    path = tmp_path / "keys.json"
    path.write_text("{oops", encoding="utf-8")
    assert JsonRecordStore(path, private=True).load() is None
    assert (tmp_path / "keys.json.corrupt").exists()
