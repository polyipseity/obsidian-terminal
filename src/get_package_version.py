from importlib.metadata import PackageNotFoundError as _Pkg404Err, version as _ver
from sys import argv as _argv
from typing import Sequence as _Seq

__all__ = ("main",)


def main(argv: _Seq[str]):
    pkg = argv[1] if len(argv) > 1 else ""
    try:
        ver = _ver(pkg)
    except (ValueError, _Pkg404Err):
        ver = ""
    print(f"{pkg} {ver}")


if __name__ == "__main__":
    main(_argv)
