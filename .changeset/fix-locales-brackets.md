---
"@polyipseity/obsidian-terminal": patch
---

Fix invalid JSON in translation files:

- `assets/locales/zh-Hans/translation.json`
- `assets/locales/zh-Hant/translation.json`

The entry `components.select-profile.item-text-temporary` contained unmatched brackets, which caused parsing errors and broke localization loading. This patch corrects the brackets so the JSON validates properly.
