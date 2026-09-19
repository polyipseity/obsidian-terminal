"""Tests ensuring scripts under top-level directories are executable.

The helpers here verify that files in configured script folders have the
executable bit set on non-Windows platforms and that git's index marks them
appropriately.  Additional utilities support querying git and determining the
candidate files via include/exclude globs (gitignore-style).  Added tests also
exercise these helpers directly so that their behaviour is covered and type
checked.
"""

from __future__ import annotations

import os
import stat
import subprocess
from collections.abc import Iterable, Iterator
from contextlib import suppress
from pathlib import Path

"""Public API of this test module (empty)."""
__all__ = ()


"""Glob patterns relative to the repository root. Only files matching an
include pattern and no exclude pattern are considered candidates."""
_GLOB_SPEC = """
scripts/*.bat
scripts/*.cmd
scripts/*.ps1
scripts/*.py
scripts/*.sh
"""


def _iter_glob_patterns(spec: str) -> Iterable[tuple[str, bool]]:
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


def _get_candidate_files() -> Iterator[Path]:
    """Yield files that should be executable, from gitignore-style globs.

    The patterns are read from ``_GLOB_SPEC`` using :func:`_iter_glob_patterns`.
    A path is considered a candidate if it matches at least one positive
    pattern and is not later removed by an exclusion (``!``) pattern. The
    yielded order preserves the first-match ordering from the include
    patterns.
    """
    root = Path(__file__).parent.parent  # repo root
    yielded: set[Path] = set()

    def _iter_files(pattern: str) -> Iterator[Path]:
        """Yield all files matching the given glob pattern, relative to the repo root."""
        for p in root.glob(pattern):
            if p.is_file():
                yield p

    for pattern, is_exclude in _iter_glob_patterns(_GLOB_SPEC):
        if is_exclude:
            for p in root.glob(pattern):
                # Remove any file that has already been yielded.
                yielded.discard(p)
        else:
            for p in _iter_files(pattern):
                if p not in yielded:
                    yielded.add(p)
                    yield p


def git_mode(path: Path) -> str | None:
    """Query git for the index mode of a file.

    The return value will look like ``"100644"`` or ``"100755"``; if the
    file is not tracked at all the function returns ``None``.
    """
    root = Path(__file__).parent.parent  # repo root
    # git understands forward slashes even on Windows; convert to posix
    rel = path.relative_to(root).as_posix()
    try:
        proc = subprocess.run(
            ["git", "ls-files", "--stage", "--", rel],
            cwd=str(root),
            capture_output=True,
            check=False,
        )
    except OSError:
        return None
    out = proc.stdout.decode().strip()
    if not out:
        return None
    return out.split()[0]


def test_top_level_scripts_executable() -> None:
    """Ensure every candidate file (per include/exclude globs) has an
    executable bit set (on platforms where that makes sense).
    """

    for entry in _get_candidate_files():
        # permissions check
        try:
            st = entry.stat()
            is_exec = bool(st.st_mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH))
        except OSError:
            is_exec = False

        git_mode_str: str | None = git_mode(entry)
        if git_mode_str is not None:
            # sanity check: git index mode should be one of the known values.
            # `100644`/`100755` are regular files; `120000` is a symlink.
            assert git_mode_str in (
                "100644",
                "100755",
                "120000",
            ), f"unexpected mode {git_mode_str} for {entry}"
            # regardless of platform, if the file is tracked as a regular file
            # (not a symlink) then the git index must mark it as executable.
            if not git_mode_str.startswith("12"):
                assert git_mode_str.startswith("1007"), (
                    f"{entry} is tracked but the git index does not mark it as executable"
                )

        # Windows doesn't honor the executable bit; just skip without
        # emitting warnings. The earlier implementation warned, but the
        # user requested silence on Windows.
        if os.name == "nt":
            continue

        # on non-Windows platforms we insist on the bit being present and
        # additionally that git considers the file executable.  The git check
        # above is a best-effort attempt because the file might not have been
        # added yet (newly created in a test branch), so we only assert when
        # ``git_mode_str`` is available.  Symlinks (mode 120000) are allowed by
        # virtue of the above check; they do not have a separate executable bit
        # of their own.
        assert is_exec, f"{entry} is not marked executable"


def test_git_mode_tracked() -> None:
    """Verify that the helper returns a valid mode string for a tracked file."""
    path = Path(__file__)
    mode = git_mode(path)
    assert mode is not None


def test_git_mode_untracked(tmp_path: Path) -> None:
    """Verify that the helper returns None for an untracked file."""
    root = Path(__file__).parent.parent
    # create a file inside the repository but do not add it to git.  to avoid
    # collisions with any real file we generate a unique temporary subdirectory
    # using ``tmp_path.name`` which is guaranteed not to exist already.  the
    # helper only works on files beneath the repo root so we create the
    # directory here rather than relying on ``tmp_path`` directly.
    unique_dir = root / tmp_path.name
    unique_dir.mkdir()
    new_file = unique_dir / "tmp_untracked.txt"
    new_file.write_text("x")
    try:
        mode = git_mode(new_file)
        assert mode is None
    finally:
        # clean up both the file and the directory; ignore errors since the
        # filesystem may already have removed them.
        with suppress(OSError):
            new_file.unlink()
        with suppress(OSError):
            unique_dir.rmdir()
