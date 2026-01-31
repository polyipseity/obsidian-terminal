# AGENTS.md — AI Coding Agent Guide

This guide provides clear, actionable instructions for AI coding agents working in the `obsidian-plugin-template` codebase. Follow these rules for productivity, accuracy, and maintainability.

## 1. Architecture Overview

- **Plugin Structure:**
  - Core logic in `src/` (entry: `src/main.ts`, class: `PLACEHOLDERPlugin`).
- **Settings & Localization:**
  - Settings: `src/settings.ts`, `src/settings-data.ts`
  - Localization: `assets/locales.ts`, per-locale JSON in `assets/locales/`
- **Build System:**
  - Custom scripts in `build/` (not webpack/rollup)
  - Main: `build/build.mjs`, Install: `build/obsidian-install.mjs`
- **External Library:**
  - Uses `@polyipseity/obsidian-plugin-library` for context, i18n, settings, UI

## 2. Developer Workflows

- **Build:**
  - `npm install` — install dependencies
  - `npm run build` — production build (runs checks, then builds)
  - `npm run dev` — development build (watch mode)
  - `npm run obsidian:install <vault>` — install plugin to vault
- **Lint/Typecheck:**
  - `npm run check` — TypeScript & ESLint
  - `npm run fix` — auto-fix lint issues
- **Versioning:**
  - Use `changesets` for every PR (see `README.md`)
- **Localization:**
  - Add locale: copy `assets/locales/en/translation.json`, update `assets/locales/en/language.json`
  - See `assets/locales/README.md` for conventions (never translate `{{...}}` or `$t(...)`)

## 3. Coding Conventions

- **TypeScript:** Strictest config (`tsconfig.json`)
- **ESLint:** Custom config (`eslint.config.mjs`), ignores build/output
- **Settings:** All settings objects use `.fix()` for validation/normalization
- **Localization:** Reference keys via `$t(key)`, use `{{key}}` for interpolation
- **Lifecycle:** Register/unload all major managers in `PLACEHOLDERPlugin.onload()`

## 4. Integration Points

- **Obsidian API:** Peer dependency, entry/manifest must match plugin requirements
- **@polyipseity/obsidian-plugin-library:** Central for context, i18n, settings, UI, utils
- **External Translations:** Some from `polyipseity/obsidian-plugin-library`

## 5. Key Files & Directories

- `src/main.ts` — Plugin entry, lifecycle, context
- `src/settings.ts` / `src/settings-data.ts` — Settings UI/data
- `assets/locales.ts` / `assets/locales/` — Localization logic/files
- `build/build.mjs` / `build/obsidian-install.mjs` — Build/install scripts
- `README.md` / `assets/locales/README.md` — Contributor/translation instructions
- `.github/instructions/` — Task/file-specific instructions
- `.github/skills/` — Agent skills for specialized workflows

> **Never use `.github/copilot-instructions.md`. All agent instructions must be in `AGENTS.md` and referenced from here.**

## 6. Example Patterns

**Build Script Usage:**

```sh
npm run obsidian:install D:/path/to/vault
```

**Localization Reference:**

```json
"welcome": "Welcome, {{user}}!"
```

Use as: `i18n.t("welcome", { user: "Alice" })`

## 7. Agent Instructions Policy

- **Always use `AGENTS.md` for all agent instructions and guidelines.**
- Do NOT use `.github/copilot-instructions.md` in this project.
- All coding standards, workflow rules, and agent skills must be documented and referenced from `AGENTS.md` only.

### Linked Instructions & Skills

- [.github/instructions/typescript.instructions.md](.github/instructions/typescript.instructions.md) — TypeScript standards
- [.github/instructions/localization.instructions.md](.github/instructions/localization.instructions.md) — Localization rules
- [.github/skills/plugin-testing/SKILL.md](.github/skills/plugin-testing/SKILL.md) — Plugin testing skill

---

For unclear or incomplete sections, provide feedback to improve this guide for future agents.
