---
"obsidian-terminal": minor
---

Refactor `src/terminal/unix_pseudoterminal.py` to replace ad-hoc selector callbacks
with small, well-documented context-manager handler classes and tighten type
annotations.

- Introduce `_SelectorHandler`, `_PipePty`, `_PipeStdin`, and `_ProcessCmdIO` to
  centralize FD registration/unregistration and improve EOF handling.
- Add type hints, docstrings, and safer unregister logic — improves maintainability
  and robustness without changing public behavior.
