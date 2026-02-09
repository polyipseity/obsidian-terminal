---
name: Localization Guidelines
applyTo: "assets/locales/**/*.json"
description: Rules for translation and localization files
---

# Localization Guidelines — obsidian-plugin-template

## Core Rules

- **Never** translate or alter content inside `{{...}}` (interpolations) or `$t(...)` (references).
- Add new locale keys by editing `assets/locales/en/translation.json` first; then copy or adapt them into other locale folders.
- Keep `assets/locales/*/language.json` sorted alphabetically by language tag.
- Prefer the `generic` vocabulary for shared/common translations.

## Practical guidance

- When adding a new user-facing string, add an entry in `assets/locales/en/translation.json` and add/adjust tests that reference `language.value.t('your.key')` to help detect regressions.
- Avoid changing interpolation tokens or `$t()` usage inside translation values—these are runtime references and translators should not modify structural tokens.
- If you add a new translation key, add a short test or documentation note so CI and reviewers can validate the change.

## Do / Don't

- **Do:**
  - Follow the structure and keys in the English source files
  - Keep placeholders, `$t(...)`, and interpolation tokens unchanged
  - Review `assets/locales/README.md` for conventions
- **Don't:**
  - Translate or alter `{{...}}` or `$t(...)`
  - Add new keys without updating `assets/locales/en/translation.json` first

## References

- See `assets/locales/README.md` and `src/main.ts` for examples of how `PluginLocales` are loaded and used.
