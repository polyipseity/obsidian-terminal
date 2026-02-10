import { describe, it, expect, vi, afterEach } from "vitest";

// Unit spec for scripts/obsidian-install.mjs — assert concise error output
// when the manifest cannot be read. Uses module mocking and process.exit
// interception to keep the test hermetic and fast.

describe("scripts/obsidian-install.mjs", () => {
  it("prints concise error and exits non-zero when PLUGIN_ID rejects", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitMock = vi.spyOn(process, "exit").mockImplementation((code) => {
      // Simulate process.exit but make it observable without terminating the test runner
      throw new Error(`process.exit called with ${code}`);
    });

    vi.doMock("../../scripts/utils.mjs", () => ({
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
  });

  it("does not print a full stack trace when manifest is missing", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitMock = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit called with ${code}`);
    });

    vi.doMock("../../scripts/utils.mjs", () => ({
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

    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("creates destination and copies manifest/main/styles when PLUGIN_ID resolves", async () => {
    vi.doMock("../../scripts/utils.mjs", () => ({
      PATHS: {
        obsidianPlugins: ".obsidian/plugins",
        manifest: "manifest.json",
        main: "main.js",
        styles: "styles.css",
      },
      PLUGIN_ID: Promise.resolve("unit-id"),
    }));

    const mkdirMock = vi.fn().mockResolvedValue();
    const copyMock = vi.fn().mockResolvedValue();
    vi.doMock("node:fs/promises", () => ({
      mkdir: mkdirMock,
      copyFile: copyMock,
    }));

    // Ensure no destination argument (defaults to '.')
    const oldArg = process.argv[2];
    process.argv[2] = undefined;

    await import("../../scripts/obsidian-install.mjs");

    // Expect mkdir called for './.obsidian/plugins/unit-id'
    expect(mkdirMock).toHaveBeenCalled();
    const expectedDest = `./.obsidian/plugins/unit-id`;
    expect(mkdirMock.mock.calls[0][0]).toBe(expectedDest);

    // Expect copyFile called for manifest, main and styles
    expect(copyMock).toHaveBeenCalledTimes(3);
    const files = copyMock.mock.calls.map((c) => c[0]);
    expect(files).toEqual(["manifest.json", "main.js", "styles.css"]);

    // restore argv
    process.argv[2] = oldArg;
  });

  it("uses provided destination argument when present", async () => {
    vi.doMock("../../scripts/utils.mjs", () => ({
      PATHS: {
        obsidianPlugins: ".obsidian/plugins",
        manifest: "manifest.json",
        main: "main.js",
        styles: "styles.css",
      },
      PLUGIN_ID: Promise.resolve("provided-id"),
    }));

    const mkdirMock = vi.fn().mockResolvedValue();
    const copyMock = vi.fn().mockResolvedValue();
    vi.doMock("node:fs/promises", () => ({
      mkdir: mkdirMock,
      copyFile: copyMock,
    }));

    const oldArg = process.argv[2];
    process.argv[2] = "/tmp/dest";

    await import("../../scripts/obsidian-install.mjs");

    expect(mkdirMock).toHaveBeenCalled();
    const expectedDest = `/tmp/dest/.obsidian/plugins/provided-id`;
    expect(mkdirMock.mock.calls[0][0]).toBe(expectedDest);

    expect(copyMock).toHaveBeenCalledTimes(3);
    process.argv[2] = oldArg;
  });

  it("formats non-Error rejection using String(err)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitMock = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit called with ${code}`);
    });

    // PLUGIN_ID rejects with a plain object (no message property)
    vi.doMock("../../scripts/utils.mjs", () => ({
      PATHS: { obsidianPlugins: ".obsidian/plugins" },
      PLUGIN_ID: Promise.reject({ problem: true }),
    }));

    await expect(import("../../scripts/obsidian-install.mjs")).rejects.toThrow(
      "process.exit called with 1",
    );

    const msgArg = errSpy.mock.calls[0][1];
    expect(String(msgArg)).toContain("[object Object]");

    expect(exitMock).toHaveBeenCalledWith(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
