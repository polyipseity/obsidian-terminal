---
"obsidian-terminal": patch
---

Fix terminal crash on macOS/Linux due to unconditional `typing_extensions` import in `unix_pseudoterminal.py`. The `@override` decorator is now conditionally imported via a `TYPE_CHECKING` guard with a runtime no-op fallback, avoiding an unnecessary runtime dependency on platforms where the package is not installed. Fixes [GH#178](https://github.com/polyipseity/obsidian-terminal/issues/178).
