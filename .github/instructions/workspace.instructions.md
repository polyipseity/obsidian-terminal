---
name: Workspace Quick Instructions (agents)
applyTo: "**/*"
description: One‑page quick reference for AI agents working in this repository
---

# Workspace quick‑instructions — obsidian-terminal

A single‑page, action‑oriented reference for AI agents. Keep this short; use `AGENTS.md` as the canonical source of policy and rationale.

## Purpose ✨

- Fast onboarding for agents: exact commands, files to read first, common pitfalls, and example prompts.
- Keep changes minimal and always add/adjust tests for behavioral changes.

## Quick start (exact commands) ▶️

- Install deps (preferred): `pnpm install`
- Dev / watch build: `pnpm run build:dev`
- Production build: `pnpm build`
- Run unit tests (non-interactive):
  `pnpm exec vitest run "tests/**/*.spec.{js,ts,mjs}" --coverage`
- Run full test suite: `pnpm test`
- Install to Obsidian vault: `pnpm run obsidian:install <VAULT_PATH>`
- Lint & format checks: `pnpm run check` / `pnpm run format`

> Agent note: always use `vitest run` (avoid default/watch mode). Use `pnpm` where possible.

## Read‑first files (top priority) 📚

- `AGENTS.md` — canonical agent rules
- `src/main.ts` — plugin lifecycle
- `src/settings-data.ts` — settings schema & `.fix()`
- `src/settings.ts` — settings UI/registration
- `src/terminal/load.ts` — terminal feature entry points
- `assets/locales.ts` — i18n resources
- `scripts/build.mjs` — build/watch behavior
- `vitest.config.mts` — test runner config

## Tests & PR checklist ✅

- Add tests before implementing behavior changes. Follow **one test file per source file**.
- Unit = `*.spec.*` (fast, hermetic). Integration = `*.test.*` (may use filesystem/processes).
- Agents must run `vitest run` (non‑interactive) in CI or local verification.
- Update `AGENTS.md` when changing infra, conventions, or agent‑visible behavior.

## Common pitfalls & environment notes ⚠️

- Preferred package manager: `pnpm` (CI: `pnpm install --frozen-lockfile`). Use `npm` only as a fallback.
- Vitest defaults to watch; **do not** run Vitest without `run`/`--run` in automated agent flows.
- `scripts/obsidian-install.mjs` exits non‑zero (concise message) if `manifest.json` is missing — tests rely on this.
- Python checks require `uv` and Python 3.11+ for some tasks used by `pnpm test`.
- Localization rule: add keys to `assets/locales/en/translation.json` first and add tests to verify resources.
- Python modules: each must declare a top‑level `__all__` tuple.
- Commit messages: Conventional Commits; header ≤72 chars; run `npm run commitlint`.

## Example agent prompts you can run now 🧭

- "Add a unit test for `Settings.fix()` that verifies profile defaults; run `pnpm exec vitest run` and report failures."
- "When adding or removing translation keys in `assets/locales/en/translation.json`, run `node scripts/sync-locale-keys.mjs` to propagate and sort them."
- "Add a `dev` alias to `package.json` pointing to `build:dev`, update `AGENTS.md`, and add a test asserting `scripts.dev` exists."
- "Add an integration test for `scripts/obsidian-install.mjs` to assert exit when `manifest.json` is missing."
- "Add localization key `settings.example` to `assets/locales/en/translation.json` and a test verifying it exists."

## Runnability checks (tests & CI) ✅

- Every example prompt that makes a concrete repository change should include an automated verification (unit test, integration test, or CI check) where practical. Prefer small, hermetic tests that validate the prompt's observable outcome.
- Example runnable checks to implement for prompts in this file:
  - `tests/workspace-instructions.spec.ts` — assert the instruction file exists and contains the example prompts (keeps prompts actionable).
  - Add unit tests under `tests/src/` for behavioral prompts (for example, a `Settings.fix()` test when adding or changing settings behaviour).
  - Add script checks under `tests/scripts/` for npm script changes (for example, assert `package.json` contains `scripts.dev`).
- CI policy: include runnable checks in the main test suite so example prompts remain verifiable and kept up-to-date.

## Suggested next agent‑customizations (short) 🔧

- create-instruction: Add `.github/instructions/<area>.md` for area‑specific rules (e.g., `terminal.instructions.md`).
- create-prompt: Provide ready prompts for common tasks like `add-test-for-X` or `update-locales`.
- create-skill: Add a `plugin-testing` skill example (fixtures + mocks) if more integration tests are needed.

## Where to update canonical guidance 📎

- `AGENTS.md` is the canonical/authoritative document. Keep this file as a concise quick‑reference and mirror any policy changes into `AGENTS.md`.

---

Keep this file short and update it whenever you add a new agent prompt, common pitfall, or verification command.
