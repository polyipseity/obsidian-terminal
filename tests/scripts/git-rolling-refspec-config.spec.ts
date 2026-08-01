// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit spec for scripts/git-rolling-refspec-config.mjs — assert the concise
// console.error output and process.exit(1) when the underlying `git` command
// fails. The script runs `main().catch(...)` at module top level without
// awaiting it, so the import itself resolves; `vi.waitFor` flushes the async
// rejection chain.

describe("scripts/git-rolling-refspec-config.mjs error path", () => {
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

    await import("../../scripts/git-rolling-refspec-config.mjs");

    await vi.waitFor(() => {
      expect(errSpy).toHaveBeenCalledWith(
        "Error configuring rolling refspec:",
        "boom",
      );
      expect(exitMock).toHaveBeenCalledWith(1);
    });
  });
});
