#!/usr/bin/env bun
/**
 * Configure rolling tag to allow force updates during fetch.
 * Ensures 'git fetch' can update the rolling tag without user intervention.
 *
 * Runs as post-checkout hook.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
const execP = promisify(exec);

async function main() {
  const { stdout } = await execP(
    "git config --local --get-all remote.origin.fetch | grep -c '^+refs/tags/rolling:' || true",
    { encoding: "utf-8" },
  );

  const hasRollingRefspec = parseInt(stdout.trim()) > 0;

  if (!hasRollingRefspec) {
    await execP(
      "git config --local --add remote.origin.fetch '+refs/tags/rolling:refs/tags/rolling'",
    );
  }
}

main().catch((error) => {
  console.error("Error configuring rolling refspec:", error.message);
  process.exit(1);
});
