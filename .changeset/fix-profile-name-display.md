---
"obsidian-terminal": patch
---

Fix profile name display in profile list

Updated `profile-name-formats` and `profile-list.namer-` in all translation files to use `{{info.nameOrID}}` for proper fallback to profile ID when name is empty. Improved format to "Type: Name" style for better readability. Resolves [GH#63](https://github.com/polyipseity/obsidian-terminal/issues/63).
