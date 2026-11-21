---
"obsidian-terminal": patch
---

Keymappings have a new action, Send to Obsidian. While a terminal has the focus, a key with this action runs its Obsidian hotkey, and the shell does not get the key. Two such keymappings come built in: `Ctrl`+`P` on Windows and `Command`+`P` on macOS, so the command palette opens from a focused terminal. Linux has none, because bash and zsh use `Ctrl`+`P`. On Windows, programs in the terminal no longer get `Ctrl`+`P`. This includes bash in WSL, Git Bash and SSH sessions, and vim and nano. To give the key back, delete the keymapping under Settings → Keymappings. (by [@janah01](https://github.com/janah01))
