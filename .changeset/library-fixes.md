---
"obsidian-terminal": patch
---

If you gave one key to two commands, the key runs the same command as it does without the plugin. Updating the plugin no longer logs "Malformed data" or highlights Recover in the settings when the new version only adds settings. Import from clipboard now accepts settings and profiles exported by 3.28.0 or later. What they lack gets its default. The data editor of the settings and of a profile now says why it refused data. The warning under the data field shows the reason, such as "Malformed data". It showed `{}` before. "Export settings to current file" now writes the settings into the note's properties, so "Import settings from current file" can read them back. Number fields in the settings keep what you type, so a font size of 14.5 or a notice timeout of 5.5 can be typed from left to right. (by [@janah01](https://github.com/janah01))
