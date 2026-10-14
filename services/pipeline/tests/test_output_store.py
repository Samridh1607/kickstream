import os
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


@pytest.mark.skipif(sys.platform == "win32", reason="Windows has no owner-only file mode")
def test_a_private_record_is_never_readable_by_others_while_it_is_written(tmp_path, monkeypatch):
    # Watch the temporary file at the moment the content is about to be written: it must already be
    # owner-only and still empty. A file created with the default mode is readable by others here.
    previous = os.umask(0o022)
    try:
        seen = []
        real_fdopen = os.fdopen

        def watch(fd, *args, **kwargs):
            info = os.fstat(fd)
            seen.append((stat.S_IMODE(info.st_mode), info.st_size))
            return real_fdopen(fd, *args, **kwargs)

        monkeypatch.setattr(os, "fdopen", watch)
        JsonRecordStore(tmp_path / "keys.json", private=True).save({"keys": {"d1": "sk-live"}})
    finally:
        os.umask(previous)
    assert seen == [(0o600, 0)]
    assert stat.S_IMODE((tmp_path / "keys.json").stat().st_mode) == 0o600


@pytest.mark.skipif(sys.platform == "win32", reason="Windows has no owner-only file mode")
def test_a_loose_leftover_temporary_file_does_not_make_the_record_loose(tmp_path):
    path = tmp_path / "keys.json"
    leftover = tmp_path / "keys.tmp"
    leftover.write_text("old", encoding="utf-8")
    os.chmod(leftover, 0o644)
    JsonRecordStore(path, private=True).save({"keys": {"d1": "sk-live"}})
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert JsonRecordStore(path, private=True).load() == {"keys": {"d1": "sk-live"}}


def test_a_save_waits_out_another_program_briefly_holding_the_file(tmp_path, monkeypatch):
    # On Windows, a virus scanner or indexer that has the record open makes the replace fail for a moment.
    path = tmp_path / "budget.json"
    real_replace = os.replace
    refusals = [PermissionError(13, "Access is denied")] * 2

    def held(source, target):
        if refusals:
            raise refusals.pop()
        real_replace(source, target)

    monkeypatch.setattr(os, "replace", held)
    JsonRecordStore(path).save({"used": 3})
    assert JsonRecordStore(path).load() == {"used": 3}


def test_a_save_still_fails_when_the_file_stays_held(tmp_path, monkeypatch):
    def held(source, target):
        raise PermissionError(13, "Access is denied")

    monkeypatch.setattr(os, "replace", held)
    with pytest.raises(PermissionError):
        JsonRecordStore(tmp_path / "budget.json").save({"used": 3})


def test_a_private_record_that_is_not_json_is_set_aside(tmp_path):
    path = tmp_path / "keys.json"
    path.write_text("{oops", encoding="utf-8")
    assert JsonRecordStore(path, private=True).load() is None
    assert (tmp_path / "keys.json.corrupt").exists()
