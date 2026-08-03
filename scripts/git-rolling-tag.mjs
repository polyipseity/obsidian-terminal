#!/usr/bin/env bun
/**
 * Configure rolling tag refspecs and update the rolling tag, optionally
 * pushing it to the upstream remote.
 *
 * Usage: git-rolling-tag.mjs <config|create|push>
 *   config — post-checkout/post-merge hook: ensure the rolling refspec is set
 *     so `git fetch` can force-update the tag.
 *   create — post-commit hook: (re)create the tag at HEAD when stale.
 *   push   — pre-push hook: (re)create the tag, then force-push it.
 *
 * All git invocations use fully-qualified refs and resolve the upstream
 * remote from the current branch's configuration instead of assuming
 * `origin`. Non-applicable states (unborn or detached HEAD, missing remote,
 * missing ref) are reported with a warning and skipped rather than aborting
 * the surrounding git operation.
 */

import { exec } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const execP = promisify(exec);

/** Customizable message attached to the rolling tag on creation/update. */
const _TAG_MESSAGE = "rolling";

/**
 * Run a git command without throwing on a non-zero exit. Returns the
 * trimmed stdout, stderr, and exit code so callers can treat "absent"
 * states (an unset ref, config key, or remote) as ordinary results.
 * @param {string} command The git command to run.
 */
async function git(command) {
  try {
    const { stdout, stderr } = await execP(command, { encoding: "utf-8" });
    return { stdout: stdout.trim(), stderr, exitCode: 0 };
  } catch (error) {
    // Only child_process exec errors (the command ran and exited non-zero)
    // carry a numeric `code`; spawn failures (git missing, etc.) must
    // propagate as real failures.
    const code = /** @type {{ code?: unknown }} */ (error).code;
    if (typeof code !== "number") throw error;
    const stdoutValue = /** @type {{ stdout?: unknown }} */ (error).stdout;
    const stderrValue = /** @type {{ stderr?: unknown }} */ (error).stderr;
    return {
      stdout: (typeof stdoutValue === "string" ? stdoutValue : "").trim(),
      stderr: typeof stderrValue === "string" ? stderrValue : "",
      exitCode: code,
    };
  }
}

/**
 * Single-quote `value` for safe interpolation into a shell command.
 * @param {string} value The value to quote.
 */
function shq(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Resolve the current branch's upstream remote name, or `null` if absent.
 * @param {string} branch The current branch name.
 */
async function getRemote(branch) {
  const remote = await git(`git config --get branch.${shq(branch)}.remote`);
  if (remote.exitCode !== 0 || remote.stdout === "") return null;
  return remote.stdout;
}

/** Whether the current branch is the upstream remote's default branch. */
export async function isOnDefaultBranch() {
  const branch = await git("git rev-parse --abbrev-ref --verify HEAD");
  if (branch.exitCode !== 0) {
    console.warn("Rolling tag hook: no commits yet; skipping.");
    return false;
  }
  const currentBranch = branch.stdout;
  if (currentBranch === "HEAD") {
    console.warn("Rolling tag hook: detached HEAD; skipping.");
    return false;
  }
  const remote = await getRemote(currentBranch);
  if (remote === null) {
    console.warn("Rolling tag hook: no upstream remote; skipping.");
    return false;
  }
  const defaultBranch = await git(
    `git symbolic-ref --quiet refs/remotes/${shq(remote)}/HEAD`,
  );
  if (defaultBranch.exitCode !== 0 || defaultBranch.stdout === "") {
    console.warn(
      `Rolling tag hook: cannot determine default branch of '${remote}' (run 'git remote set-head ${remote} -a'); skipping.`,
    );
    return false;
  }
  const defaultBranchName = defaultBranch.stdout.replace(
    `refs/remotes/${remote}/`,
    "",
  );
  return currentBranch === defaultBranchName;
}

/** Create/update the rolling tag to point at HEAD if it does not already. */
export async function createRollingTag() {
  const head = await git("git rev-parse --verify 'HEAD^{commit}'");
  if (head.exitCode !== 0 || head.stdout === "") {
    console.warn("Rolling tag hook: cannot resolve HEAD; skipping tag update.");
    return;
  }
  // Absence of the tag shows up as a non-zero exit or empty stdout.
  const rolling = await git(
    "git rev-parse --verify --quiet 'refs/tags/rolling^{commit}'",
  );
  if (rolling.stdout !== head.stdout) {
    await git(`git tag --force --sign rolling --message ${shq(_TAG_MESSAGE)}`);
  }
}

/** Force-push the rolling tag to the upstream remote. */
export async function pushRollingTag() {
  const branch = await git("git rev-parse --abbrev-ref --verify HEAD");
  if (
    branch.exitCode !== 0 ||
    branch.stdout === "" ||
    branch.stdout === "HEAD"
  ) {
    console.warn("Rolling tag hook: no current branch; skipping push.");
    return;
  }
  const remote = await getRemote(branch.stdout);
  if (remote === null) {
    console.warn("Rolling tag hook: no upstream remote; skipping push.");
    return;
  }
  const rolling = await git(
    "git rev-parse --verify --quiet 'refs/tags/rolling^{commit}'",
  );
  if (rolling.exitCode !== 0 || rolling.stdout === "") {
    console.warn(
      "Rolling tag hook: rolling tag does not exist; skipping push.",
    );
    return;
  }
  await git(
    `git push --no-verify --force ${shq(remote)} refs/tags/rolling:refs/tags/rolling`,
  );
}

/** Configure the rolling refspec so `git fetch` can force-update the tag. */
export async function configureRollingRefspec() {
  const branch = await git("git rev-parse --abbrev-ref --verify HEAD");
  if (
    branch.exitCode !== 0 ||
    branch.stdout === "" ||
    branch.stdout === "HEAD"
  ) {
    console.warn(
      "Rolling tag hook: no current branch; skipping refspec configuration.",
    );
    return;
  }
  const remote = await getRemote(branch.stdout);
  if (remote === null) {
    console.warn(
      "Rolling tag hook: no upstream remote; skipping refspec configuration.",
    );
    return;
  }
  const url = await git(`git config --get remote.${shq(remote)}.url`);
  if (url.exitCode !== 0 || url.stdout === "") {
    console.warn(
      `Rolling tag hook: remote '${remote}' is not configured; skipping refspec configuration.`,
    );
    return;
  }
  const refspecs = await git(
    `git config --local --get-all remote.${shq(remote)}.fetch`,
  );
  const hasRefspec = refspecs.stdout
    .split("\n")
    .some((line) => /^\+refs\/tags\/rolling:/.test(line));
  if (!hasRefspec) {
    await git(
      `git config --local --add remote.${shq(remote)}.fetch '+refs/tags/rolling:refs/tags/rolling'`,
    );
  }
}

/**
 * Format a thrown value for hook failure output, appending command stderr
 * when the error carries it.
 * @param {unknown} error The thrown value.
 */
function formatError(error) {
  if (!(error instanceof Error)) return String(error);
  const stderr = /** @type {{ stderr?: unknown }} */ (error).stderr;
  const details =
    typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : "";
  if (details === "") return error.message;
  return error.message === "" ? details : `${error.message}: ${details}`;
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
    console.error("Error running rolling tag hook:", formatError(error));
    process.exit(1);
  }
}

// Run as a CLI only when invoked directly, not when imported (e.g. by tests).
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  void run(process.argv[2] ?? "");
}
