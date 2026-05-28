---
"obsidian-terminal": minor
---

Add a per-profile setting to define environment variables for external and integrated terminal profiles. Each entry is a `[key, value]` pair and is merged into the spawned shell's environment. On Windows, existing variables whose names match an entry's key case-insensitively are removed before the entries are applied. Fixes [GH#93](https://github.com/polyipseity/obsidian-terminal/issues/93). ([GH#161](https://github.com/polyipseity/obsidian-terminal/pull/161) by [@SAY-5](https://github.com/SAY-5))
