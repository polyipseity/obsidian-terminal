---
"obsidian-terminal": patch
---

Fix the donate button and "open documentation (donate)" command failing with an error on Obsidian 1.12.7+ due to a private API change. The plugin now finds the donation button directly from the community plugins list and falls back to opening the donation URL when that is not possible. ([GH#157](https://github.com/polyipseity/obsidian-terminal/issues/157) by [@janah01](https://github.com/janah01))
