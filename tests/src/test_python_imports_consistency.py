"""Test that Python imports in ``src/`` have matching ``PYTHON_REQUIREMENTS`` entries.

Reads ``PYTHON_REQUIREMENTS`` from ``src/magic.ts``, walks all Python files in
``src/``, and asserts that every unconditional third-party import corresponds
to a defined requirement.
"""

from __future__ import annotations

import ast
import json
import sys
from collections.abc import Set
from os import PathLike

import pytest
from anyio import Path
from asyncstdlib.builtins import sorted as a_sorted
from typing_extensions import override

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


async def _read_python_requirements() -> Set[str]:
    """Read pip-package names from ``src/python-requirements.json``.

    The JSON is the single source of truth for Python requirement names
    and is consumed by both ``magic.ts`` and this test.
    """
    path = Path(__file__).parents[2] / "src" / "python-requirements.json"
    data = json.loads(await path.read_text("utf-8"))
    return set(data.keys())


class ImportGuardAnalyzer(ast.NodeVisitor):
    """AST visitor that classifies imports as guarded or unguarded in one pass.

    Tracks the parent chain during traversal so each ``import`` or ``from
    … import`` statement can determine whether it sits inside a recognised
    guard block.

    Guard patterns that suppress the "unguarded" classification:

    ==============================  =============================================
    Pattern                         Example
    ==============================  =============================================
    ``try/except ImportError``      ``try:\n    import foo\nexcept ImportError:\n    ...``
    ``try/except ModuleNotFoundError``  ``try:\n    import foo\nexcept ModuleNotFoundError:\n    ...``
    Bare ``except:``                ``try:\n    import foo\nexcept:\n    ...``
    ``if TYPE_CHECKING:``           ``if TYPE_CHECKING:\n    import foo``
    ``if sys.platform ==/!=``       ``if sys.platform == \"win32\":\n    import foo``
    ==============================  =============================================
    """

    _IMPORT_ERROR_NAMES: frozenset[str] = frozenset(
        {"ImportError", "ModuleNotFoundError"}
    )

    def __init__(self) -> None:
        """Initialise an empty analyzer with no parents and empty sets."""
        self._parents: list[ast.AST] = []
        self.unguarded: set[str] = set()
        self.guarded: set[str] = set()

    @override
    def generic_visit(self, node: ast.AST) -> None:
        """Track parent chain and recurse."""
        self._parents.append(node)
        super().generic_visit(node)
        self._parents.pop()

    # -- Guard detection ---------------------------------------------------

    def _is_in_guard(self) -> bool:
        """Return ``True`` when the current position is inside a recognised guard."""
        for parent in reversed(self._parents):
            if isinstance(parent, ast.Try):
                if any(
                    handler.type is None or self._catches_import_error(handler.type)
                    for handler in parent.handlers
                ):
                    return True
            elif isinstance(parent, ast.If):
                if self._is_type_checking_test(parent) or self._is_platform_test(
                    parent
                ):
                    return True
        return False

    @classmethod
    def _catches_import_error(cls, exception_type: ast.expr | None) -> bool:
        """Return ``True`` when *exception_type* names an import-related error.

        Handles ``ast.Name`` (bare ``ImportError`` / ``ModuleNotFoundError``),
        ``ast.Tuple`` (e.g. ``(ValueError, ImportError)``), ``ast.Attribute``
        (e.g. ``builtins.ImportError``), and ``None`` (bare ``except:``).
        """
        if exception_type is None:
            return True  # bare except:
        if isinstance(exception_type, ast.Name):
            return exception_type.id in cls._IMPORT_ERROR_NAMES
        if isinstance(exception_type, ast.Tuple):
            return any(
                isinstance(el, ast.Name) and el.id in cls._IMPORT_ERROR_NAMES
                for el in exception_type.elts
            )
        if isinstance(exception_type, ast.Attribute):
            return exception_type.attr in cls._IMPORT_ERROR_NAMES
        return False

    @staticmethod
    def _is_type_checking_test(node: ast.If) -> bool:
        """Return ``True`` when *node* is an ``if TYPE_CHECKING:`` guard."""
        return isinstance(node.test, ast.Name) and node.test.id == "TYPE_CHECKING"

    @staticmethod
    def _is_platform_test(node: ast.If) -> bool:
        """Return ``True`` when *node* tests ``sys.platform``."""
        if not isinstance(node.test, ast.Compare):
            return False
        return ImportGuardAnalyzer._is_platform_left(node.test.left)

    @staticmethod
    def _is_platform_left(node: ast.expr) -> bool:
        """Return ``True`` when *node* is ``sys.platform`` (attribute chain)."""
        return (
            isinstance(node, ast.Attribute)
            and node.attr == "platform"
            and isinstance(node.value, ast.Name)
            and node.value.id == "sys"
        )

    # -- Import extraction -------------------------------------------------

    @staticmethod
    def _extract_import_names(
        node: ast.Import | ast.ImportFrom,
    ) -> set[str]:
        """Extract top-level package names from an import statement."""
        if isinstance(node, ast.Import):
            return {alias.name.split(".")[0] for alias in node.names}
        if isinstance(node, ast.ImportFrom) and node.module is not None:
            return {node.module.split(".")[0]}
        return set()

    # -- Visitors ----------------------------------------------------------

    @override
    def visit_Import(self, node: ast.Import) -> None:
        """Classify a bare ``import`` statement."""
        names = self._extract_import_names(node)
        (self.unguarded if not self._is_in_guard() else self.guarded).update(names)

    @override
    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        """Classify a ``from … import`` statement."""
        names = self._extract_import_names(node)
        (self.unguarded if not self._is_in_guard() else self.guarded).update(names)


async def _get_unconditional_third_party_imports(
    root: PathLike[str],
) -> dict[PathLike[str], set[str]]:
    """Walk *root*, returning unconditional third-party imports per file.

    For each ``.py`` file under *root*:
      1. Parse the file into an AST.
      2. Run ``ImportGuardAnalyzer`` to separate guarded from unguarded imports.
      3. Subtract stdlib and intra-project modules from the unguarded set.
    """
    result: dict[PathLike[str], set[str]] = {}
    for py_file in await a_sorted(Path(root).rglob("*.py")):
        tree = ast.parse(await Path(py_file).read_text("utf-8"), filename=str(py_file))
        analyzer = ImportGuardAnalyzer()
        analyzer.visit(tree)
        unguarded_third_party = (
            analyzer.unguarded - _STDLIB_MODULE_NAMES - _INTRA_PROJECT_MODULES
        )
        if unguarded_third_party:
            result[Path(py_file)] = unguarded_third_party
    return result


# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_python_requirements_consistency() -> None:
    """Every unconditional third-party Python import needs a ``PYTHON_REQUIREMENTS`` entry."""
    src_root = Path(__file__).parents[2] / "src"
    requirements = await _read_python_requirements()
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
