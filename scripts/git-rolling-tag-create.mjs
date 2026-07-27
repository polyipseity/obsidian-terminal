#!/usr/bin/env bun
/**
 * Create/update rolling tag on default branch after commit.
 *
 * Runs as post-commit hook.
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
    await execP("git tag --force --sign rolling --message rolling");
  }
}

main().catch((error) => {
  console.error("Error creating rolling tag:", error.message);
  process.exit(1);
});
