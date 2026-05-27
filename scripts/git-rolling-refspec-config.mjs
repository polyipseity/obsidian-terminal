#!/usr/bin/env bun
/**
 * Configure rolling tag to allow force updates during fetch.
 * Ensures 'git fetch' can update the rolling tag without user intervention.
 *
 * Runs as post-checkout hook.
 */

import { execSync } from "child_process";

try {
  const output = execSync(
    "git config --local --get-all remote.origin.fetch | grep -c '^+refs/tags/rolling:' || true",
    { encoding: "utf-8" },
  ).trim();

  const hasRollingRefspec = parseInt(output) > 0;

  if (!hasRollingRefspec) {
    execSync(
      "git config --local --add remote.origin.fetch '+refs/tags/rolling:refs/tags/rolling'",
    );
  }
} catch (error) {
  console.error("Error configuring rolling refspec:", error.message);
  process.exit(1);
}
