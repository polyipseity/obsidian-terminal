#!/usr/bin/env bun
/**
 * Push rolling tag to origin on default branch.
 *
 * Runs as pre-push hook.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createRollingTag, isOnDefaultBranch } from "./git-rolling-tag.mjs";
const execP = promisify(exec);

async function main() {
  if (await isOnDefaultBranch()) {
    await createRollingTag();
    await execP("git push --no-verify --force origin rolling", {
      encoding: "utf-8",
    });
  }
}

main().catch((/** @type {unknown} */ error) => {
  console.error(
    "Error pushing rolling tag:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
