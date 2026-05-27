#!/usr/bin/env bun
/**
 * Push rolling tag to origin on default branch.
 *
 * Runs as pre-push hook.
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
    execSync("git push --no-verify --force origin rolling");
  }
} catch (error) {
  console.error("Error pushing rolling tag:", error.message);
  process.exit(1);
}
