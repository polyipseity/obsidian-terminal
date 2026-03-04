"""Tests that verify the AnyIO pytest plugin is set up correctly.

These helpers exercise the fixtures defined in ``tests/conftest.py`` and
provide a simple sanity check that the backend is configured as expected.
"""

__all__ = ()


def test_anyio_backend_name(anyio_backend_name: str):
    """The backend name fixture should always be ``"asyncio"``."""
    assert anyio_backend_name == "asyncio"


def test_anyio_backend_options(anyio_backend_options: dict[str, object]):
    """The options fixture should enable uvloop."""
    assert anyio_backend_options.get("use_uvloop") is True
