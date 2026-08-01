// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit spec for scripts/git-rolling-tag.mjs — the single rolling-tag hook
// script. Covers the exported helpers (default-branch detection, create-on-
// demand tag updates, force-push, refspec configuration) and the `config` /
// `create` / `push` CLI actions run by the post-checkout, post-merge,
// post-commit, and pre-push prek hooks, including their error handling.

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
  pushTag: "git push --no-verify --force origin rolling",
  refspecCount:
    "git config --local --get-all remote.origin.fetch | grep -c '^+refs/tags/rolling:' || true",
  addRefspec:
    "git config --local --add remote.origin.fetch '+refs/tags/rolling:refs/tags/rolling'",
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

// Re-import the module fresh (vi.resetModules() in beforeEach discards the
// previous copy) without repeating the path in every test.
async function importModule() {
  return await import("../../scripts/git-rolling-tag.mjs");
}

// The failure path logs to console.error and exits 1; spy on both so tests
// can assert them without terminating the test process.
function mockErrorExit() {
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitMock = vi
    .spyOn(process, "exit")
    .mockImplementation(() => undefined as never);
  return { errSpy, exitMock };
}

describe("scripts/git-rolling-tag.mjs", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  describe("isOnDefaultBranch", () => {
    it("returns true on the default branch", async () => {
      const execMock = mockExec(
        new Map([
          [COMMANDS.branch, "main\n"],
          [COMMANDS.defaultBranch, "main\n"],
        ]),
      );

      const { isOnDefaultBranch } = await importModule();

      await expect(isOnDefaultBranch()).resolves.toBe(true);
      expectExecuted(execMock, COMMANDS.branch);
      expectExecuted(execMock, COMMANDS.defaultBranch);
    });

    it("returns false on other branches", async () => {
      mockExec(
        new Map([
          [COMMANDS.branch, "feature\n"],
          [COMMANDS.defaultBranch, "main\n"],
        ]),
      );

      const { isOnDefaultBranch } = await importModule();

      await expect(isOnDefaultBranch()).resolves.toBe(false);
    });
  });

  describe("createRollingTag", () => {
    it("recreates the tag when it points elsewhere", async () => {
      const execMock = mockExec(
        new Map([
          [COMMANDS.head, "abc123\n"],
          [COMMANDS.rolling, "def456\n"],
        ]),
      );

      const { createRollingTag } = await importModule();

      await createRollingTag();
      expectExecuted(execMock, COMMANDS.createTag);
    });

    it("creates the tag when it does not exist", async () => {
      const execMock = mockExec(new Map([[COMMANDS.head, "abc123\n"]]));

      const { createRollingTag } = await importModule();

      await createRollingTag();
      expectExecuted(execMock, COMMANDS.createTag);
    });

    it("skips when the tag already points to HEAD", async () => {
      const execMock = mockExec(
        new Map([
          [COMMANDS.head, "abc123\n"],
          [COMMANDS.rolling, "abc123\n"],
        ]),
      );

      const { createRollingTag } = await importModule();

      await createRollingTag();
      expectNotExecuted(execMock, COMMANDS.createTag);
    });
  });

  describe("configureRollingRefspec", () => {
    it("adds the refspec when it is not set", async () => {
      const execMock = mockExec(new Map([[COMMANDS.refspecCount, "\n"]]));

      const { configureRollingRefspec } = await importModule();

      await configureRollingRefspec();
      expectExecuted(execMock, COMMANDS.addRefspec);
    });

    it("skips when the refspec is already set", async () => {
      const execMock = mockExec(new Map([[COMMANDS.refspecCount, "1\n"]]));

      const { configureRollingRefspec } = await importModule();

      await configureRollingRefspec();
      expectNotExecuted(execMock, COMMANDS.addRefspec);
    });
  });

  describe("run('config')", () => {
    it("configures the refspec", async () => {
      const execMock = mockExec(new Map([[COMMANDS.refspecCount, "\n"]]));

      const { run } = await importModule();

      await run("config");
      expectExecuted(execMock, COMMANDS.refspecCount);
      expectExecuted(execMock, COMMANDS.addRefspec);
    });
  });

  describe("run('create')", () => {
    it("creates the tag on the default branch", async () => {
      const execMock = mockExec(
        new Map([
          [COMMANDS.branch, "main\n"],
          [COMMANDS.defaultBranch, "main\n"],
          [COMMANDS.head, "abc123\n"],
          [COMMANDS.rolling, "def456\n"],
        ]),
      );

      const { run } = await importModule();

      await run("create");
      expectExecuted(execMock, COMMANDS.createTag);
      expectNotExecuted(execMock, COMMANDS.pushTag);
    });

    it("does nothing on non-default branches", async () => {
      const execMock = mockExec(
        new Map([
          [COMMANDS.branch, "feature\n"],
          [COMMANDS.defaultBranch, "main\n"],
        ]),
      );

      const { run } = await importModule();

      await run("create");
      expectExecuted(execMock, COMMANDS.branch);
      expectExecuted(execMock, COMMANDS.defaultBranch);
      expectNotExecuted(execMock, COMMANDS.createTag);
    });
  });

  describe("run('push')", () => {
    it("recreates the tag when it points elsewhere, then pushes", async () => {
      const execMock = mockExec(
        new Map([
          [COMMANDS.branch, "main\n"],
          [COMMANDS.defaultBranch, "main\n"],
          [COMMANDS.head, "abc123\n"],
          [COMMANDS.rolling, "def456\n"],
        ]),
      );

      const { run } = await importModule();

      await run("push");
      expectExecuted(execMock, COMMANDS.createTag);
      expectExecuted(execMock, COMMANDS.pushTag);
    });

    it("creates the tag when it does not exist, then pushes", async () => {
      const execMock = mockExec(
        new Map([
          [COMMANDS.branch, "main\n"],
          [COMMANDS.defaultBranch, "main\n"],
          [COMMANDS.head, "abc123\n"],
        ]),
      );

      const { run } = await importModule();

      await run("push");
      expectExecuted(execMock, COMMANDS.createTag);
      expectExecuted(execMock, COMMANDS.pushTag);
    });

    it("pushes without recreating the tag when it already points to HEAD", async () => {
      const execMock = mockExec(
        new Map([
          [COMMANDS.branch, "main\n"],
          [COMMANDS.defaultBranch, "main\n"],
          [COMMANDS.head, "abc123\n"],
          [COMMANDS.rolling, "abc123\n"],
        ]),
      );

      const { run } = await importModule();

      await run("push");
      expectExecuted(execMock, COMMANDS.pushTag);
      expectNotExecuted(execMock, COMMANDS.createTag);
    });

    it("does nothing on non-default branches", async () => {
      const execMock = mockExec(
        new Map([
          [COMMANDS.branch, "feature\n"],
          [COMMANDS.defaultBranch, "main\n"],
        ]),
      );

      const { run } = await importModule();

      await run("push");
      expectExecuted(execMock, COMMANDS.branch);
      expectExecuted(execMock, COMMANDS.defaultBranch);
      expectNotExecuted(execMock, COMMANDS.createTag);
      expectNotExecuted(execMock, COMMANDS.pushTag);
    });
  });

  describe("error handling", () => {
    it("logs an error and exits 1 when a git command fails", async () => {
      const { errSpy, exitMock } = mockErrorExit();

      vi.doMock("node:child_process", () => ({
        exec: vi.fn(() => {
          throw new Error("boom");
        }),
      }));

      const { run } = await importModule();

      await run("create");
      expect(errSpy).toHaveBeenCalledWith(
        "Error running rolling tag hook:",
        "boom",
      );
      expect(exitMock).toHaveBeenCalledWith(1);
    });

    it("logs an error and exits 1 for an unknown action", async () => {
      const { errSpy, exitMock } = mockErrorExit();
      const execMock = mockExec();

      const { run } = await importModule();

      await run("bogus");
      expect(errSpy).toHaveBeenCalledWith(
        "Error running rolling tag hook:",
        "unknown action: expected 'config', 'create' or 'push', got 'bogus'",
      );
      expect(exitMock).toHaveBeenCalledWith(1);
      expect(execMock.mock.calls.length).toBe(0);
    });
  });
});
