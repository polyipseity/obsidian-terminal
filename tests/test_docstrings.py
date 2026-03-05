"""Tests that modules, exported public symbols, and top-level variables include docstrings.

This test parses modules' AST to avoid executing top-level code. It enforces
that:

- Every Python module under `src/`, `tests/`, and `scripts/` contains a non-empty
  module-level docstring.
- Every exported function or class (listed in `__all__`) has a non-empty
  docstring.
- Every top-level variable (assignment/constant) has an individual docstring in
  the form of a preceding string-literal expression statement, so constants and
  configuration are documented close to their definitions.
"""

import ast
from collections.abc import Iterator

import pytest
from anyio import Path

"""Public API of this test module (empty: no symbols are exported)."""
__all__ = ()

"""Repository root used by the docstring compliance tests for path discovery."""
ROOT = Path(".")


async def _find_py_files() -> list[Path]:
    """Return a sorted list of Python file paths under `src/`, `tests/`, and `scripts/`.

    Mirrors the traversal used by other repository checks.
    """

    files: list[Path] = []

    async for path in (ROOT / "src").rglob("*.py"):
        files.append(path)
    async for path in (ROOT / "tests").rglob("*.py"):
        files.append(path)
    async for path in (ROOT / "scripts").rglob("*.py"):
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


def _iter_assignments_in_body(
    body: list[ast.stmt],
) -> Iterator[tuple[str, list[ast.stmt], int]]:
    """Yield (variable name, body, index) for assignments in body and nested blocks.

    Recurses into If/For/While/With/Try/Match bodies (and orelse/finalbody etc.)
    but does not recurse into FunctionDef or ClassDef, so only module-level and
    control-flow-block-level assignments are included.
    """
    for idx, stmt in enumerate(body):
        if isinstance(stmt, ast.Assign):
            for target in stmt.targets:
                if isinstance(target, ast.Name):
                    yield target.id, body, idx
        elif isinstance(stmt, ast.AnnAssign):
            target = stmt.target
            if isinstance(target, ast.Name):
                yield target.id, body, idx
        elif isinstance(stmt, ast.If):
            yield from _iter_assignments_in_body(stmt.body)
            if stmt.orelse:
                yield from _iter_assignments_in_body(stmt.orelse)
        elif isinstance(stmt, (ast.For, ast.AsyncFor)):
            yield from _iter_assignments_in_body(stmt.body)
            if stmt.orelse:
                yield from _iter_assignments_in_body(stmt.orelse)
        elif isinstance(stmt, ast.While):
            yield from _iter_assignments_in_body(stmt.body)
            if stmt.orelse:
                yield from _iter_assignments_in_body(stmt.orelse)
        elif isinstance(stmt, (ast.With, ast.AsyncWith)):
            yield from _iter_assignments_in_body(stmt.body)
        elif isinstance(stmt, ast.Try):
            yield from _iter_assignments_in_body(stmt.body)
            for handler in stmt.handlers:
                yield from _iter_assignments_in_body(handler.body)
            if stmt.orelse:
                yield from _iter_assignments_in_body(stmt.orelse)
            if stmt.finalbody:
                yield from _iter_assignments_in_body(stmt.finalbody)
        elif isinstance(stmt, ast.Match):
            for case in stmt.cases:
                yield from _iter_assignments_in_body(case.body)
        # Do not recurse into FunctionDef, AsyncFunctionDef, ClassDef


def _iter_top_level_assignments(
    node: ast.Module,
) -> Iterator[tuple[str, list[ast.stmt], int]]:
    """Yield (variable name, body, index) for top-level assignments.

    Includes assignments inside if/for/while/with/try/match (any nesting) as long
    as they are not inside a def or class. Covers both `Assign` and `AnnAssign`
    targets that bind a `Name`.
    """
    yield from _iter_assignments_in_body(node.body)


def _get_assignment_docstring(body: list[ast.stmt], stmt_index: int) -> str | None:
    """Return the docstring for an assignment in a body, if present.

    A variable's docstring is defined as the immediately preceding expression
    statement in the same body whose value is a string literal. This mirrors
    how function and class docstrings are represented in the AST.
    """
    if stmt_index == 0:
        return None

    prev_stmt = body[stmt_index - 1]
    if (
        isinstance(prev_stmt, ast.Expr)
        and isinstance(prev_stmt.value, ast.Constant)
        and isinstance(prev_stmt.value.value, str)
    ):
        doc = prev_stmt.value.value
        return doc if doc.strip() else None

    return None


@pytest.mark.anyio
async def test_modules_and_exported_objects_have_docstrings() -> None:
    """Assert each module and its exported/top-level objects have docstrings.

    In addition to checking module-level and exported function/class docstrings,
    this test asserts that every top-level variable has an individual docstring
    given by a preceding string-literal expression statement.
    """

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

        # ensure that every top-level assignment/constant has its own docstring
        # represented as a preceding string-literal expression statement
        for var_name, body, stmt_index in _iter_top_level_assignments(node):
            doc = _get_assignment_docstring(body, stmt_index)
            if doc is None:
                failures.append(
                    f"{path}: top-level variable {var_name!r} is missing a docstring"
                )

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


@pytest.mark.anyio
async def test_all_top_level_definitions_have_docstrings() -> None:
    """Assert every top-level API surface is documented.

    This enforces that all top-level `def`/`class` objects in modules under
    `src/`, `tests/`, and `scripts/` include non-empty docstrings — private and public
    symbols alike — and that every top-level variable has an individual
    docstring in the form of a preceding string-literal expression.
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

        # ensure that every top-level assignment/constant has its own docstring
        for var_name, body, stmt_index in _iter_top_level_assignments(node):
            doc = _get_assignment_docstring(body, stmt_index)
            if doc is None:
                failures.append(
                    f"{path}: top-level variable {var_name!r} is missing a docstring"
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


@pytest.mark.anyio
async def test_all_defs_at_any_depth_have_docstrings() -> None:
    """Assert every function/class (at any nesting level) has a docstring.

    This enforces docstrings for class methods, nested (inner) functions,
    and nested classes across `src/`, `tests/`, and `scripts/`. It applies to private and
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
