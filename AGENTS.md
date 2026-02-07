# AGENTS.md — AI Coding Agent Guide

This guide provides clear, actionable instructions for AI coding agents working in the `obsidian-plugin-template` codebase. Follow these rules for productivity, accuracy, and maintainability.

## 1. Architecture Overview

- **Plugin Structure:**
  - Core logic in `src/` (entry: `src/main.ts`, class: `PLACEHOLDERPlugin`).
- **Settings & Localization:**
  - Settings: `src/settings.ts`, `src/settings-data.ts`
  - Localization: `assets/locales.ts`, per-locale JSON in `assets/locales/`
- **Build System:**
  - Custom scripts in `scripts/` (not webpack/rollup)
  - Main: `scripts/build.mjs`, Install: `scripts/obsidian-install.mjs`
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
- `build:force` — runs `node scripts/build.mjs` (internal build implementation).
- `build:dev` — runs `build:force` in dev mode (`pnpm run build:force -- dev`).
- `obsidian:install` — runs `build` then `node scripts/obsidian-install.mjs` (install to vault).
- `obsidian:install:force` — runs `build:force` then `node scripts/obsidian-install.mjs`.
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
- `version` / `postversion` — version lifecycle scripts (`node scripts/version.mjs`, `node scripts/version-post.mjs`).

> CI tip: Use `pnpm install --frozen-lockfile` in CI for deterministic installs.

## Testing ✅

- **Test runner:** Vitest (fast, TypeScript support). Tests live under `tests/` and should be named `*.spec.ts` or `*.spec.js`.
- **Config:** Minimal config is in `vitest.config.mts` (keep it small). Add inline comments to that file if you change test behavior or providers.
- **Run locally:**
  - Non-interactive / coverage: `pnpm test` or `npm run test` (runs `vitest run --coverage`).
  - Interactive / watch: `pnpm run test:watch` or `npm run test:watch`.
  - Coverage: `pnpm coverage` (runs `vitest run --coverage`).
- **Git hooks & CI:**
  - Pre-push: `.husky/pre-push` runs `npm run test` (equivalently `pnpm test`) — failing tests will block pushes.
  - CI: both the `pnpm` and `npm` CI jobs run `pnpm test` / `npm run test` (non-interactive, coverage enabled).
- **Guidelines for agents & contributors:**
  - Add tests for new features and bug fixes; tests must be small, deterministic, and fast.
  - Avoid network, filesystem access outside fixtures, or user vaults — mock external dependencies.
  - For long-running or flaky tests, use a dedicated `integration` tag and add rationale to PR description; avoid adding flaky tests to the main suite.
  - When changing test infra (adding coverage provider, changing runtime, altering hooks), update `AGENTS.md` with rationale and instructions so other agents can follow the new workflow.
- **PR checklist (for agents):**
  1. Add/modify tests to cover behavior changes.
  2. Run `pnpm test -- --run` locally and ensure all tests pass.
  3. Keep tests parallelizable and idempotent.
  4. Document any infra changes in `AGENTS.md`.

If you need help designing a test or mocking a dependency, ask for a short example to be added to `tests/fixtures/`.

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
- `scripts/build.mjs` / `scripts/obsidian-install.mjs` — Build/install scripts
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
