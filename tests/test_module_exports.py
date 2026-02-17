"""Tests that every module declares a module-level `__all__` tuple.

This test parses the AST of Python modules to avoid executing top-level code.
It asserts that each `.py` file under `src/` and relevant `tests/` files
contains a top-level assignment to `__all__` where the value is a `tuple`
containing only string constants.

Rules enforced:
- `__all__` must be present at module top-level.
- The assigned value must be a `tuple` (not a `list`).
- Each element of the tuple must be a string constant.

This follows repository policy: explicit export lists help make the public
surface self-documenting and avoid accidental exports.
"""

import ast

import pytest
from anyio import Path

__all__ = ()

# keep ROOT as an anyio.Path instance (don't await resolve at import time)
ROOT = Path(".")


async def _find_py_files() -> list[Path]:
    """Return a sorted list of Python file paths under `src/` and `tests/`.

    The helper parallels the module traversal used in repository checks and
    is deterministic (sorted) for consistent test output.
    """

    files: list[Path] = []

    async for path in (ROOT / "src").rglob("*.py"):
        files.append(path)
    async for path in (ROOT / "tests").rglob("*.py"):
        files.append(path)
    return sorted(files)


def _has_all_tuple(node: ast.Module) -> tuple[bool, str]:
    """Returns (ok, message)."""
    for stmt in node.body:
        # look for Assign or AnnAssign to __all__
        if isinstance(stmt, ast.Assign):
            for target in stmt.targets:
                if isinstance(target, ast.Name) and target.id == "__all__":
                    val = stmt.value
                    if isinstance(val, ast.Tuple):
                        # ensure all elements are string constants
                        for elt in val.elts:
                            if not (
                                isinstance(elt, ast.Constant)
                                and isinstance(elt.value, str)
                            ):
                                return (
                                    False,
                                    "__all__ must contain only string constants",
                                )
                        return True, "OK"
                    else:
                        return (
                            False,
                            "__all__ must be a tuple (not a list or other type)",
                        )
        elif isinstance(stmt, ast.AnnAssign):
            # unlikely but handle annotated assignment: __all__: tuple[str, ...] = (...)
            target = stmt.target
            if isinstance(target, ast.Name) and target.id == "__all__":
                val = stmt.value
                if isinstance(val, ast.Tuple):
                    for elt in val.elts:
                        if not (
                            isinstance(elt, ast.Constant) and isinstance(elt.value, str)
                        ):
                            return False, "__all__ must contain only string constants"
                    return True, "OK"
                else:
                    return False, "__all__ must be a tuple (not a list or other type)"
    return False, "__all__ not found"


@pytest.mark.asyncio
async def test_all_tuple_present_and_is_tuple() -> None:
    """Assert that every module declares `__all__` as a tuple of strings.

    The test parses AST for each file and reports per-file failures for
    missing or malformed `__all__` assignments.
    """

    failures: list[str] = []

    for path in await _find_py_files():
        # ignore compiled or cache files (shouldn't be any), and exclude vendored/third-party code
        text = await path.read_text(encoding="utf-8")
        try:
            node = ast.parse(text, filename=path)
        except SyntaxError as exc:
            failures.append(f"{path}: SyntaxError: {exc}")
            continue

        ok, msg = _has_all_tuple(node)
        if not ok:
            failures.append(f"{path}: {msg}")

    if failures:
        joined = "\n".join(failures)
        raise AssertionError(f"__all__ compliance failures:\n{joined}")


@pytest.mark.asyncio
async def test___all___follows_top_level_imports() -> None:
    """Ensure `__all__` assignment appears after top-level imports.

    For each module, locate the last top-level `import`/`from ... import`
    statement and ensure the earliest `__all__` assignment comes after it.
    This prevents reordering issues where `__all__` is defined before
    imports (which can hide symbols or cause import-time surprises).
    """

    failures: list[str] = []

    for path in await _find_py_files():
        text = await path.read_text(encoding="utf-8")
        try:
            node = ast.parse(text, filename=path)
        except SyntaxError as exc:
            failures.append(f"{path}: SyntaxError: {exc}")
            continue

        # find line number of the last top-level import (0 if none)
        last_import_lineno = 0
        for stmt in node.body:
            if isinstance(stmt, (ast.Import, ast.ImportFrom)):
                last_import_lineno = max(last_import_lineno, getattr(stmt, "lineno", 0))

        # find all __all__ assignment linenos (if any)
        all_linenos: list[int] = []
        for stmt in node.body:
            if isinstance(stmt, ast.Assign):
                for target in stmt.targets:
                    if isinstance(target, ast.Name) and target.id == "__all__":
                        all_linenos.append(getattr(stmt, "lineno", 0))
            elif isinstance(stmt, ast.AnnAssign):
                target = stmt.target
                if isinstance(target, ast.Name) and target.id == "__all__":
                    all_linenos.append(getattr(stmt, "lineno", 0))

        if not all_linenos:
            # missing __all__ is already reported by the other test
            continue

        first_all_lineno = min(all_linenos)
        if first_all_lineno <= last_import_lineno:
            failures.append(
                f"{path}: __all__ defined at line {first_all_lineno} "
                f"but top-level import at line {last_import_lineno}"
            )

    if failures:
        raise AssertionError("__all__ ordering failures:\n" + "\n".join(failures))
