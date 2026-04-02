---
"obsidian-terminal": minor
---

Add manual tab rename via pane context menu and command palette.

Terminal tabs previously showed only the static profile name, making
multiple sessions indistinguishable. Users can now right-click a
terminal tab and choose "Rename", or invoke the "Rename Terminal"
command, to set a custom title that persists across sessions. Clearing
the title restores the automatic name (profile name, executable, or
shell-set title). Fixes #94.
