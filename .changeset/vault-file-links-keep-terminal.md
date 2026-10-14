---
"obsidian-terminal": patch
---

Clicking a vault file path in terminal output no longer replaces an unpinned terminal tab and ends its session. The file opens in the last active note of the terminal's window, unless that note is pinned. Without such a note it opens in a note or an empty tab shown in another pane, or else in a new tab. Pinned terminals choose the tab the same way. Only a left click opens the file. (by [@janah01](https://github.com/janah01))
