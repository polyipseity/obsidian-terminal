---
"obsidian-terminal": patch
---

Holding a hotkey in a focused terminal no longer sends the key to the shell once per key repeat. On Windows, holding `Ctrl`+`Shift`+`H` opened a terminal. If that terminal ran PowerShell, each repeat typed `^H` into it. (by [@janah01](https://github.com/janah01))
