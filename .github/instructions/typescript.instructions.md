---
name: TypeScript Coding Standards
applyTo: "src/**/*.ts"
description: Guidelines for TypeScript files in obsidian-plugin-template
---

# TypeScript Coding Standards — obsidian-plugin-template

## Core Rules

- Use the strictest TypeScript configuration (`tsconfig.json`).
- Validate and normalize all settings and local settings via `.fix()` functions (see `src/settings-data.ts`).
- Prefer type-safe patterns; **never** use the `any` type. **Prefer `unknown` over `any`.** When accepting unknown inputs, validate or narrow `unknown` with type guards or runtime validators before use. If `any` is truly unavoidable, document the reason and add a test asserting safety.
- Reference translation keys via `language.value.t(...)` or `$t(key)` in UI code. Avoid hardcoding user-facing strings.
- Use the project managers (`LanguageManager`, `SettingsManager`, `StorageSettingsManager`) as in `src/main.ts` to ensure consistent lifecycle and persistence behaviour.

## Practical examples & reminders

- When creating new settings, add a `fix()` entry and default in `Settings.DEFAULT` / `LocalSettings` and add a test that validates malformed data is corrected by `fix()`.
- When writing UI code, prefer the i18n accessor from `context.language.value.t(...)` rather than importing `i18next` directly.
- For lifecycle-sensitive managers, call `.load()` and ensure `.unload()` tasks are registered (see `PLACEHOLDERPlugin.onload()` pattern in `src/main.ts`).

## Do / Don't

- **Do:**
  - Use explicit types and `readonly` where appropriate
  - Keep logic modular and add unit tests for transformation helpers
  - Use `deepFreeze`/`markFixed`/`fixTyped` helpers available in `@polyipseity/obsidian-plugin-library`
- **Don't:**
  - Do not use `any` or unsafe casts. Prefer `unknown` and narrow via type guards or runtime validation.
  - Hardcode translation strings; always prefer `language.value.t(...)`
  - Bypass `.fix()` for persisted settings or local settings

## References

- See `src/main.ts` and `src/settings-data.ts` for canonical examples of manager usage, defaults, and `.fix()` patterns.

---

**Template merge guidance:** This instruction file is maintained in the template and may be merged into repositories generated from the template. If you need repository-specific TypeScript guidance, prefer creating a new local instruction file (for example, `.github/instructions/<your-repo>.typescript.md`) or make minimal, well-documented edits to this file. This practice reduces conflicts when upstream template changes are merged into downstream repositories.
