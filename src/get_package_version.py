"""Print package name and installed version from command-line.

Utility used by scripts and tests to query an installed package's version.
"""

from importlib.metadata import PackageNotFoundError, version
from sys import argv
from typing import Sequence

__all__ = ("main",)


def main(argv: Sequence[str]):
    """Print "<package> <version>" for the package named in argv[1].

    If the package cannot be found the printed version is empty.
    """
    pkg = argv[1] if len(argv) > 1 else ""
    try:
        ver = version(pkg)
    except (ValueError, PackageNotFoundError):
        ver = ""
    print(f"{pkg} {ver}")


if __name__ == "__main__":
    main(argv)
