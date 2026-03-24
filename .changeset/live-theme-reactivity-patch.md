---
"obsidian-terminal": patch
---

Fix terminal theme not updating on existing terminals when the Obsidian
theme or accent color changes (#124, #135). Threads `profileSourceId`
through terminal state so the `onMutate` watcher can react to live
profile changes and trigger `FollowThemeAddon.refresh()`.
([GH#136](https://github.com/polyipseity/obsidian-terminal/pull/136) by [@janah01](https://github.com/janah01))
