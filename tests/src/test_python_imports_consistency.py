"""Test that Python imports in ``src/`` have matching ``PYTHON_REQUIREMENTS`` entries.

Reads ``PYTHON_REQUIREMENTS`` from ``src/magic.ts``, walks all Python files in
``src/``, and asserts that every unconditional third-party import corresponds
to a defined requirement.
"""

import ast
import re
import sys
from collections.abc import Mapping, Set
from os import PathLike

import pytest
from anyio import Path
from asyncstdlib.builtins import sorted as a_sorted

"""Public API of this test module (empty)."""
__all__ = ()

# ---------------------------------------------------------------------------
# stdlib set used as a fallback for Python 3.9, which lacks
# ``sys.stdlib_module_names``.
# ---------------------------------------------------------------------------
"""Stdlib module names, used to filter built-in packages from third-party imports.

On Python 3.10+ this uses ``sys.stdlib_module_names``; on 3.9 it falls back to a
curated set covering all modules imported across ``src/``."""
_STDLIB_MODULE_NAMES: Set[str] = (
    sys.stdlib_module_names  # type: ignore[attr-defined]  # 3.10+
    if hasattr(sys, "stdlib_module_names")
    else frozenset(
        {
            "__future__",
            "abc",
            "collections",
            "contextlib",
            "enum",
            "fcntl",
            "functools",
            "importlib",
            "inspect",
            "io",
            "itertools",
            "json",
            "logging",
            "math",
            "multiprocessing",
            "os",
            "pathlib",
            "platform",
            "pty",
            "re",
            "selectors",
            "shutil",
            "signal",
            "struct",
            "subprocess",
            "sys",
            "tempfile",
            "termios",
            "threading",
            "time",
            "types",
            "typing",
            "uuid",
            "warnings",
            "weakref",
        }
    )
)

"""Module names that live in-tree under ``src/`` and are not pip packages."""
_INTRA_PROJECT_MODULES: Set[str] = frozenset({"get_package_version"})

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _read_python_requirements_keys() -> Set[str]:
    """Extract pip-package key names from ``PYTHON_REQUIREMENTS`` in ``src/magic.ts``.

    Skips ``Python`` (version constraint, not a pip package). Returns a set of
    requirement names that the project explicitly declares.
    """
    path = Path(__file__).parents[2] / "src/magic.ts"
    text = await path.read_text("utf-8")
    match = re.search(
        r"PYTHON_REQUIREMENTS\s*=\s*deepFreeze\(\{(.*?)\}\)",
        text,
        re.DOTALL,
    )
    if match is None:
        raise AssertionError(
            "Could not locate PYTHON_REQUIREMENTS block in src/magic.ts"
        )
    body = match.group(1)
    keys = set[str]()
    for line in body.splitlines():
        line_match = re.match(r"^\s*(\w+)\s*:", line)
        if line_match is not None:
            key = line_match.group(1)
            if key != "Python":
                keys.add(key)
    return keys


def _collect_imports(tree: ast.AST) -> Set[str]:
    """Return the set of top-level third-party package names imported in *tree*."""
    imports = set[str]()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module is not None:
                imports.add(node.module.split(".")[0])
    return imports


def _catches_import_error(exception_type: ast.AST) -> bool:
    """Return ``True`` when *exception_type* references ``ImportError``.

    Handles ``ast.Name`` (bare ``ImportError``), ``ast.Tuple`` (e.g.
    ``(ValueError, ImportError)``), and ``ast.Attribute`` (e.g.
    ``builtins.ImportError``).
    """
    if isinstance(exception_type, ast.Name):
        return exception_type.id == "ImportError"
    if isinstance(exception_type, ast.Tuple):
        return any(
            isinstance(el, ast.Name) and el.id == "ImportError"
            for el in exception_type.elts
        )
    if isinstance(exception_type, ast.Attribute):
        return exception_type.attr == "ImportError"
    return False


