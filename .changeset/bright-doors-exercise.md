---
"obsidian-terminal": patch
---

Fix `layout-change` loop freezing Obsidian if another plugin calls `getViewState` in a `layout-change` listener. An example is `obsidian-image-toolkit` (https://github.com/sissilab/obsidian-image-toolkit/blob/c59bfa18c5cdb267a5f5a62637ff8e3b663cbb0f/src/main.ts#L39-L55). Fixes [GH#26](https://github.com/polyipseity/obsidian-terminal/issues/26).
