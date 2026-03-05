"""Shared pytest configuration for asynchronous tests.

The AnyIO plugin is configured here; tests across the repository simply
depend on the ``anyio_backend`` fixture or use ``@pytest.mark.anyio``.
"""

import pytest

"""Public API of this test configuration module (empty)."""
__all__ = ()


@pytest.fixture
def anyio_backend():
    """Return the desired backend for AnyIO-based tests.

    Using a tuple with ``use_uvloop=True`` requests uvloop explicitly.
    AnyIO still handles platform differences (winloop on Windows) automatically.
    """
    return ("asyncio", {"use_uvloop": True})
