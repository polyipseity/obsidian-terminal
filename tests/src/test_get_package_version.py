"""Tests for ``src/get_package_version.py``.

These tests validate output formatting and error handling in the package
version helper.
"""

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest

"""Public API of this test module (empty)."""
__all__ = ()


def _load_module() -> ModuleType:
    """Load the target module from source for isolated monkeypatching."""
    path = Path(__file__).parents[2] / "src/get_package_version.py"
    spec = importlib.util.spec_from_file_location(
        "tests_get_package_version_module", path
    )
    if spec is None or spec.loader is None:
        raise AssertionError(path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_main_prints_version_for_existing_package(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`main` should print `<package> <version>` when lookup succeeds."""
    module = _load_module()
    monkeypatch.setattr(module, "version", lambda _pkg: "1.2.3")

    module.main(["prog", "demo-package"])

    assert capsys.readouterr().out == "demo-package 1.2.3\n"


def test_main_prints_empty_version_for_missing_package(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`main` should print an empty version when package lookup fails."""
    module = _load_module()

    def fail(_pkg: str) -> str:
        """Raise the same error type used for package-missing cases."""
        raise module.PackageNotFoundError

    monkeypatch.setattr(module, "version", fail)

    module.main(["prog", "does-not-exist"])

    assert capsys.readouterr().out == "does-not-exist \n"


def test_main_prints_empty_fields_when_no_package_name_provided(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """`main` should handle empty argv payloads safely."""
    module = _load_module()
    module.main(["prog"])
    assert capsys.readouterr().out == " \n"
