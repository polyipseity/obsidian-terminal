#!/usr/bin/env bun
/**
 * Create/update rolling tag on default branch after commit.
 *
 * Runs as post-commit hook.
 */

import { execSync } from "child_process";

try {
  const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
    encoding: "utf-8",
  }).trim();

  const defaultBranch = execSync(
    "git rev-parse --abbrev-ref origin/HEAD | sed 's@origin/@@'",
    { encoding: "utf-8", shell: "/bin/bash" },
  ).trim();

  if (currentBranch === defaultBranch) {
    execSync("git tag --force --sign rolling --message rolling");
  }
} catch (error) {
  console.error("Error creating rolling tag:", error.message);
  process.exit(1);
}
