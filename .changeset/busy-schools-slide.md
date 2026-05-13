---
"obsidian-terminal": minor
---

Consolidate terminal command and menu registration: add "default" to PROFILE_TYPES
for unified handling of default profiles alongside other profile types. Extract
helper functions (`openSelectProfile`, `openDefaultOrSelectProfile`,
`openDefaultProfileOfType`) to reduce duplication and improve code clarity.
Remove separate `defaultContextMenu` function and deduplicate profile lookup
logic into `getDefaultProfile` and `getDefaultProfileOfType`.
