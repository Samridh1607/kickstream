import pytest
from fastapi.testclient import TestClient

from kickstream.adapters.clocks import InstantClock
from kickstream.adapters.fake_rooms import FakeRooms
from kickstream.app import Settings, create_app

PUBLIC = "kick.example"
INDEX = "<!doctype html><title>Kickstream</title>"


@pytest.fixture
def web(tmp_path):
    root = tmp_path / "web"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text(INDEX, encoding="utf-8")
    (root / "assets" / "app.js").write_text("console.log('app')", encoding="utf-8")
    (root / ".env").write_text("SECRET=1", encoding="utf-8")
    (tmp_path / "outside.txt").write_text("outside", encoding="utf-8")
    return root


def client_for(tmp_path, web, **extra) -> TestClient:
    settings = Settings(
        None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data", web_dir=web, **extra
    )
    app = create_app(
        settings,
        clock_factory=lambda speed: InstantClock(),
        match_prefix="m",
        rooms=FakeRooms(now=lambda: 5_000.0),
    )
    return TestClient(app)


def test_the_pipeline_serves_the_built_web_app_with_every_page_falling_back_to_it(tmp_path, web):
    with client_for(tmp_path, web) as client:
        assert client.get("/").text == INDEX
        assert client.get("/assets/app.js").text == "console.log('app')"
        for page in ("/studio", "/broadcasts/b1/studio", "/guest/s3cret", "/match"):
            answer = client.get(page)
            assert answer.status_code == 200 and answer.text == INDEX
            assert answer.headers["cache-control"] == "no-cache"
        assert client.get("/api/broadcasts").status_code == 200
        assert client.get("/api/nothing-here").status_code == 404
        assert client.get("/openapi.json").text == INDEX


def test_only_the_web_app_s_own_visible_files_are_served(tmp_path, web):
    with client_for(tmp_path, web) as client:
        for path in ("/.env", "/assets/../.env", "/..%2Foutside.txt", "/%2e%2e/outside.txt"):
            answer = client.get(path)
            assert "SECRET" not in answer.text and "outside" not in answer.text


def test_on_the_public_host_the_web_app_is_open_and_the_studio_s_routes_are_not(tmp_path, web):
    with client_for(tmp_path, web, public_hosts=(PUBLIC,)) as client:
        proxied = {"host": PUBLIC, "x-forwarded-for": "203.0.113.9"}
        assert client.get("/guest/s3cret", headers=proxied).text == INDEX
        assert client.get("/assets/app.js", headers=proxied).status_code == 200
        assert client.get("/api/broadcasts", headers=proxied).status_code == 404
        assert client.get("/api/studio", headers=proxied).status_code == 404


def test_without_a_web_directory_nothing_but_the_api_is_served(tmp_path):
    settings = Settings(None, None, None, cache_dir=tmp_path / "cache", data_dir=tmp_path / "data")
    app = create_app(settings, clock_factory=lambda speed: InstantClock(), match_prefix="m")
    with TestClient(app) as client:
        assert client.get("/studio").status_code == 404


def test_the_settings_read_the_web_directory_and_the_sign_in_header():
    settings = Settings.from_env(
        {"KICKSTREAM_WEB_DIR": "/app/web", "KICKSTREAM_SIGNED_IN_HEADER": "X-MS-Client-Principal-Id"}
    )
    assert str(settings.web_dir).replace("\\", "/") == "/app/web"
    assert settings.signed_in_header == "x-ms-client-principal-id"
    assert Settings.from_env({}).web_dir is None and Settings.from_env({}).signed_in_header is None
