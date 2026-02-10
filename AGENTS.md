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

- Note: `scripts/obsidian-install.mjs` now fails gracefully when `manifest.json` is missing or invalid and prints a concise error message rather than emitting a full stack trace. This makes local tests and CI logs cleaner and eases assertions for failure cases.
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

- **Test runner:** Vitest (fast, TypeScript support).
- **Test file conventions and meaning:**
  - `*.spec.{ts,js,mjs}` — **Unit tests (BDD-style)**: prefer a Behavior-Driven mindset; tests describe what the code should do, focus on small, isolated units, and should be fast and hermetic
  - `*.test.{ts,js,mjs}` — **Integration tests (TDD-style)**: prefer a Test-Driven mindset for integration verification; tests exercise multiple units or real integrations (filesystem, build, etc.).

  > Note: In JavaScript the extensions `*.spec` and `*.test` are tooling-equivalent; this project adopts the **semantic distinction** above to encourage appropriate test design (BDD for `spec`, TDD/integration for `test`).

**Test path guidance:** When referencing package scripts from tests, prefer relative paths that resolve to the package-local `scripts/` directory (for example, `../../scripts/...` from `tests/scripts`) instead of using repository-root `scripts/` paths. This keeps tests package-scoped, hermetic, and easier to run in isolation.

- **Config:** Minimal config is in `vitest.config.mts` and includes both `*.spec.*` and `*.test.*` globs; add inline comments to that file if you change test behavior or providers.

### Vitest / `vi` best practices (tests) ✅

- Prefer `vi.fn()` for spies and stubs instead of inline functions so tests can inspect calls and reset behavior easily.
  - For async behavior, prefer `vi.fn().mockResolvedValue(x)` or `vi.fn().mockRejectedValue(err)` over `() => Promise.resolve()` / `() => Promise.reject()` to make intent explicit and improve readability.
- Use `vi.doMock` / `vi.mock` with `vi.resetModules()` to isolate module-level mocks. When restoring spies/mocks between tests use `vi.restoreAllMocks()` (commonly in an `afterEach`).
- Use `vi.spyOn()` to observe calls to global objects (console, process) rather than reassigning globals directly.
- For timer-based tests, prefer `vi.useFakeTimers()` and `vi.runAllTimers()` / `vi.advanceTimersByTime()` to make assertions deterministic.
- Prefer `vi.mocked(...)` for typed module mocks where available to access typed members and avoid `any` casts.

These conventions improve test clarity, make failures easier to diagnose, and keep suites hermetic and parallelizable.

Helpful local resources:

- `tests/README.md` — Examples and recommended patterns for `vi` usage (async stubs, fake timers, spying globals).
- `tests/mocks/library.ts` — Helper utilities to obtain a typed mocked `@polyipseity/obsidian-plugin-library` and to override `DocumentationMarkdownView.register` in tests.

- **Run locally:**
  - Full (default): `pnpm test` / `npm run test` — runs both unit and integration tests with coverage.
  - Unit-only (Vitest CLI): `pnpm exec vitest run "tests/**/*.spec.{js,ts,mjs}" --coverage` — fast, good for PR iteration.
  - Integration-only (Vitest CLI): `pnpm exec vitest run "tests/**/*.test.{js,ts,mjs}" --coverage` — use for longer-running integration suites.
  - Interactive / watch: `pnpm run test:watch` or `npm run test:watch`.

- **Git hooks & CI:**
  - Pre-push: `.husky/pre-push` runs `npm run test` (equivalently `pnpm test`) — failing tests will block pushes.
  - CI: CI jobs run the full test suite (both unit and integration). If adding slow or flaky integration tests, mark them clearly (folder or filename) and justify in the PR description; prefer to keep the default suite fast.

