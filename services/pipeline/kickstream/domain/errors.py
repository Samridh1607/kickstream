class Refusal(Exception):
    """A change the server refuses. `status` is the HTTP status it maps to.

    Stages raise their own subclass; the composition root turns any of them into one
    response shape, so clients read refusals the same way everywhere.
    """

    def __init__(self, status: int, field: str, message: str, retry_after: int | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.field = field
        self.message = message
        self.retry_after = retry_after
