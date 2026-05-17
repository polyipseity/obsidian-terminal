---
"obsidian-terminal": patch
---

Fix the donate button and the "open documentation (donate)" command throwing "Error opening documentation" (`TypeError: Cannot read properties of undefined (reading 'addSetting')`) on Obsidian 1.12.7+. Obsidian changed the internal `renderInstalledPlugin` API the plugin relied on to trigger the donation link. `donate()` now falls back to opening the manifest donation URL directly via `openExternal` when the private rendering path is unavailable, so donating works regardless of Obsidian-side private API changes. ([GH#157](https://github.com/polyipseity/obsidian-terminal/issues/157))
