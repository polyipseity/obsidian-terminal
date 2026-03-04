"""Tests ensuring scripts under top-level directories are executable.

The helpers here verify that files in configured script folders have the
executable bit set on non-Windows platforms and that git's index marks them
appropriately.  Additional utilities support querying git and determining the
candidate files via include/exclude globs (gitignore-style).  Added tests also
exercise these helpers directly so that their behaviour is covered and type
checked.
"""

import os
import stat
import subprocess
from collections.abc import AsyncIterator, Iterable

import pytest
from anyio import IncompleteRead, Path, run_process

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


async def _get_candidate_files() -> AsyncIterator[Path]:
    """Yield files that should be executable, from gitignore-style globs.

    The patterns are read from ``_GLOB_SPEC`` using :func:`_iter_glob_patterns`.
    A path is considered a candidate if it matches at least one positive
    pattern and is not later removed by an exclusion (``!``) pattern. The
    yielded order preserves the first-match ordering from the include
    patterns.
    """
    root = Path(__file__).parent.parent
    yielded: set[Path] = set()

    async def _iter_files(pattern: str) -> AsyncIterator[Path]:
        """Yield all files matching the given glob pattern, relative to the repo root."""
        async for p in root.glob(pattern):
            if await p.is_file():
                yield p

    for pattern, is_exclude in _iter_glob_patterns(_GLOB_SPEC):
        if is_exclude:
            async for p in root.glob(pattern):
                # Remove any file that has already been yielded.
                yielded.discard(p)
        else:
            async for p in _iter_files(pattern):
                if p not in yielded:
                    yielded.add(p)
                    yield p


async def git_mode(path: Path) -> str | None:
    """Query git for the index mode of a file.

    The return value will look like ``"100644"`` or ``"100755"``; if the
    file is not tracked at all the function returns ``None``.  We use
    ``anyio.run_process`` so that the helper is fully async-friendly.
    """
    root = Path(__file__).parent.parent
    # git understands forward slashes even on Windows; convert to posix
    rel = path.relative_to(root).as_posix()
    try:
        proc = await run_process(
            ["git", "ls-files", "--stage", "--", rel],
            cwd=str(root),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except Exception:
        return None
    out = proc.stdout.decode().strip()
    if not out:
        return None
    return out.split()[0]


@pytest.mark.anyio
async def test_top_level_scripts_executable() -> None:
    """Ensure every candidate file (per include/exclude globs) has an
    executable bit set (on platforms where that makes sense).
    """

    async for entry in _get_candidate_files():
        # permissions check
        try:
            st = await entry.stat()
            is_exec = bool(st.st_mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH))
        except (OSError, IncompleteRead):
            is_exec = False

        git_mode_str: str | None = await git_mode(entry)
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


@pytest.mark.anyio
async def test_git_mode_tracked() -> None:
    """Verify that the helper returns a valid mode string for a tracked file."""
    path = Path(__file__)
    mode = await git_mode(path)
    assert mode is not None


@pytest.mark.anyio
async def test_git_mode_untracked(tmp_path: Path) -> None:
    """Verify that the helper returns None for an untracked file."""
    root = Path(__file__).parent.parent
    # create a file inside the repository but do not add it to git.  to avoid
    # collisions with any real file we generate a unique temporary subdirectory
    # using ``tmp_path.name`` which is guaranteed not to exist already.  the
    # helper only works on files beneath the repo root so we create the
    # directory here rather than relying on ``tmp_path`` directly.
    unique_dir = root / tmp_path.name
    await unique_dir.mkdir()
    new_file = unique_dir / "tmp_untracked.txt"
    await new_file.write_text("x")
    try:
        mode = await git_mode(new_file)
        assert mode is None
    finally:
        # clean up both the file and the directory; ignore errors since the
        # filesystem may already have removed them.
        try:
            await new_file.unlink()
        except Exception:
            pass
        try:
            await unique_dir.rmdir()
        except Exception:
            pass