- **Guidelines for agents & contributors:**
  - Unit tests must be deterministic and hermetic; mock external dependencies and avoid network I/O.
  - Integration tests may use fixtures or local resources but must be isolated and documented.
  - Keep tests small and focused — single assertion / behavior per test where reasonable.
  - Test file structure: follow a **one test file per source file** convention. Place tests so they mirror the source directory structure under `tests/` for both unit (spec) tests and integration (test) suites. Name tests after the source file, e.g., `src/utils/foo.js` -> `tests/utils/foo.spec.js` (unit and integration). Only split a test across multiple files if a single test file would be unreasonably large; document the reason in the test file header.
  - When changing test infra (adding coverage providers, changing runtimes, or altering hooks), update `AGENTS.md` with rationale and practical instructions so other agents can follow the new workflow.

- **PR checklist (for agents):**
  1. Add/modify tests to cover behavior changes and follow the **one test file per source file** convention.
  2. Run `pnpm exec vitest run "tests/**/*.spec.{js,ts,mjs}"` locally for fast verification and `pnpm test` for the full suite.
  3. Keep tests parallelizable and idempotent.
  4. Document any infra changes in `AGENTS.md`.  

If you need help designing a test or mocking a dependency, ask for a short example to be added to `tests/fixtures/`.

## 3. Coding Conventions

**TypeScript Types:**

- Do **not** use the TypeScript `any` type. Prefer `unknown` over `any`. When accepting unknown inputs, validate or use type guards to narrow `unknown` before use. If `any` is truly unavoidable, document the reason and add tests that assert safety.
- **Prefer `interface` for object shapes:** Prefer `interface Foo { ... }` rather than `type Foo = { ... }` for object-shaped declarations when possible. Interfaces are typically better for incremental TypeScript performance (caching and declaration merging) and work well with extension and declaration merging patterns.
- When you need union, mapped, or conditional types, `type` aliases remain appropriate. Document non-trivial type-level logic with a brief comment so readers understand the intent and tradeoffs.

Example:

```ts
// preferred for object shapes
interface Settings {
  openChangelogOnUpdate: boolean;
  noticeTimeout: number;
}

// acceptable use of `type` for advanced type composition
type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
```

**Commit Messages:**

- All commit messages **must** follow the Conventional Commits standard.
- **Header should be ≤ 72 characters (use 72 as a human-friendly buffer; tooling still accepts up to 100).**
- **Body lines must be hard-wrapped at 100 characters** (enforced by commitlint/husky). Prefer 72 for messages intended for humans.
- See `.github/instructions/commit-message.instructions.md` for up-to-date rules, examples, and a short agent-oriented summary.
- Run `npm run commitlint` locally to validate message format before pushing; Husky will run checks on `prepare`/pre-push as configured.

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

### Imports & module-loading policy 🔗

- **Always use top-level static imports** for modules and types where possible. Use `import` and `import type` at the top of the file (immediately following any brief file-level documentation header). Placing imports at the top helps TypeScript and tools perform accurate static analysis and keeps dependency graphs consistent.
- **Placement rule (explicit):** imports should be placed **before any other executable code** in the file. They may appear after a short file-level doc-comment or header but not after code that executes at module load time.
- **Dynamic imports:** use `await import(...)` only when necessary (for example, to isolate a module under test after `vi.resetModules()` or to load resources conditionally at runtime). When you use a dynamic import in tests or runtime code, add a short comment explaining why the dynamic import is required.
- **Testing note:** tests may legitimately import modules dynamically to reset module cache, apply mocks, or mock resource imports. Prefer keeping `import type` (type-only imports) at the top of test files when types are required by the test.
- **Avoid reassignment of imported bindings.** If you need to replace a function on an imported module for tests, prefer mutating the module object (e.g., `Object.assign(lib, { fn: myFn })`) rather than reassigning the imported binding itself.
- **Document exceptions:** If you must deviate from these rules, add a brief justification in a code comment or the test file header so reviewers can understand the rationale.

Example (imports and types):

