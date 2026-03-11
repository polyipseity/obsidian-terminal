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

from __future__ import annotations

import ast
from collections.abc import AsyncIterator, Iterator

import pytest
from anyio import Path

"""Public API of this test module (empty: no symbols are exported)."""
__all__ = ()

"""Glob patterns relative to the repository root. Only files matching an
include pattern and no exclude pattern are considered candidates."""
_GLOB_SPEC = """
.agents/skills/**/*.py
src/**/*.py
tests/**/*.py
scripts/**/*.py
"""


def _iter_glob_patterns(spec: str) -> Iterator[tuple[str, bool]]:
    """Parse a gitignore-style, multi-line glob specification.

    The ``spec`` string is interpreted as a sequence of lines applied from
    top to bottom. Empty lines and lines starting with ``#`` are ignored.
    Lines beginning with ``!`` are treated as exclusions.  The function
    yields ``(pattern, is_exclude)`` pairs in the original order.
    """
    for raw in spec.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        is_exclude = line.startswith("!")
        pattern = line[1:] if is_exclude else line
        if not pattern:
            continue
        yield pattern, is_exclude


async def _find_py_files() -> list[Path]:
    """Return sorted Python file paths matching ``_GLOB_SPEC``.

    The helper is intentionally very similar to ``_get_candidate_files`` in
    :mod:`tests.test_git_executable` with the only difference being that this
    function returns a list instead of yielding an iterator.  Keeping the
    implementations in each file avoids a separate shared module and is fine
    per the refactoring instructions.
    """
    root = Path(__file__).parent.parent  # repo root
    yielded: set[Path] = set()
    result: list[Path] = []

    async def _iter_files(pattern: str) -> AsyncIterator[Path]:
        """Yield all files matching the given glob pattern, relative to the repo root."""
        async for p in root.glob(pattern):
            if await p.is_file():
                yield p

    for pattern, is_exclude in _iter_glob_patterns(_GLOB_SPEC):
        if is_exclude:
            async for p in root.glob(pattern):
                yielded.discard(p)
                if p in result:
                    result.remove(p)
        else:
            async for p in _iter_files(pattern):
                if p not in yielded:
                    yielded.add(p)
                    result.append(p)
    return sorted(result)


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
    body: list[ast.stmt], is_module: bool = False
) -> Iterator[tuple[str, list[ast.stmt], int, bool]]:
    """Yield (variable name, body, index, is_module) for assignments.

    ``is_module`` is True only when ``body`` is the top-level module body.
    Nested blocks (if/for/while/with/try/match etc.) are visited recursively
    with ``is_module`` forced to False.  This allows callers to distinguish
    between the real module-level docstring and ordinary string literals used as
    variable comments.
    """
    for idx, stmt in enumerate(body):
        if isinstance(stmt, ast.Assign):
            for target in stmt.targets:
                if isinstance(target, ast.Name):
                    yield target.id, body, idx, is_module
        elif isinstance(stmt, ast.AnnAssign):
            target = stmt.target
            if isinstance(target, ast.Name):
                yield target.id, body, idx, is_module
        elif isinstance(stmt, ast.If):
            yield from _iter_assignments_in_body(stmt.body, False)
            if stmt.orelse:
                yield from _iter_assignments_in_body(stmt.orelse, False)
        elif isinstance(stmt, (ast.For, ast.AsyncFor)):
            yield from _iter_assignments_in_body(stmt.body, False)
            if stmt.orelse:
                yield from _iter_assignments_in_body(stmt.orelse, False)
        elif isinstance(stmt, ast.While):
            yield from _iter_assignments_in_body(stmt.body, False)
            if stmt.orelse:
                yield from _iter_assignments_in_body(stmt.orelse, False)
        elif isinstance(stmt, (ast.With, ast.AsyncWith)):
            yield from _iter_assignments_in_body(stmt.body, False)
        elif isinstance(stmt, ast.Try):
            yield from _iter_assignments_in_body(stmt.body, False)
            for handler in stmt.handlers:
                yield from _iter_assignments_in_body(handler.body, False)
            if stmt.orelse:
                yield from _iter_assignments_in_body(stmt.orelse, False)
            if stmt.finalbody:
                yield from _iter_assignments_in_body(stmt.finalbody, False)
        # Note: match statements are not supported in Python 3.9 and were not added until 3.10, so we can skip them for now and add support if/when we drop 3.9 support.
        """
        elif isinstance(stmt, ast.Match):
            for case in stmt.cases:
                yield from _iter_assignments_in_body(case.body, False)
        """
        # Do not recurse into FunctionDef, AsyncFunctionDef, ClassDef


