---
"obsidian-terminal": patch
---

Fix PATH merge order: system PATH entries from `path_helper` (macOS), `/etc/environment` (Linux), and registry (Windows) now take priority over inherited GUI-launch entries. This fixes a common issue on macOS where `/usr/bin/python3` (an xcrun shim) shadowed real Python installations in `/usr/local/bin` or other system-defined directories.
