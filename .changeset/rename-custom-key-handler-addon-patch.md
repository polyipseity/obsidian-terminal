---
"obsidian-terminal": patch
---

Rename `MacOSOptionKeyPassthroughAddon` to `CustomKeyEventHandlerAddon`.

The addon handles multiple custom key behaviors (macOS Option key passthrough,
Shift+Enter, Option+Arrow/Backspace/Delete); the new name reflects its role as
the single custom key event handler addon. The addon slot is renamed from
`macOptionKeyPassthrough` to `customKeyEventHandler`. The `macOSOptionKeyPassthrough`
setting (and its behavior) is unchanged.
