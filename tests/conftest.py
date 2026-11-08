import pytest

from vigil import investigations

_REAL_DEFAULT_STORE = investigations.default_store


@pytest.fixture
def real_default_store():
    """The real store selection, for the one test that checks it."""
    return _REAL_DEFAULT_STORE


@pytest.fixture(autouse=True)
def no_real_checkpoint_store(monkeypatch):
    """Tests must pass their own checkpoint store: the default may be the owner's cloud database."""

    def refuse():
        raise AssertionError("a test reached the real checkpoint store; pass store= explicitly")

    monkeypatch.setattr(investigations, "default_store", refuse)
