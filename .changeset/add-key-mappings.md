---
"obsidian-terminal": minor
---

Add custom keymappings system for iTerm2-style key remapping. Users can define key combos and what the terminal sends when pressed (ignore, passthrough, escape sequence, hex code, or text), with optional per-platform targeting (macOS, Linux, Windows, or all platforms). Ships with built-in default mappings: macOS Natural Text Editing bindings (Option+Arrow word navigation, Option+Backspace word deletion, etc.) and a Shift+Enter → ESC CR mapping for all platforms (useful for TUI apps such as Claude Code). The reset button restores these factory defaults rather than clearing all mappings. Also fixes a bug where two `attachCustomKeyEventHandler` calls silently overwrote each other, and a bug where the passthrough action did not suppress the corresponding keyup event. ([GH#118](https://github.com/polyipseity/obsidian-terminal/pull/118) by [@ryanbbrown](https://github.com/ryanbbrown))
