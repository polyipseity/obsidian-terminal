// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit spec for scripts/git-rolling-tag-push.mjs — the pre-push hook creates
// the rolling tag when it does not point at HEAD, then pushes it to origin, and
// skips entirely on non-default branches. Also asserts the concise
// console.error output and process.exit(1) when a `git` command fails. The
// script runs `main().catch(...)` at module top level without awaiting it, so
// the import itself resolves; `vi.waitFor` flushes the async chain.

// promisify(exec) on a mocked exec (no promisify.custom) resolves the single
// value passed to the callback, so the mock must pass the { stdout, stderr }
// object the script destructures.
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

describe("scripts/git-rolling-tag-push.mjs", () => {
  beforeEach(() => vi.resetModules());

  it("logs error and exits 1 when exec fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitMock = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    vi.doMock("node:child_process", () => ({
      exec: vi.fn(() => {
        throw new Error("boom");
      }),
    }));

    await import("../../scripts/git-rolling-tag-push.mjs");

    await vi.waitFor(() => {
      expect(errSpy).toHaveBeenCalledWith("Error pushing rolling tag:", "boom");
      expect(exitMock).toHaveBeenCalledWith(1);
    });
  });

  it("recreates the rolling tag when it points elsewhere, then pushes", async () => {
    const execMock = mockExec(
      new Map([
        [COMMANDS.branch, "main\n"],
        [COMMANDS.defaultBranch, "main\n"],
        [COMMANDS.head, "abc123\n"],
        [COMMANDS.rolling, "def456\n"],
      ]),
    );

    await import("../../scripts/git-rolling-tag-push.mjs");

    await vi.waitFor(() => {
      expectExecuted(execMock, COMMANDS.createTag);
    });
    await vi.waitFor(() => {
      expectExecuted(execMock, COMMANDS.pushTag);
    });
  });

  it("creates the rolling tag when it does not exist, then pushes", async () => {
    const execMock = mockExec(
      new Map([
        [COMMANDS.branch, "main\n"],
        [COMMANDS.defaultBranch, "main\n"],
        [COMMANDS.head, "abc123\n"],
      ]),
    );

    await import("../../scripts/git-rolling-tag-push.mjs");

    await vi.waitFor(() => {
      expectExecuted(execMock, COMMANDS.createTag);
    });
    await vi.waitFor(() => {
      expectExecuted(execMock, COMMANDS.pushTag);
    });
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

    await import("../../scripts/git-rolling-tag-push.mjs");

    await vi.waitFor(() => {
      expectExecuted(execMock, COMMANDS.pushTag);
    });
    expectNotExecuted(execMock, COMMANDS.createTag);
  });

  it("does nothing when not on the default branch", async () => {
    const execMock = mockExec(
      new Map([
        [COMMANDS.branch, "feature\n"],
        [COMMANDS.defaultBranch, "main\n"],
      ]),
    );

    await import("../../scripts/git-rolling-tag-push.mjs");

    await vi.waitFor(() => {
      expect(execMock.mock.calls.length).toBe(2);
    });
    expectNotExecuted(execMock, COMMANDS.createTag);
    expectNotExecuted(execMock, COMMANDS.pushTag);
  });
});
