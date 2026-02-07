import { describe, it, expect, vi, beforeEach } from "vitest";

// Unit spec for scripts/obsidian-install.mjs — assert concise error output
// when the manifest cannot be read. Uses module mocking and process.exit
// interception to keep the test hermetic and fast.

describe("scripts/obsidian-install.mjs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("prints concise error and exits non-zero when PLUGIN_ID rejects", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitMock = vi.spyOn(process, "exit").mockImplementation((code) => {
      // Simulate process.exit but make it observable without terminating the test runner
      throw new Error(`process.exit called with ${code}`);
    });

    vi.doMock("../../scripts/util.mjs", () => ({
      PATHS: { obsidianPlugins: ".obsidian/plugins" },
      PLUGIN_ID: Promise.reject(new Error("no manifest")),
    }));

    await expect(import("../../scripts/obsidian-install.mjs")).rejects.toThrow(
      "process.exit called with 1",
    );

    expect(errSpy).toHaveBeenCalled();
    const msg = errSpy.mock.calls[0][0];
    expect(msg).toContain("Error reading manifest.json");
    expect(exitMock).toHaveBeenCalledWith(1);

    errSpy.mockRestore();
    exitMock.mockRestore();
  });

  it("does not print a full stack trace when manifest is missing", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitMock = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit called with ${code}`);
    });

    vi.doMock("../../scripts/util.mjs", () => ({
      PATHS: { obsidianPlugins: ".obsidian/plugins" },
      PLUGIN_ID: Promise.reject(new Error("missing manifest file")),
    }));

    await expect(import("../../scripts/obsidian-install.mjs")).rejects.toThrow(
      "process.exit called with 1",
    );

    const msg = errSpy.mock.calls[0][0];
    expect(msg).toContain("Error reading manifest.json");
    expect(msg).not.toContain("\n");
    expect(msg).not.toMatch(/\bat\s+/);
    expect(msg).not.toContain("Error: Cannot find module");
    expect(msg.toLowerCase()).not.toContain("stack");

    errSpy.mockRestore();
    exitMock.mockRestore();
  });
});
