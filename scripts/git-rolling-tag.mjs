/**
 * Shared rolling tag logic for the post-commit and pre-push hooks.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
const execP = promisify(exec);

/** Whether the current branch is the origin default branch. */
export async function isOnDefaultBranch() {
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

  return currentBranch === defaultBranch;
}

/**
 * Create/update the rolling tag to point at HEAD if it does not already.
 */
export async function createRollingTag() {
  const { stdout: headStdout } = await execP("git rev-parse HEAD", {
    encoding: "utf-8",
  });
  const head = headStdout.trim();

  // `|| true` makes empty stdout the signal that the tag does not exist yet.
  const { stdout: rollingStdout } = await execP(
    "git rev-parse --verify --quiet 'rolling^{commit}' || true",
    { encoding: "utf-8" },
  );
  if (rollingStdout.trim() !== head) {
    await execP("git tag --force --sign rolling --message rolling", {
      encoding: "utf-8",
    });
  }
}
