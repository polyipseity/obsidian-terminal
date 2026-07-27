#!/usr/bin/env bun
/**
 * Push rolling tag to origin on default branch.
 *
 * Runs as pre-push hook.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
const execP = promisify(exec);

async function main() {
  const { stdout: branchStdout } = await execP(
    "git rev-parse --abbrev-ref HEAD",
    {
      encoding: "utf-8",
    },
  );
  const currentBranch = branchStdout.trim();

  const { stdout: defaultStdout } = await execP(
    "git rev-parse --abbrev-ref origin/HEAD | sed 's@origin/@@'",
    { encoding: "utf-8", shell: "/bin/bash" },
  );
  const defaultBranch = defaultStdout.trim();

  if (currentBranch === defaultBranch) {
    await execP("git push --no-verify --force origin rolling");
  }
}

main().catch((/** @type {unknown} */ error) => {
  console.error(
    "Error pushing rolling tag:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
