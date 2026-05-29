"""Tests for ``src/terminal/win32_resizer.py``.

These tests focus on behavior and module metadata that are stable across
platforms, while still validating the Windows-only entrypoint contract.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

"""Public API of this test module (empty)."""
__all__ = ()


def _load_module() -> ModuleType:
    """Load the target module from source for deterministic assertions."""
    path = Path(__file__).parents[3] / "src/terminal/win32_resizer.py"
    spec = importlib.util.spec_from_file_location("tests_win32_resizer_module", path)
    if spec is None or spec.loader is None:
        raise AssertionError(path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_module_declares_expected_public_api_names() -> None:
    """`__all__` should list the documented public API surface."""
    module = _load_module()
    assert module.__all__ == (
        "main",
        "win_to_pid",
        "resizer",
        "resizer_reader",
        "resizer_writer",
    )


def test_module_constants_have_expected_types_and_ranges() -> None:
    """Timing and iteration constants should remain sane and positive."""
    module = _load_module()
    assert isinstance(module._LOOKUP_RETRY_INTERVAL, (int, float))
    assert module._LOOKUP_RETRY_INTERVAL > 0
    assert isinstance(module._LOOKUP_RETRIES, int)
    assert module._LOOKUP_RETRIES > 0
    assert isinstance(module._RESIZE_ITERATIONS, int)
    assert module._RESIZE_ITERATIONS > 0


@pytest.mark.skipif(sys.platform == "win32", reason="non-Windows behavior only")
def test_main_raises_not_implemented_outside_windows() -> None:
    """On non-Windows platforms `main` should fail with NotImplementedError."""
    module = _load_module()
    with pytest.raises(NotImplementedError) as raised:
        module.main()
    assert raised.value.args == (sys.platform,)
