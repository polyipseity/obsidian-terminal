---
"obsidian-terminal": minor
---

Dragging files or folders out of the vault onto a terminal now inserts their paths. This works from the file explorer, search, backlinks, bookmarks, links and embedded images in notes, and Bases cards. Files dragged from other apps, such as Finder, Explorer or VS Code, are inserted the same way. Paths are written for the terminal's shell, escaped or quoted, and pasted so that Claude Code attaches dropped images. A name with spaces, quotes or `$` arrives as one argument and is no longer pasted as typed. A WSL terminal gets the Linux path of a dropped file, such as `/mnt/c/Users/me/photo.png`. A drop with nothing to insert, or with items left out, shows a notice. Dragging a tab or selected text over a terminal is left to Obsidian again, so a tab can be docked there. (by [@janah01](https://github.com/janah01))
