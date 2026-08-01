// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit spec for scripts/git-rolling-tag.mjs — the shared rolling tag logic used
// by the post-commit and pre-push hooks: default-branch detection and
// create-on-demand rolling tag updates.

// promisify(exec) on a mocked exec (no promisify.custom) resolves the single
// value passed to the callback, so the mock must pass the { stdout, stderr }
// object the module destructures.
type ExecCallback = (
  error: Error | null,
  result?: { readonly stdout: string; readonly stderr: string },
) => void;

const COMMANDS = Object.freeze({
  branch: "git rev-parse --abbrev-ref HEAD",
  defaultBranch: "git rev-parse --abbrev-ref origin/HEAD | sed 's@origin/@@'",
  head: "git rev-parse HEAD",
  rolling: "git rev-parse --verify --quiet 'rolling^{commit}' || true",
  createTag: "git tag --force --sign rolling --message rolling",
});

// The mock succeeds for every command (recording it) and only uses the map for
// stdout; a command missing from the map yields empty stdout, which represents
// the rolling tag not existing yet.
function mockExec(stdoutByCommand: ReadonlyMap<string, string> = new Map()) {
  const execMock = vi.fn(
    (command: string, _options: unknown, callback: ExecCallback) => {
      callback(null, {
        stdout: stdoutByCommand.get(command) ?? "",
        stderr: "",
      });
    },
  );
  vi.doMock("node:child_process", () => ({ exec: execMock }));
  return execMock;
}

type ExecMock = ReturnType<typeof mockExec>;

function expectExecuted(execMock: ExecMock, command: string) {
  expect(execMock.mock.calls.some((call) => call[0] === command)).toBe(true);
}

function expectNotExecuted(execMock: ExecMock, command: string) {
  expect(execMock.mock.calls.some((call) => call[0] === command)).toBe(false);
}

describe("scripts/git-rolling-tag.mjs", () => {
  beforeEach(() => vi.resetModules());

  it("isOnDefaultBranch returns true on the default branch", async () => {
    const execMock = mockExec(
      new Map([
        [COMMANDS.branch, "main\n"],
        [COMMANDS.defaultBranch, "main\n"],
      ]),
    );

    const { isOnDefaultBranch } =
      await import("../../scripts/git-rolling-tag.mjs");

    await expect(isOnDefaultBranch()).resolves.toBe(true);
    expectExecuted(execMock, COMMANDS.branch);
    expectExecuted(execMock, COMMANDS.defaultBranch);
  });

  it("isOnDefaultBranch returns false on other branches", async () => {
    mockExec(
      new Map([
        [COMMANDS.branch, "feature\n"],
        [COMMANDS.defaultBranch, "main\n"],
      ]),
    );

    const { isOnDefaultBranch } =
      await import("../../scripts/git-rolling-tag.mjs");

    await expect(isOnDefaultBranch()).resolves.toBe(false);
  });

  it("createRollingTag recreates the tag when it points elsewhere", async () => {
    const execMock = mockExec(
      new Map([
        [COMMANDS.head, "abc123\n"],
        [COMMANDS.rolling, "def456\n"],
      ]),
    );

    const { createRollingTag } =
      await import("../../scripts/git-rolling-tag.mjs");

    await createRollingTag();
    expectExecuted(execMock, COMMANDS.createTag);
  });

  it("createRollingTag creates the tag when it does not exist", async () => {
    const execMock = mockExec(new Map([[COMMANDS.head, "abc123\n"]]));

    const { createRollingTag } =
      await import("../../scripts/git-rolling-tag.mjs");

    await createRollingTag();
    expectExecuted(execMock, COMMANDS.createTag);
  });

  it("createRollingTag skips when the tag already points to HEAD", async () => {
    const execMock = mockExec(
      new Map([
        [COMMANDS.head, "abc123\n"],
        [COMMANDS.rolling, "abc123\n"],
      ]),
    );

    const { createRollingTag } =
      await import("../../scripts/git-rolling-tag.mjs");

    await createRollingTag();
    expectNotExecuted(execMock, COMMANDS.createTag);
  });
});
