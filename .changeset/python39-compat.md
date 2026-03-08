---
"obsidian-terminal": patch
---

Use Python 3.9-compatible type annotations in unix_pseudoterminal.py.

Commit ab83e53 introduced `from typing import Self` (Python 3.11) and
`type[X] | None` (Python 3.10) in a refactor. The plugin runs on the user's
system Python, which on macOS defaults to 3.9.6 (Command Line Tools).
Both Python 3.9 and 3.10 crash with ImportError at startup.

Replace with `from __future__ import annotations` and forward-reference
class name. Three lines changed, zero behavioral impact.

([GH#107](https://github.com/polyipseity/obsidian-terminal/pull/107) by [@janah01](https://github.com/janah01))
