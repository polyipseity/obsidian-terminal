#!/usr/bin/env bun
/**
 * Configure rolling tag refspecs and update the rolling tag, optionally
 * pushing it to origin.
 *
 * Usage: git-rolling-tag.mjs <config|create|push>
 *   config — post-checkout/post-merge hook: ensure the rolling refspec is set
 *     so `git fetch` can force-update the tag.
 *   create — post-commit hook: (re)create the tag at HEAD when stale.
 *   push   — pre-push hook: (re)create the tag, then force-push it to origin.
 */

import { exec } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const execP = promisify(exec);

/** Whether the current branch is the origin default branch. */
export async function isOnDefaultBranch() {
  const { stdout: branchStdout } = await execP(
    "git rev-parse --abbrev-ref HEAD",
    { encoding: "utf-8" },
  );
  const currentBranch = branchStdout.trim();

  const { stdout: defaultStdout } = await execP(
    "git rev-parse --abbrev-ref origin/HEAD | sed 's@origin/@@'",
    { encoding: "utf-8", shell: "/bin/bash" },
  );
  const defaultBranch = defaultStdout.trim();

  return currentBranch === defaultBranch;
}

/** Create/update the rolling tag to point at HEAD if it does not already. */
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

/** Force-push the rolling tag to origin. */
export async function pushRollingTag() {
  await execP("git push --no-verify --force origin rolling", {
    encoding: "utf-8",
  });
}

/** Configure the rolling refspec so `git fetch` can force-update the tag. */
export async function configureRollingRefspec() {
  // `|| true` makes empty stdout the signal that the refspec is not set.
  const { stdout } = await execP(
    "git config --local --get-all remote.origin.fetch | grep -c '^+refs/tags/rolling:' || true",
    { encoding: "utf-8" },
  );
  // Note: an empty stdout parses to NaN, so check `> 0` (not `<= 0`) so a
  // missing refspec count still triggers the add.
  if (parseInt(stdout.trim()) > 0) {
    return;
  }
  await execP(
    "git config --local --add remote.origin.fetch '+refs/tags/rolling:refs/tags/rolling'",
    { encoding: "utf-8" },
  );
}

/**
 * Run one rolling-tag hook action. Failures are reported to stderr and exit
 * with status 1, matching expected git hook behavior.
 * @param {string} action The hook action: `config`, `create`, or `push`.
 */
export async function run(action) {
  try {
    if (action === "config") {
      await configureRollingRefspec();
    } else if (action === "create" || action === "push") {
      // Both actions gate on the default branch; push then also force-pushes.
      if (await isOnDefaultBranch()) {
        await createRollingTag();
        if (action === "push") {
          await pushRollingTag();
        }
      }
    } else {
      throw new Error(
        `unknown action: expected 'config', 'create' or 'push', got '${action}'`,
      );
    }
  } catch (error) {
    console.error(
      "Error running rolling tag hook:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }
}

// Run as a CLI only when invoked directly, not when imported (e.g. by tests).
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  void run(process.argv[2] ?? "");
}
