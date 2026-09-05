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

// The script shell-quotes interpolated names (shq), so the mocked command
// strings must match the quoted forms exactly. Single-quote helpers mirror
// the script's shq() so keys line up with what exec actually receives.
const shq = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const branchCmd = "git rev-parse --abbrev-ref --verify HEAD";
const remoteCmd = (branch: string) =>
  `git config --get branch.${shq(branch)}.remote`;
const remoteUrlCmd = (remote: string) =>
  `git config --get remote.${shq(remote)}.url`;
const defaultBranchCmd = (remote: string) =>
  `git symbolic-ref --quiet refs/remotes/${shq(remote)}/HEAD`;
const headCmd = "git rev-parse --verify 'HEAD^{commit}'";
const rollingCmd =
  "git rev-parse --verify --quiet 'refs/tags/rolling^{commit}'";
const tagMessage = "rolling";
const createTagCmd = `git tag --force --sign rolling --message ${shq(tagMessage)}`;
const pushTagCmd = (remote: string) =>
  `git push --no-verify --force ${shq(remote)} refs/tags/rolling:refs/tags/rolling`;
const refspecsCmd = (remote: string) =>
  `git config --local --get-all remote.${shq(remote)}.fetch`;
const addRefspecCmd = (remote: string) =>
  `git config --local --add remote.${shq(remote)}.fetch '+refs/tags/rolling:refs/tags/rolling'`;

// Commands and outputs for a repository on its default branch `main` whose
// upstream remote is `origin` with a resolvable `origin/HEAD`.
const onDefaultBranch = new Map<string, string>([
  [branchCmd, "main\n"],
  [remoteCmd("main"), "origin\n"],
  [defaultBranchCmd("origin"), "refs/remotes/origin/main\n"],
]);

type ExecError = Error & { readonly code?: number; readonly stderr?: string };

// Simulate a non-zero git exit (e.g. an unset config key or ref). The git()
// helper only swallows errors carrying a numeric `code`; spawn failures must
// propagate, so every simulated git failure needs one.
function execError(message = "", code = 1, stderr = "") {
  return Object.assign(new Error(message), { code, stderr });
}

