---
"obsidian-terminal": patch
---

Fix `Terminal exited: 1` and a Python `PermissionError` traceback when closing an integrated terminal pane on macOS (since 3.26.0). The terminal proxy now closes the pseudo-terminal first and stops as soon as no process in the shell's process group is left running. A shell that exits on hangup closes its pane in well under a second. The shell and any program it started in its process group that ignore the hangup are sent `SIGTERM` after one second, then `SIGKILL` after another second if still running. (TES-128; GH #162)
