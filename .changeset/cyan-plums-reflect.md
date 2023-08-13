---
"obsidian-terminal": patch
---

Fix plugin potentially failing to load. This may happen if `Community plugins > Debug startup time` is disabled. When it is disabled, Obsidian removes source maps, which erraneously removes JavaScript strings intentionally containinig source map-like content.
