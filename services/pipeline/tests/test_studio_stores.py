import json

import pytest

from kickstream.adapters.dir_image_store import DirImageStore
from kickstream.adapters.json_studio_store import JsonStudioStore
from kickstream.ports.image_store import ImageStoreFull
from kickstream.studio import rules
from kickstream.studio.templates import default_studio

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def test_a_saved_studio_is_loaded_back(tmp_path):
    store = JsonStudioStore(tmp_path / "data" / "studio.json")
    assert store.load() is None, "nothing saved yet"
    doc = rules.enqueue_banner(default_studio(), "गोल!", "goal", 8, 1000.0)
    store.save(doc)
    assert JsonStudioStore(tmp_path / "data" / "studio.json").load() == doc
    assert [p.name for p in (tmp_path / "data").iterdir()] == ["studio.json"], (
        "no temporary file is left behind"
    )


@pytest.mark.parametrize(
    "content",
    ["{not json", "[1, 2, 3]", '{"revision": "soon"}', ""],
    ids=["malformed", "not-an-object", "wrong-shape", "empty"],
)
def test_an_unreadable_file_is_set_aside_and_the_studio_starts_fresh(tmp_path, content):
    path = tmp_path / "studio.json"
    path.write_text(content, encoding="utf-8")
    store = JsonStudioStore(path)
    assert store.load() is None
    assert not path.exists()
    assert (tmp_path / "studio.json.corrupt").read_text(encoding="utf-8") == content
    store.save(default_studio())
    assert store.load() == default_studio()


def test_a_second_corrupt_file_replaces_the_one_set_aside_earlier(tmp_path):
    path = tmp_path / "studio.json"
    for content in ("first", "second"):
        path.write_text(content, encoding="utf-8")
        assert JsonStudioStore(path).load() is None
    assert (tmp_path / "studio.json.corrupt").read_text(encoding="utf-8") == "second"


def test_a_studio_saved_before_matches_could_be_queued_still_loads(tmp_path):
    path = tmp_path / "studio.json"
    raw = default_studio().model_dump()
    del raw["settings"]["queued_match"], raw["problem"]
    path.write_text(json.dumps(raw), encoding="utf-8")
    loaded = JsonStudioStore(path, sanitize=rules.sanitize_raw).load()
    assert loaded == default_studio()
    assert loaded.settings.queued_match is None and loaded.problem is None


def test_the_sanitizer_runs_before_validation(tmp_path):
    path = tmp_path / "studio.json"
    raw = default_studio().model_dump()
    raw["scenes"][0]["elements"].append({**raw["scenes"][0]["elements"][0], "id": "zz", "type": "webcam"})
    path.write_text(json.dumps(raw), encoding="utf-8")
    assert JsonStudioStore(path).load() is None, (
        "without a sanitizer the unknown element makes the file unreadable"
    )
    path.write_text(json.dumps(raw), encoding="utf-8")
    loaded = JsonStudioStore(path, sanitize=rules.sanitize_raw).load()
    assert loaded == default_studio()


def test_a_failed_save_raises_and_leaves_the_previous_file(tmp_path):
    path = tmp_path / "studio.json"
    store = JsonStudioStore(path)
    store.save(default_studio())
    blocker = tmp_path / "studio.tmp"
    blocker.mkdir()
    with pytest.raises(OSError):
        store.save(rules.enqueue_banner(default_studio(), "x", "custom", 8, 1.0))
    blocker.rmdir()
    assert store.load() == default_studio()


def test_images_are_saved_under_generated_ids_and_fetched_with_their_type(tmp_path):
    store = DirImageStore(tmp_path / "images")
    png = store.save(PNG, "image/png")
    jpg = store.save(b"\xff\xd8\xff" + b"\x01" * 8, "image/jpeg")
    webp = store.save(b"RIFF\x00\x00\x00\x00WEBP", "image/webp")
    assert (
        png.endswith(".png")
        and jpg.endswith(".jpg")
        and webp.endswith(".webp")
        and len({png, jpg, webp}) == 3
    )
    assert store.get(png) == (PNG, "image/png")
    assert store.get(jpg)[1] == "image/jpeg" and store.get(webp)[1] == "image/webp"


def test_an_unsupported_media_type_is_refused(tmp_path):
    with pytest.raises(ValueError):
        DirImageStore(tmp_path).save(b"<svg/>", "image/svg+xml")


@pytest.mark.parametrize(
    "image_id",
    [
        "../studio.json",
        "..\\studio.json",
        "/etc/passwd",
        "secret.png",
        "a" * 32 + ".gif",
        "a" * 31 + ".png",
        "A" * 32 + ".png",
        "a" * 32 + ".png/../../x",
        "",
        "a" * 32 + ".png\x00",
    ],
)
def test_only_well_formed_ids_can_be_read(tmp_path, image_id):
    (tmp_path / "studio.json").write_text("{}", encoding="utf-8")
    (tmp_path / "images").mkdir()
    (tmp_path / "images" / "secret.png").write_bytes(PNG)
    assert DirImageStore(tmp_path / "images").get(image_id) is None


def test_a_well_formed_id_that_was_never_saved_is_not_found(tmp_path):
    assert DirImageStore(tmp_path).get("0" * 32 + ".png") is None


def test_the_store_refuses_images_past_its_limit(tmp_path):
    store = DirImageStore(tmp_path, max_images=2)
    store.save(PNG, "image/png")
    store.save(PNG, "image/png")
    with pytest.raises(ImageStoreFull):
        store.save(PNG, "image/png")
    assert len(list(tmp_path.iterdir())) == 2


def test_images_can_be_listed_and_deleted(tmp_path):
    store = DirImageStore(tmp_path / "images", max_images=2)
    assert store.ids() == []
    first, second = store.save(PNG, "image/png"), store.save(PNG, "image/png")
    assert sorted(store.ids()) == sorted([first, second])
    store.delete(first)
    assert store.ids() == [second] and store.get(first) is None
    store.delete(first)  # deleting what is gone is not an error
    store.delete("../studio.json")  # nor is an ID that could never have been saved
    assert store.save(PNG, "image/png") != second, "space was freed"
