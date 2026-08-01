#!/usr/bin/env bun
/**
 * Create/update rolling tag on default branch after commit.
 *
 * Runs as post-commit hook.
 */

import { createRollingTag, isOnDefaultBranch } from "./git-rolling-tag.mjs";

async function main() {
  if (await isOnDefaultBranch()) {
    await createRollingTag();
  }
}

main().catch((/** @type {unknown} */ error) => {
  console.error(
    "Error creating rolling tag:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
