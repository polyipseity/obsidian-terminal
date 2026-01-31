---
name: Localization Guidelines
applyTo: "assets/locales/**/*.json"
description: Rules for translation and localization files
---

# Localization Guidelines — obsidian-plugin-template

## Core Rules

- **Never** translate content inside `{{...}}` (interpolations) or `$t(...)` (references).
- Add new locales by copying `assets/locales/en/translation.json` and updating `assets/locales/en/language.json`.
- Sort languages alphabetically by tag in `language.json`.
- Use the `generic` vocabulary for standardized/common translations.

## Do / Don't

- **Do:**
  - Follow the structure and keys in the English source files
  - Keep placeholders and references unchanged
  - Review [assets/locales/README.md](../../assets/locales/README.md) for conventions
- **Don't:**
  - Translate or alter `{{...}}` or `$t(...)`
  - Add new keys without updating the English source

## References

- See [assets/locales/README.md](../../assets/locales/README.md) for more details
