---
"obsidian-terminal": minor
---

Refactor profile list modal to use base ListModal class ([GH#109](https://github.com/polyipseity/obsidian-terminal/pull/109) by [@taisau](https://github.com/taisau))

Refactored ProfileListModal to extend the base ListModal class instead of
reimplementing list UI logic, reducing code duplication and improving
maintainability. The modal now integrates seamlessly with the library's
generic list modal framework while preserving profile-specific UI features
like preset selection and default profile management.
