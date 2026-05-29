"""Tests for ``src/terminal/win32_resizer.py``.

These tests focus on behavior and module metadata that are stable across
platforms, while still validating the Windows-only entrypoint contract.
"""

from __future__ import annotations

import ast
import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

"""Public API of this test module (empty)."""
__all__ = ()


def _module_path() -> Path:
    """Return the filesystem path to the target source module."""
    return Path(__file__).parents[3] / "src/terminal/win32_resizer.py"


def _module_ast() -> ast.Module:
    """Parse and return the AST of the target source module."""
    return ast.parse(_module_path().read_text(encoding="utf-8"))


def _find_top_level_assign_value(node: ast.Module, name: str) -> ast.AST | None:
    """Return the assigned value node for a top-level variable, if present."""
    for stmt in node.body:
        if isinstance(stmt, ast.Assign):
            for target in stmt.targets:
                if isinstance(target, ast.Name) and target.id == name:
                    return stmt.value
        elif isinstance(stmt, ast.AnnAssign):
            target = stmt.target
            if isinstance(target, ast.Name) and target.id == name:
                return stmt.value
    return None


def _first_top_level_function(node: ast.Module, name: str) -> ast.FunctionDef | None:
    """Return the first top-level function definition with the given name."""
    for stmt in node.body:
        if isinstance(stmt, ast.FunctionDef) and stmt.name == name:
            return stmt
    return None


def _load_module() -> ModuleType:
    """Load the target module from source for deterministic assertions."""
    path = _module_path()
    spec = importlib.util.spec_from_file_location("tests_win32_resizer_module", path)
    if spec is None or spec.loader is None:
        raise AssertionError(path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_module_declares_expected_public_api_names() -> None:
    """`__all__` should list the documented public API surface."""
    node = _module_ast()
    all_node = _find_top_level_assign_value(node, "__all__")
    assert isinstance(all_node, ast.Tuple)
    all_values = ast.literal_eval(all_node)
    assert all_values == (
        "main",
        "win_to_pid",
        "resizer",
        "resizer_reader",
        "resizer_writer",
    )


def test_module_constants_have_expected_types_and_ranges() -> None:
    """Timing and iteration constants should remain sane and positive."""
    node = _module_ast()
    retry_interval = _find_top_level_assign_value(node, "_LOOKUP_RETRY_INTERVAL")
    retries = _find_top_level_assign_value(node, "_LOOKUP_RETRIES")
    resize_iterations = _find_top_level_assign_value(node, "_RESIZE_ITERATIONS")

    assert retry_interval is not None
    retry_interval_value = ast.literal_eval(retry_interval)
    assert isinstance(retry_interval_value, (int, float))
    assert retry_interval_value > 0

    assert retries is not None
    retries_value = ast.literal_eval(retries)
    assert isinstance(retries_value, int)
    assert retries_value > 0

    assert resize_iterations is not None
    resize_iterations_value = ast.literal_eval(resize_iterations)
    assert isinstance(resize_iterations_value, int)
    assert resize_iterations_value > 0


def test_non_windows_main_stub_raises_not_implemented() -> None:
    """The top-level (non-Windows) `main` stub should raise NotImplementedError."""
    node = _module_ast()
    main_func = _first_top_level_function(node, "main")
    assert main_func is not None

    # Body shape: [docstring Expr, Raise(NotImplementedError(sys.platform))]
    assert len(main_func.body) >= 2
    raise_stmt = main_func.body[1]
    assert isinstance(raise_stmt, ast.Raise)
    assert isinstance(raise_stmt.exc, ast.Call)
    assert isinstance(raise_stmt.exc.func, ast.Name)
    assert raise_stmt.exc.func.id == "NotImplementedError"


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only runtime import")
def test_module_imports_on_windows_and_exports_callables() -> None:
    """On Windows, the module should import and expose callable public API."""
    module = _load_module()
    assert callable(module.main)
    assert callable(module.win_to_pid)
    assert callable(module.resizer)
    assert callable(module.resizer_reader)
    assert callable(module.resizer_writer)
