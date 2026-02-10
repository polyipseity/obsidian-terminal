/**
 * Vitest configuration (minimal)
 *
 * Notes (follow `package.json` scripts):
 * - Tests live under `tests/` and should be named `*.spec.ts` or `*.spec.js`.
 * - Non-interactive / CI (coverage): `pnpm test` or `npm run test` runs `vitest run --coverage`.
 * - Interactive / watch: `pnpm run test:watch` or `npm run test:watch`.
 * - Pre-push hook runs `npm run test` (see `.husky/pre-push`).
 *
 * Keep this file intentionally minimal. If you change test behavior or add coverage
 * providers, document that in `AGENTS.md`.
 */

import { defineConfig } from "vitest/config";

// Minimal config: only the test globs are required for this project
// Naming convention and intent:
// - Unit tests (BDD-style): `*.spec.{ts,js,mjs}` — focus on behavior; keep small and hermetic.
// - Integration tests (TDD-style): `*.test.{ts,js,mjs}` — focus on integration and implementation verification.
// Project convention: prefer **one test file per source file**. Tests should mirror the source
// directory structure under `tests/` for both unit/spec tests and
// integration/test suites (e.g. `src/utils/foo.js` -> `tests/utils/foo.spec.js`).
// Only split test files in rare cases when a single file becomes unreasonably long.
// Both `*.spec.*` and `*.test.*` are included below; run specific sets with the Vitest CLI if desired.
export default defineConfig({
  // Treat markdown as assets so imports like `import md from "../README.md"` resolve to a string
  assetsInclude: ["**/*.md"],
  test: {
    include: ["tests/**/*.spec.{ts,js,mjs}", "tests/**/*.test.{ts,js,mjs}"],
    setupFiles: ["tests/setup.ts"],
  },
});
