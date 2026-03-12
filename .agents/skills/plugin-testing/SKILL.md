---
name: plugin-testing
description: Skill for testing Obsidian plugin features in obsidian-plugin-template. Use for automated, manual, and integration test workflows specific to Obsidian plugins.
---

# Plugin Testing Skill — obsidian-plugin-template

> **Note:** Always prefer `pnpm` over `npm` if possible. Use `pnpm` for all commands unless you have a specific reason to use `npm`. Both are shown below for compatibility.

Use this skill to guide both automated and manual testing of Obsidian plugin features. Ensure all tests reflect real plugin usage and production-like conditions.

## Key Testing Principles

- Always build the plugin before testing (`pnpm build`).
- Use the install script to deploy to a test vault (`pnpm obsidian:install <vault>` preferred).
- Helpful scripts for testing:
  - `pnpm build` — build before running tests or manual testing
  - `pnpm obsidian:install <vault>` — install the built plugin into a test vault
  - `pnpm run format` — format code before testing if needed
  - `pnpm run check` — run lint & formatting checks
- Test settings UI for load, save, and persistence.
- Validate localization for all supported languages.
- Confirm plugin lifecycle events (load/unload) work as expected.

## Test File Conventions

- `*.spec.{ts,js,mjs}` — **Unit tests (BDD-style)**: focus on behaviour and small, isolated units. Prefer tests that are fast and hermetic.
- `*.test.{ts,js,mjs}` — **Integration tests (TDD-style)**: focus on integration between components or with the environment; keep them well documented and isolated.

Run unit-only suites with the Vitest CLI:

```shell
pnpm exec vitest run "tests/**/*.spec.{js,ts,mjs}" --coverage
```

And integration-only suites with:

```shell
pnpm exec vitest run "tests/**/*.test.{js,ts,mjs}" --coverage
```

## Test File Structure

- Follow a **one test file per source file** rule: mirrors the source directory tree under `tests/` (for both `*.spec.*` and `*.test.*`). Prefer a single test file per source (either a `*.spec.*` unit test or a `*.test.*` integration test). If a source requires both unit and integration coverage, having both a `*.spec.*` and a `*.test.*` file is acceptable — treat them together as the logical "one test file" for that source and keep their locations aligned for discoverability.
- Keep names aligned with source files for discoverability: `src/path/to/module.js` -> `tests/unit/path/to/module.spec.js`.
- If a test file would become unreasonably large, splitting is allowed but should be a rare exception; include a brief header comment explaining the reason and the mapping across split files.

For the full list and usage of scripts, see the **Scripts (package.json)** section in `AGENTS.md`.

## Example Test Workflow

1. **Build:**
    - Run: `pnpm build` (preferred) or `npm run build`
2. **Install:**
    - Run: `pnpm obsidian:install <vault directory>` (preferred).
3. **Settings UI:**
    - Open plugin settings in Obsidian
    - Change and save settings; reload plugin and verify persistence
4. **Localization:**
    - Switch Obsidian language; verify all UI text updates accordingly
5. **Lifecycle:**
    - Reload or disable/enable the plugin; ensure all managers register/unload cleanly

## References

- See [src/main.ts](../../../src/main.ts) for plugin entry and lifecycle
- For integration, ensure settings and localization are loaded as in production
