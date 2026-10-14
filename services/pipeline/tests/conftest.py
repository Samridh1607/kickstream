import os
import urllib.request

import pytest


@pytest.fixture(autouse=True)
def no_internet(monkeypatch, request):
    """The default suite never reaches the internet; adapters are tested with recorded responses."""
    if request.node.get_closest_marker("network"):
        return

    def refuse(*args, **kwargs):
        raise AssertionError("a test tried to use the internet")

    monkeypatch.setattr(urllib.request, "urlopen", refuse)


@pytest.fixture(autouse=True)
def no_developer_settings(monkeypatch):
    """The developer's own KICKSTREAM_* settings, keys included, never reach a test."""
    for name in [name for name in os.environ if name.startswith("KICKSTREAM_")]:
        monkeypatch.delenv(name)
