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

> **Note:** Prefer `pnpm` for development workflows. Use `npm` only when `pnpm` is unavailable.

- **Setup**
  - `pnpm install` — install dependencies and set up Git hooks (preferred).
  - Fallback: `npm install` (only if pnpm is not available).

- **Build & Install**
  - `pnpm build` — production build (runs checks then builds).
  - `pnpm dev` — development/watch build.
  - `pnpm obsidian:install <vault>` — build and install the plugin to a vault.
  - `pnpm run obsidian:install:force <vault>` — force install using `build:force` (skips format).

- **Lint & Format**
  - `pnpm run check` — eslint + prettier(check) + markdownlint.
  - `pnpm run format` — eslint --fix, prettier --write, markdownlint --fix.

- **Versioning**
  - Use `changesets` for PRs; version lifecycle scripts are configured (`version` / `postversion`).

- **Localization**
  - Add locales by copying `assets/locales/en/translation.json` and updating `assets/locales/*/language.json` as needed. See `assets/locales/README.md` for conventions.

---

## Scripts (package.json) 🔧

Quick reference for scripts in `package.json`. Use `pnpm` (preferred).

- `build` — runs `format` then `build:force`.
- `build:force` — runs `node build/build.mjs` (internal build implementation).
- `build:dev` — runs `build:force` in dev mode (`pnpm run build:force -- dev`).
- `obsidian:install` — runs `build` then `node build/obsidian-install.mjs` (install to vault).
- `obsidian:install:force` — runs `build:force` then `node build/obsidian-install.mjs`.
- `check` — runs `check:eslint`, `check:prettier`, `check:md`.
- `check:eslint` — `eslint --cache --max-warnings=0`.
- `check:prettier` — `prettier --check .`.
- `check:md` — `markdownlint-cli2`.
- `format` — runs `format:eslint`, `format:prettier`, `format:md`.
- `format:eslint` — `eslint --cache --fix`.
- `format:prettier` — `prettier --write .`.
- `format:md` — `markdownlint-cli2 --fix`.
- `commitlint` — `commitlint --from=origin/main --to=HEAD`.
- `prepare` — runs `husky` to set up Git hooks.
- `version` / `postversion` — version lifecycle scripts (`node build/version.mjs`, `node build/version-post.mjs`).

> CI tip: Use `pnpm install --frozen-lockfile` in CI for deterministic installs.

## 3. Coding Conventions

 **Commit Messages:**

- All commit messages **must** follow the Conventional Commits standard.
- **Header must be ≤ 100 characters.**
- **Body lines must be hard-wrapped at 100 characters** (enforced by commitlint/husky).
- See `.github/instructions/commit-message.instructions.md` for up-to-date rules and examples.
- All agents and contributors must comply; see `.github/instructions/commit-message.md` for agent summary.

  **Example (compliant):**

  ```text
  refactor(eslint): remove @eslint/compat, eslintrc, js; update Prettier rules

  - Removed @eslint/compat, @eslint/eslintrc, @eslint/js from config and lockfiles
  - Updated Prettier to v3 and adjusted markdownlint config for new plugin
  - Cleaned up ESLint overrides and Svelte linting comments

  Refs: lint config modernization
  ```

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
# Preferred
pnpm obsidian:install D:/path/to/vault
# Or (if pnpm is not available)
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
- [.github/instructions/commit-message.md](.github/instructions/commit-message.md) — Commit message convention
- [.github/skills/plugin-testing/SKILL.md](.github/skills/plugin-testing/SKILL.md) — Plugin testing skill

---

For unclear or incomplete sections, provide feedback to improve this guide for future agents.
