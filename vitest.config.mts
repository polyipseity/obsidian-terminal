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
export default defineConfig({
  test: {
    include: ["tests/**/*.spec.{ts,js}"],
  },
});
