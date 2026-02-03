---
name: TypeScript Coding Standards
applyTo: "src/**/*.ts"
description: Guidelines for TypeScript files in obsidian-plugin-template
---

# TypeScript Coding Standards — obsidian-plugin-template

## Core Rules

- Use the strictest TypeScript configuration (`tsconfig.json`).
- Validate and normalize all settings objects with `.fix()` methods.
- Prefer type-safe patterns; **never** use `any` unless absolutely unavoidable.
- Reference translation keys only via `$t(key)`; use `{{key}}` for interpolation.
- Use project-specific managers (e.g., `LanguageManager`, `SettingsManager`) as in `src/main.ts`.

## Do / Don't

- **Do:**
  - Use explicit types everywhere possible
  - Keep code modular and maintainable
  - Document complex logic with comments
- **Don't:**
  - Use `any` or unsafe casts
  - Hardcode translation strings; always use `$t()`
  - Bypass `.fix()` for settings objects

## References

- See [src/main.ts](../../src/main.ts) for manager usage patterns
