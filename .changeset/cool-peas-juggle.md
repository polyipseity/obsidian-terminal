---
"obsidian-terminal": patch
---

Fix the macOS terminal profiles not setting the cwd properly. To fix your macOS terminal profiles, add `"$PWD"` (including `"`) as the only argument of the profile.