```ts
/** File header doc comment allowed here */
import type { Settings } from "../src/settings-data.js"; // type-only import at top
import { loadSettings } from "../src/settings.js"; // runtime import at top

// Avoid placing executable logic (e.g., side-effects) above imports.
```

Example (dynamic import justified in a test):

```ts
// Necessary for isolation after we set up mocks
const { loadDocumentations } = await import("../../src/documentations.js");
```

- **Template merge guidance:** This repository is a template and its instruction files under `.github/instructions/` may be periodically merged into repositories created from this template. For downstream repositories, prefer making minimal edits to template instruction files and, whenever practical, add a new repo-specific instruction file (for example, `.github/instructions/<your-repo>.instructions.md`) to capture local overrides. Keeping template files minimally changed reduces merge conflicts when pulling upstream template changes; when a template file must be edited, document the rationale and link to a short issue or PR in your repository.

### Linked Instructions & Skills

- [.github/instructions/typescript.instructions.md](./.github/instructions/typescript.instructions.md) — TypeScript standards
- [.github/instructions/localization.instructions.md](./.github/instructions/localization.instructions.md) — Localization rules
- [.github/instructions/commit-message.instructions.md](./.github/instructions/commit-message.instructions.md) — Commit message convention
- [.github/skills/plugin-testing/SKILL.md](./.github/skills/plugin-testing/SKILL.md) — Plugin testing skill
- [.github/instructions/agents.instructions.md](.github/instructions/agents.instructions.md) — AI agent quick rules

---

## 8. For AI Coding Agents 🤖 🔍

This section contains concise, actionable rules and project-specific examples to help AI agents be productive immediately.

- Read this file first. When in doubt, follow concrete examples in `src/`, `scripts/`, and `tests/` rather than generic advice.
- Start by inspecting `src/main.ts`, `src/settings-data.ts`, and `assets/locales.ts` to learn core patterns: Manager classes (LanguageManager, SettingsManager), `.fix()` validators, and `PluginLocales` usage.
- Settings pattern: always prefer `.fix()` functions (see `Settings.fix`/`LocalSettings.fix`) to validate/normalize external inputs before persisting or mutating settings.
- I18n: use `createI18n(PluginLocales.RESOURCES, ...)` and `language.value.t(...)` for translations. Never hardcode translatable strings—use existing translation keys in `assets/locales/`.
- Build/Dev pattern: `scripts/build.mjs` uses esbuild `context()`; pass `dev` as argv[2] to enable watch mode. Tests mock `esbuild` in `tests/scripts/build.test.mjs`—use those tests as canonical examples for safe refactors.
- Script behavior: `scripts/obsidian-install.mjs` exits 1 with a short error message when `manifest.json` is missing. Make changes in scripts with tests mirroring error conditions (see `tests/scripts/obsidian-install.test.mjs`).
- Test conventions: `*.spec.*` = unit (fast, isolated); `*.test.*` = integration (may use filesystem or child processes). Follow the one-test-file-per-source-file convention and place tests under `tests/` mirroring `src/`.
- Formatting & linting: run `pnpm run format` and `pnpm run check` before committing. CI uses `pnpm install --frozen-lockfile`.
- Commit rules for agents: use Conventional Commits; run `npm run commitlint` locally when appropriate. Keep headers ≤100 chars and wrap bodies at 100 chars.
- Localization rule for agents: when adding text keys, update `assets/locales/en/translation.json` first and add tests or localization notes. Follow `.github/instructions/localization.instructions.md`.
- PR checklist (brief): add/modify tests, run `pnpm exec vitest run "tests/**/*.spec.{js,ts,mjs}"` locally for fast checks, run `pnpm run check`, add changeset when changing public API or version, and update `AGENTS.md` if you changed infra or agent-visible patterns.

> Note: Keep suggestions and changes small and well-scoped. Prefer to add tests first for behavioral changes and follow the test naming conventions above.

---

For unclear or incomplete sections, provide feedback to improve this guide for future agents.
