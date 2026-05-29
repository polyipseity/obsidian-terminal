---
"obsidian-terminal": patch
---

Fix integrated Unix PTY proxy shutdown so child shells/processes do not remain orphaned when the host disconnects (for example, when closing a pane or quitting Obsidian). The proxy now exits when host pipes close, handles shutdown signals gracefully, and tears down the child process group before final wait. Fixes [GH#162](https://github.com/polyipseity/obsidian-terminal/issues/162). Thanks [@bfeeny](https://github.com/bfeeny) for the report.