def _iter_top_level_assignments(
    node: ast.Module,
) -> Iterator[tuple[str, list[ast.stmt], int, bool]]:
    """Yield (variable name, body, index, is_module) for top-level assignments.

    The returned ``is_module`` flag is ``True`` only when the assignment occurs
    directly in ``node.body`` (i.e. the true module scope).
    """
    yield from _iter_assignments_in_body(node.body, True)


def _get_assignment_docstring(
    body: list[ast.stmt],
    stmt_index: int,
    is_module: bool = False,
) -> str | None:
    """Return the docstring for an assignment in a body, if present.

    A variable's docstring is defined as the immediately preceding expression
    statement in the same body whose value is a string literal. This mirrors
    how function and class docstrings are represented in the AST.

    The ``is_module`` flag signals that ``body`` is the module's top-level
    body.  When ``is_module`` is ``True`` we special‑case the first statement in
    the file: if an assignment immediately follows a string-expression it is
    considered part of the *module* docstring rather than the variable's own
    docstring, regardless of the literal's contents.  This avoids relying on
    comparing text (which could differ after normalization) and correctly
    handles files where the first docstring is followed by ``__all__`` or a
    function definition.
    """
    if stmt_index == 0:
        return None

    # first-statement check for module-level bodies
    if is_module and stmt_index == 1:
        prev_stmt = body[0]
        if (
            isinstance(prev_stmt, ast.Expr)
            and isinstance(prev_stmt.value, ast.Constant)
            and isinstance(prev_stmt.value.value, str)
        ):
            return None

    prev_stmt = body[stmt_index - 1]
    if (
        isinstance(prev_stmt, ast.Expr)
        and isinstance(prev_stmt.value, ast.Constant)
        and isinstance(prev_stmt.value.value, str)
    ):
        doc = prev_stmt.value.value
        if not doc.strip():
            return None
        return doc

    return None


# regression test for special-case behavior described in the issue


def test_assignment_immediately_after_module_docstring_is_ignored() -> None:
    """Assignment right after module docstring should not be treated as documented.

    Covers the specific AST-position rule; a sibling test handles the same case
    with a function definition.
    """
    src = '"""module doc"""\nFOO = 1\n'
    node = ast.parse(src)
    assignments = list(_iter_top_level_assignments(node))
    assert assignments == [("FOO", node.body, 1, True)]

    # module-level special case
    assert _get_assignment_docstring(node.body, 1, is_module=True) is None
    # non-module behaviour still returns the literal
    assert _get_assignment_docstring(node.body, 1, is_module=False) == "module doc"


def test_def_immediately_after_module_docstring_is_flagged() -> None:
    """Ensure a function defined right after the module docstring is *not*
    treated as having that docstring.

    The first test above covered assignments; this one verifies that the same
    problematic layout doesn't trick the function-checking logic.  Future
    refactors should keep this behaviour.
    """
    src = '"""module doc"""\ndef foo():\n    pass\n'
    node = ast.parse(src)
    # foo should be the second statement; ast.get_docstring must return None
    func = node.body[1]
    assert isinstance(func, ast.FunctionDef)
    assert ast.get_docstring(func) is None

    # also verify the exported-object path behaves correctly
    src2 = '"""module doc"""\ndef foo():\n    pass\n__all__ = ("foo",)\n'
    node2 = ast.parse(src2)
    def_node = _find_def_node(node2, "foo")
    assert isinstance(def_node, ast.FunctionDef)
    assert ast.get_docstring(def_node) is None


def test_shebang_and_assignment_are_ignored() -> None:
    """A shebang line before the module docstring should not affect detection.

    There used to be a bug where the shebang counted as a statement and the
    docstring was mis‑attributed to subsequent variables.
    """
    src = '#!/usr/bin/env python\n"""module doc"""\nFOO = 1\n'
    node = ast.parse(src)
    assignments = list(_iter_top_level_assignments(node))
    assert assignments == [("FOO", node.body, 1, True)]
    assert _get_assignment_docstring(node.body, 1, is_module=True) is None


def test_shebang_and_def_are_flagged() -> None:
    """Function after a shebang+module docstring should still have no doc."""
    src = '#!/usr/bin/env python\n"""module doc"""\ndef foo():\n    pass\n'
    node = ast.parse(src)
    func = node.body[1]
    assert isinstance(func, ast.FunctionDef)
    assert ast.get_docstring(func) is None


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
        for var_name, body, stmt_index, is_module in _iter_top_level_assignments(node):
            doc = _get_assignment_docstring(body, stmt_index, is_module=is_module)
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
        for var_name, body, stmt_index, is_module in _iter_top_level_assignments(node):
            doc = _get_assignment_docstring(body, stmt_index, is_module=is_module)
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
