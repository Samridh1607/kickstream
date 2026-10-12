from kickstream.audience.limits import RateWindow


def test_a_key_is_allowed_up_to_the_limit_within_the_window_then_told_how_long_to_wait():
    window = RateWindow(limit=3, window_s=30)
    assert [window.take("a", 100.0), window.take("a", 101.0), window.take("a", 110.0)] == [None, None, None]
    assert window.take("a", 115.0) == 15, "the oldest of the three leaves the window at 130"
    assert window.take("b", 115.0) is None, "another address is counted separately"
    assert window.take("a", 130.0) is None


def test_a_refused_attempt_does_not_extend_the_wait():
    window = RateWindow(limit=1, window_s=30)
    window.take("a", 100.0)
    assert window.take("a", 110.0) == 20
    assert window.take("a", 120.0) == 10
    assert window.take("a", 130.0) is None


def test_addresses_that_have_gone_quiet_are_forgotten():
    window = RateWindow(limit=2, window_s=30)
    for n in range(500):
        window.take(f"address-{n}", 100.0 + n)
    assert len(window._seen) <= 31
