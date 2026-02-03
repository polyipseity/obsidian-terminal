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
