---
"obsidian-terminal": minor
---

Add a new "Profile defaults" settings section and store global
`terminalOptions` that apply to every terminal instance unless a
profile overrides them. A modal is used for editing options, and real-time
updates propagate to open terminals. The previous single `fontFamily` setting
has been removed in favor of this more flexible system.
