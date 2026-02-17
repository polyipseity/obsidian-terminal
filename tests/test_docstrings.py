"""Tests that modules and exported public symbols include docstrings.

This test parses modules' AST to avoid executing top-level code. It enforces
that:

- Every Python module under `src/` and `tests/` contains a non-empty
  module-level docstring.
- Every exported function or class (listed in `__all__`) has a non-empty
  docstring. Assignments/constants are not required to have individual
  docstrings but should be documented in the module docstring.
"""

import ast
from collections.abc import Iterator

import pytest
from anyio import Path

__all__ = ()

# keep ROOT as an anyio.Path instance (don't await resolve at import time)
ROOT = Path(".")


async def _find_py_files() -> list[Path]:
    """Return a sorted list of Python file paths under `src/` and `tests`.

    Mirrors the traversal used by other repository checks.
    """

    files: list[Path] = []

    async for path in (ROOT / "src").rglob("*.py"):
        files.append(path)
    async for path in (ROOT / "tests").rglob("*.py"):
        files.append(path)
    return sorted(files)


def _extract_all_tuple(node: ast.Module) -> tuple[str, ...] | None:
    """Parse a module AST and return the `__all__` tuple of names, if present.

    Returns None if `__all__` is not present or cannot be statically determined
    as a tuple of string constants.
    """

    for stmt in node.body:
        if isinstance(stmt, ast.Assign):
            for target in stmt.targets:
                if isinstance(target, ast.Name) and target.id == "__all__":
                    val = stmt.value
                    if isinstance(val, ast.Tuple):
                        try:
                            names = tuple(
                                elt.value
                                for elt in val.elts
                                if isinstance(elt, ast.Constant)
                                and isinstance(elt.value, str)
                            )
                        except Exception:
                            return None
                        if len(names) == len(val.elts):
                            return names
        elif isinstance(stmt, ast.AnnAssign):
            target = stmt.target
            if isinstance(target, ast.Name) and target.id == "__all__":
                val = stmt.value
                if isinstance(val, ast.Tuple):
                    try:
                        names = tuple(
                            elt.value
                            for elt in val.elts
                            if isinstance(elt, ast.Constant)
                            and isinstance(elt.value, str)
                        )
                    except Exception:
                        return None
                    if len(names) == len(val.elts):
                        return names
    return None


def _find_def_node(node: ast.Module, name: str) -> ast.AST | None:
    """Find a top-level definition node (FunctionDef/ClassDef) for `name`.

    Returns None if not found or the name corresponds to an assignment.
    """

    for stmt in node.body:
        if (
            isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            and stmt.name == name
        ):
            return stmt
        if isinstance(stmt, ast.Assign):
            for targ in stmt.targets:
                if isinstance(targ, ast.Name) and targ.id == name:
                    return stmt
    return None


@pytest.mark.asyncio
async def test_modules_and_exported_objects_have_docstrings() -> None:
    """Assert each module has a docstring and exported functions/classes have docstrings."""

    failures: list[str] = []

    for path in await _find_py_files():
        text = await path.read_text(encoding="utf-8")
        try:
            node = ast.parse(text, filename=path)
        except SyntaxError as exc:
            failures.append(f"{path}: SyntaxError: {exc}")
            continue

        # module docstring
        mod_doc = ast.get_docstring(node)
        if not (isinstance(mod_doc, str) and mod_doc.strip()):
            failures.append(f"{path}: missing module-level docstring")
            continue

        exported = _extract_all_tuple(node)
        if not exported:
            # no explicit exports — nothing to check for individual docstrings
            continue

        for name in exported:
            def_node = _find_def_node(node, name)
            if def_node is None:
                # exported name may be a re-export or constant; skip
                continue
            if isinstance(
                def_node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
            ):
                if not ast.get_docstring(def_node):
                    failures.append(f"{path}: exported {name!r} is missing a docstring")

    if failures:
        raise AssertionError("Docstring compliance failures:\n" + "\n".join(failures))


@pytest.mark.asyncio
async def test_all_top_level_definitions_have_docstrings() -> None:
    """Assert every top-level function/class has a docstring.

    This enforces that all top-level `def`/`class` objects in modules
    under `src/` and `tests/` include non-empty docstrings — private
    and public symbols alike.
    """

    failures: list[str] = []

    for path in await _find_py_files():
        text = await path.read_text(encoding="utf-8")
        try:
            node = ast.parse(text, filename=path)
        except SyntaxError as exc:
            failures.append(f"{path}: SyntaxError: {exc}")
            continue

        for stmt in node.body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                name = getattr(stmt, "name", "<unknown>")
                doc = ast.get_docstring(stmt)
                if not (isinstance(doc, str) and doc.strip()):
                    failures.append(
                        f"{path}: top-level {name!r} is missing a docstring"
                    )

    if failures:
        raise AssertionError("Top-level docstring failures:\n" + "\n".join(failures))


def _iter_function_and_class_nodes(
    node: ast.AST,
) -> Iterator[ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef]:
    """Yield every FunctionDef/AsyncFunctionDef/ClassDef node at any depth.

    This walks the AST recursively to find nested functions, methods, and
    nested classes so tests can assert docstrings for non-top-level defs.
    """

    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            yield child
            # recurse into the child to find nested defs inside it
            yield from _iter_function_and_class_nodes(child)
        else:
            yield from _iter_function_and_class_nodes(child)


@pytest.mark.asyncio
async def test_all_defs_at_any_depth_have_docstrings() -> None:
    """Assert every function/class (at any nesting level) has a docstring.

    This enforces docstrings for class methods, nested (inner) functions,
    and nested classes across `src/` and `tests/`. It applies to private and
    dunder names as well (per current request).
    """

    failures: list[str] = []

    for path in await _find_py_files():
        text = await path.read_text(encoding="utf-8")
        try:
            node = ast.parse(text, filename=path)
        except SyntaxError as exc:
            failures.append(f"{path}: SyntaxError: {exc}")
            continue

        for def_node in _iter_function_and_class_nodes(node):
            if isinstance(def_node, ast.ClassDef):
                name = def_node.name
                doc = ast.get_docstring(def_node)
                if not (isinstance(doc, str) and doc.strip()):
                    failures.append(f"{path}: class {name!r} is missing a docstring")
            else:
                # FunctionDef or AsyncFunctionDef (methods and nested functions)
                name = getattr(def_node, "name", "<unknown>")
                doc = ast.get_docstring(def_node)
                if not (isinstance(doc, str) and doc.strip()):
                    failures.append(
                        f"{path}: function {name!r} (nested/method) is missing a docstring"
                    )

    if failures:
        raise AssertionError(
            "Nested-definition docstring failures:\n" + "\n".join(failures)
        )