def _is_platform_guard(node: ast.AST) -> bool:
    """Return ``True`` when *node* is an ``if sys.platform ==/!= \"...\":`` guard.

    Recognizes both ``==`` and ``!=`` comparisons against ``sys.platform`` with
    any string literal (``\"win32\"``, ``\"linux\"``, ``\"darwin\"``, etc.). These
    are platform-specific guards: imports inside them are effectively conditional.
    """
    if not isinstance(node, ast.If):
        return False
    test = node.test
    if not isinstance(test, ast.Compare):
        return False
    left = test.left
    if not (
        isinstance(left, ast.Attribute)
        and left.attr == "platform"
        and isinstance(left.value, ast.Name)
        and left.value.id == "sys"
    ):
        return False
    # Any comparison (==, !=, in, not in) against sys.platform counts as a guard.
    return any(
        isinstance(comparator, ast.Constant) and isinstance(comparator.value, str)
        for comparator in test.comparators
    )


def _get_guarded_imports(tree: ast.AST) -> Set[str]:
    """Collect imports inside recognised guard blocks.

    The following patterns are considered guards:
    - ``try`` / ``except ImportError`` — the import may fail gracefully.
    - ``if TYPE_CHECKING:`` — the import is only needed for static analysis.
    - ``if sys.platform ==/!= \"...\":`` — platform-specific imports that do not
      apply to all platforms.
    """
    guarded = set[str]()
    for node in ast.walk(tree):
        if isinstance(node, ast.Try):
            for handler in node.handlers:
                if handler.type is not None and _catches_import_error(handler.type):
                    guarded.update(_collect_imports(node))
                    break
        elif isinstance(node, ast.If):
            if (
                isinstance(node.test, ast.Name) and node.test.id == "TYPE_CHECKING"
            ) or _is_platform_guard(node):
                guarded.update(_collect_imports(node))
    return guarded


async def _get_unconditional_third_party_imports(
    root: PathLike[str],
) -> Mapping[PathLike[str], Set[str]]:
    """Walk *root* recursively, returning unconditional third-party imports per file.

    For each ``.py`` file under *root*:
      1. Collect all imports via AST.
      2. Subtract imports guarded by ``try/except ImportError`` or
         ``if TYPE_CHECKING:``.
      3. Filter out stdlib modules (via the fallback set on 3.9).
      4. Filter out intra-project modules.
    """
    result = dict[PathLike[str], Set[str]]()
    for py_file in await a_sorted(Path(root).rglob("*.py")):
        tree = ast.parse(await py_file.read_text("utf-8"), filename=str(py_file))
        all_imports = _collect_imports(tree)
        guarded = _get_guarded_imports(tree)
        unguarded = all_imports - guarded
        third_party = unguarded - _STDLIB_MODULE_NAMES - _INTRA_PROJECT_MODULES
        if third_party:
            result[py_file] = third_party
    return result


# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_python_requirements_consistency() -> None:
    """Every unconditional third-party Python import needs a ``PYTHON_REQUIREMENTS`` entry."""
    src_root = Path(__file__).parents[2] / "src"
    requirements = await _read_python_requirements_keys()
    third_party_imports = await _get_unconditional_third_party_imports(src_root)

    # Verify known-good cases first for readable failure messages.
    assert "psutil" in requirements, (
        "psutil is imported unconditionally in win32_resizer.py "
        "but missing from PYTHON_REQUIREMENTS"
    )
    assert "pywinctl" in requirements, (
        "pywinctl is imported unconditionally in win32_resizer.py "
        "but missing from PYTHON_REQUIREMENTS"
    )

    failures = list[str]()
    for file_path, imports in sorted(third_party_imports.items()):
        rel = Path(file_path).relative_to(src_root.parent)
        missing = sorted(imports - requirements)
        if missing:
            failures.append(
                f"{rel}: missing PYTHON_REQUIREMENTS for {', '.join(missing)}"
            )
    assert not failures, (
        "Unconditional third-party imports without matching PYTHON_REQUIREMENTS "
        "entry:\n" + "\n".join(failures)
    )
