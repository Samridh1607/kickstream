from kickstream.ports.match_source import SourceFailure, SourceUnavailable


def test_a_source_failure_carries_the_message_and_when_to_retry():
    failure = SourceFailure("Today's 100 free requests are used up.", retry_after=3600)
    assert str(failure) == failure.message and failure.retry_after == 3600
    assert isinstance(SourceUnavailable("Set the key."), SourceFailure)


def test_a_source_failure_without_a_wait_has_no_retry_time():
    assert SourceUnavailable("Set the key.").retry_after is None