// The mock succeeds for every command (recording it) and uses the stdout map
// for output; a command missing from the map yields empty stdout, which
// represents the ref or config key not existing yet. Commands in the error
// map instead reject with the given error, simulating non-zero exits.
function mockExec(
  stdoutByCommand: ReadonlyMap<string, string> = new Map(),
  errorByCommand: ReadonlyMap<string, ExecError> = new Map(),
) {
  const tagState = { value: "" };
  const execMock = vi.fn(
    (command: string, _options: unknown, callback: ExecCallback) => {
      const error = errorByCommand.get(command);
      if (error !== undefined) {
        callback(error, { stdout: "", stderr: error.stderr ?? "" });
        return;
      }
      let stdout = stdoutByCommand.get(command) ?? "";
      // Model the tag-creation side effect so a push after a create sees the
      // tag pointing at HEAD, matching real git behavior.
      if (command === createTagCmd) {
        tagState.value = stdoutByCommand.get(headCmd) ?? "";
      } else if (command === rollingCmd && tagState.value !== "") {
        stdout = tagState.value;
      }
      callback(null, { stdout, stderr: "" });
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

// Warnings are non-fatal; spy so tests can assert that one was emitted.
function mockWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("scripts/git-rolling-tag.mjs", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  describe("isOnDefaultBranch", () => {
    it("returns true on the default branch", async () => {
      const execMock = mockExec(onDefaultBranch);

      const { isOnDefaultBranch } = await importModule();

      await expect(isOnDefaultBranch()).resolves.toBe(true);
      expectExecuted(execMock, branchCmd);
      expectExecuted(execMock, remoteCmd("main"));
      expectExecuted(execMock, defaultBranchCmd("origin"));
    });

    it("returns false on other branches", async () => {
      mockExec(
        new Map([
          [branchCmd, "feature\n"],
          [remoteCmd("feature"), "origin\n"],
          [defaultBranchCmd("origin"), "refs/remotes/origin/main\n"],
        ]),
      );

      const { isOnDefaultBranch } = await importModule();

      await expect(isOnDefaultBranch()).resolves.toBe(false);
    });

    it("returns false and warns when HEAD is detached", async () => {
      const warnSpy = mockWarn();
      mockExec(new Map([[branchCmd, "HEAD\n"]]));

      const { isOnDefaultBranch } = await importModule();

      await expect(isOnDefaultBranch()).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("returns false and warns when there are no commits", async () => {
      const warnSpy = mockWarn();
      mockExec(
        new Map(),
        new Map([
          [
            branchCmd,
            Object.assign(new Error("fatal: ambiguous argument 'HEAD'"), {
              code: 128,
              stderr: "fatal: ambiguous argument 'HEAD'",
            }),
          ],
        ]),
      );

      const { isOnDefaultBranch } = await importModule();

      await expect(isOnDefaultBranch()).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("returns false and warns when there is no upstream remote", async () => {
      const warnSpy = mockWarn();
      mockExec(
        new Map([[branchCmd, "main\n"]]),
        new Map([
          [
            remoteCmd("main"),
            execError(
              "error: key does not contain a section: branch.main.remote",
            ),
          ],
        ]),
      );

      const { isOnDefaultBranch } = await importModule();

      await expect(isOnDefaultBranch()).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("returns false and warns when the default branch cannot be determined", async () => {
      const warnSpy = mockWarn();
      mockExec(
        new Map([
          [branchCmd, "main\n"],
          [remoteCmd("main"), "origin\n"],
        ]),
        new Map([
          [
            defaultBranchCmd("origin"),
            execError(
              "error: refs/remotes/origin/HEAD is not a symbolic ref",
              1,
              "error: refs/remotes/origin/HEAD is not a symbolic ref",
            ),
          ],
        ]),
      );

      const { isOnDefaultBranch } = await importModule();

      await expect(isOnDefaultBranch()).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe("createRollingTag", () => {
    it("recreates the tag when it points elsewhere", async () => {
      const execMock = mockExec(
        new Map([
          [headCmd, "abc123\n"],
          [rollingCmd, "def456\n"],
        ]),
      );

      const { createRollingTag } = await importModule();

      await createRollingTag();
      expectExecuted(execMock, createTagCmd);
    });

    it("creates the tag when it does not exist", async () => {
      const execMock = mockExec(new Map([[headCmd, "abc123\n"]]));

      const { createRollingTag } = await importModule();

      await createRollingTag();
      expectExecuted(execMock, createTagCmd);
    });

    it("skips when the tag already points to HEAD", async () => {
      const execMock = mockExec(
        new Map([
          [headCmd, "abc123\n"],
          [rollingCmd, "abc123\n"],
        ]),
      );

      const { createRollingTag } = await importModule();

      await createRollingTag();
      expectNotExecuted(execMock, createTagCmd);
    });

    it("warns and skips when HEAD cannot be resolved", async () => {
      const warnSpy = mockWarn();
      const execMock = mockExec(
        new Map(),
        new Map([
          [
            headCmd,
            Object.assign(new Error("fatal: bad revision 'HEAD^{commit}'"), {
              code: 128,
              stderr: "fatal: bad revision 'HEAD^{commit}'",
            }),
          ],
        ]),
      );

      const { createRollingTag } = await importModule();

      await createRollingTag();
      expect(warnSpy).toHaveBeenCalled();
      expectNotExecuted(execMock, createTagCmd);
    });
  });

  describe("pushRollingTag", () => {
    it("pushes the rolling tag to the upstream remote", async () => {
      const execMock = mockExec(
        new Map([
          [branchCmd, "main\n"],
          [remoteCmd("main"), "origin\n"],
          [rollingCmd, "abc123\n"],
        ]),
      );

      const { pushRollingTag } = await importModule();

      await pushRollingTag();
      expectExecuted(execMock, pushTagCmd("origin"));
    });

    it("warns and skips when the tag does not exist", async () => {
      const warnSpy = mockWarn();
      const execMock = mockExec(
        new Map([
          [branchCmd, "main\n"],
          [remoteCmd("main"), "origin\n"],
        ]),
      );

      const { pushRollingTag } = await importModule();

      await pushRollingTag();
      expect(warnSpy).toHaveBeenCalled();
      expectNotExecuted(execMock, pushTagCmd("origin"));
    });
  });

  describe("configureRollingRefspec", () => {
    it("adds the refspec when it is not set", async () => {
      const execMock = mockExec(
        new Map([
          [branchCmd, "main\n"],
          [remoteCmd("main"), "origin\n"],
          [remoteUrlCmd("origin"), "https://example.com/repo.git\n"],
        ]),
      );

      const { configureRollingRefspec } = await importModule();

      await configureRollingRefspec();
      expectExecuted(execMock, refspecsCmd("origin"));
      expectExecuted(execMock, addRefspecCmd("origin"));
    });

    it("skips when the refspec is already set", async () => {
      const execMock = mockExec(
        new Map([
          [branchCmd, "main\n"],
          [remoteCmd("main"), "origin\n"],
          [remoteUrlCmd("origin"), "https://example.com/repo.git\n"],
          [refspecsCmd("origin"), "+refs/tags/rolling:refs/tags/rolling\n"],
        ]),
      );

      const { configureRollingRefspec } = await importModule();

      await configureRollingRefspec();
      expectNotExecuted(execMock, addRefspecCmd("origin"));
    });

    it("warns and skips when the remote has no URL", async () => {
      const warnSpy = mockWarn();
      const execMock = mockExec(
        new Map([
          [branchCmd, "main\n"],
          [remoteCmd("main"), "origin\n"],
        ]),
      );

      const { configureRollingRefspec } = await importModule();

      await configureRollingRefspec();
      expect(warnSpy).toHaveBeenCalled();
      expectNotExecuted(execMock, addRefspecCmd("origin"));
    });
  });

  describe("run('config')", () => {
    it("configures the refspec", async () => {
      const execMock = mockExec(
        new Map([
          [branchCmd, "main\n"],
          [remoteCmd("main"), "origin\n"],
          [remoteUrlCmd("origin"), "https://example.com/repo.git\n"],
        ]),
      );

      const { run } = await importModule();

      await run("config");
      expectExecuted(execMock, refspecsCmd("origin"));
      expectExecuted(execMock, addRefspecCmd("origin"));
    });
  });

  describe("run('create')", () => {
    it("creates the tag on the default branch", async () => {
      const execMock = mockExec(
        new Map([
          ...onDefaultBranch,
          [headCmd, "abc123\n"],
          [rollingCmd, "def456\n"],
        ]),
      );

      const { run } = await importModule();

      await run("create");
      expectExecuted(execMock, createTagCmd);
      expectNotExecuted(execMock, pushTagCmd("origin"));
    });

    it("does nothing on non-default branches", async () => {
      const execMock = mockExec(
        new Map([
          [branchCmd, "feature\n"],
          [remoteCmd("feature"), "origin\n"],
          [defaultBranchCmd("origin"), "refs/remotes/origin/main\n"],
        ]),
      );

      const { run } = await importModule();

      await run("create");
      expectExecuted(execMock, branchCmd);
      expectExecuted(execMock, remoteCmd("feature"));
      expectExecuted(execMock, defaultBranchCmd("origin"));
      expectNotExecuted(execMock, createTagCmd);
    });
  });

  describe("run('push')", () => {
    it("recreates the tag when it points elsewhere, then pushes", async () => {
      const execMock = mockExec(
        new Map([
          ...onDefaultBranch,
          [headCmd, "abc123\n"],
          [rollingCmd, "def456\n"],
        ]),
      );

      const { run } = await importModule();

      await run("push");
      expectExecuted(execMock, createTagCmd);
      expectExecuted(execMock, pushTagCmd("origin"));
    });

    it("creates the tag when it does not exist, then pushes", async () => {
      const execMock = mockExec(
        new Map([...onDefaultBranch, [headCmd, "abc123\n"]]),
      );

      const { run } = await importModule();

      await run("push");
      expectExecuted(execMock, createTagCmd);
      expectExecuted(execMock, pushTagCmd("origin"));
    });

    it("pushes without recreating the tag when it already points to HEAD", async () => {
      const execMock = mockExec(
        new Map([
          ...onDefaultBranch,
          [headCmd, "abc123\n"],
          [rollingCmd, "abc123\n"],
        ]),
      );

      const { run } = await importModule();

      await run("push");
      expectExecuted(execMock, pushTagCmd("origin"));
      expectNotExecuted(execMock, createTagCmd);
    });

    it("does nothing on non-default branches", async () => {
      const execMock = mockExec(
        new Map([
          [branchCmd, "feature\n"],
          [remoteCmd("feature"), "origin\n"],
          [defaultBranchCmd("origin"), "refs/remotes/origin/main\n"],
        ]),
      );

      const { run } = await importModule();

      await run("push");
      expectExecuted(execMock, branchCmd);
      expectExecuted(execMock, remoteCmd("feature"));
      expectExecuted(execMock, defaultBranchCmd("origin"));
      expectNotExecuted(execMock, createTagCmd);
      expectNotExecuted(execMock, pushTagCmd("origin"));
    });
  });

  describe("error handling", () => {
    it("logs the error and stderr, and exits 1, when a git command fails", async () => {
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
