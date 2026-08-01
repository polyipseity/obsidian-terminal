// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit spec for the git-rolling hook scripts — assert the concise console.error
// output and process.exit(1) when the underlying `git` command fails. Each
// script runs `main().catch(...)` at module top level without awaiting it, so
// the import itself resolves; `vi.waitFor` flushes the async rejection chain.

describe("scripts/git-rolling-*.mjs error paths", () => {
  beforeEach(() => vi.resetModules());

  it("refspec-config logs error and exits 1 when exec fails", async () => {
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

  it("tag-create logs error and exits 1 when exec fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitMock = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    vi.doMock("node:child_process", () => ({
      exec: vi.fn(() => {
        throw new Error("boom");
      }),
    }));

    await import("../../scripts/git-rolling-tag-create.mjs");

    await vi.waitFor(() => {
      expect(errSpy).toHaveBeenCalledWith(
        "Error creating rolling tag:",
        "boom",
      );
      expect(exitMock).toHaveBeenCalledWith(1);
    });
  });

  it("tag-push logs error and exits 1 when exec fails", async () => {
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
});
