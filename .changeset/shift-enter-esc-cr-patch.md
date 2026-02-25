---
"obsidian-terminal": patch
---

Emit ESC+CR when the user presses Shift+Enter in the terminal emulator.  This
matches the behavior expected by Claude Code and other TUI applications and
prevents modified enters from being interpreted as plain CR.  ([GH#89](https://github.com/polyipseity/obsidian-terminal/pull/89) by [@davidszp](https://github.com/davidszp))
