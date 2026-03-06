---
"obsidian-terminal": patch
---

Complete macOS Option key handling and migrate to public xterm.js API.

- Add Option+Arrow word navigation
- Add Option+Backspace/Delete word deletion
- Replace internal `_core.coreService.triggerDataEvent()` with public `terminal.input()`
- Fix Shift+Enter regression caused by `attachCustomKeyEventHandler` conflict
- Consolidate all custom key handlers into `MacOSOptionKeyPassthroughAddon`

([GH#106](https://github.com/polyipseity/obsidian-terminal/pull/106) by [@janah01](https://github.com/janah01))
