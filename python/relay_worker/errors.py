class WorkerError(Exception):
    """An error whose message is safe and useful to show to the user."""

    def __init__(self, message, code="failed"):
        super().__init__(message)
        self.code = code
