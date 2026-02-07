import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Unit spec for scripts/util.mjs — prefer hermetic behavior and keep tests
// deterministic. Some tests use quick node child processes to exercise
// `execute` but the module is imported per-test to keep state isolated.

function mktemp() {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), "obsidian-plugin-template-test-"),
  );
}

describe("scripts/util.mjs", () => {
  let origCwd;
  beforeEach(() => {
    origCwd = process.cwd();
    vi.resetModules();
  });
  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
  });

  it("has a frozen PATHS object with expected keys", async () => {
    const { PATHS } = await import("../../scripts/util.mjs");
    expect(Object.isFrozen(PATHS)).toBe(true);
    expect(PATHS).toHaveProperty("main");
    expect(PATHS).toHaveProperty("manifest");
    expect(PATHS).toHaveProperty("styles");
  });

  it("execute logs stdout and stderr and returns stdout on success", async () => {
    const { execute } = await import("../../scripts/util.mjs");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await execute("node", [
      "-e",
      "process.stdout.write('ok'); process.stderr.write('bad'); process.exit(0)",
    ]);
    expect(out).toContain("ok");
    expect(logSpy).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it("execute throws when the child exits with non-zero exit code", async () => {
    const { execute } = await import("../../scripts/util.mjs");
    await expect(execute("node", ["-e", "process.exit(2)"])).rejects.toThrow();
  });

  it("PLUGIN_ID resolves to id from manifest.json", async () => {
    const tmp = mktemp();
    process.chdir(tmp);
    fs.writeFileSync("manifest.json", JSON.stringify({ id: "test-plugin" }));

    const { PLUGIN_ID } = await import("../../scripts/util.mjs");
    const id = await PLUGIN_ID;
    expect(id).toBe("test-plugin");
  });

  describe("scripts/util.mjs PLUGIN_ID and execute edge cases", () => {
    it("PLUGIN_ID caches its value after first resolution", async () => {
      const project = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-id-proj-"));
      const manifestPath = path.join(project, "manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify({ id: "first-id" }));

      const cwd = process.cwd();
      try {
        process.chdir(project);
        vi.resetModules();
        const { PLUGIN_ID } = await import("../../scripts/util.mjs");

        const first = await PLUGIN_ID;
        expect(first).toBe("first-id");

        fs.writeFileSync(manifestPath, JSON.stringify({ id: "second-id" }));
        const second = await PLUGIN_ID;
        expect(second).toBe("first-id");
      } finally {
        process.chdir(cwd);
      }
    });

    it("execute throws when the child exits with non-zero exit code", async () => {
      const { execute } = await import("../../scripts/util.mjs");
      await expect(
        execute("node", [
          "-e",
          "process.stdout.write('o'); process.stderr.write('e'); process.exit(3)",
        ]),
      ).rejects.toThrow();
    });
  });

  describe("scripts/util.mjs execute edge cases", () => {
    it("returns stdout when child writes only to stdout and logs nothing to stderr", async () => {
      const { execute } = await import("../../scripts/util.mjs");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const out = await execute("node", [
        "-e",
        "process.stdout.write('hello'); process.exit(0)",
      ]);
      expect(out).toContain("hello");
      expect(logSpy).toHaveBeenCalled();
      expect(errSpy).not.toHaveBeenCalled();

      logSpy.mockRestore();
      errSpy.mockRestore();
    });

    it("logs stderr when child writes only to stderr and returns empty stdout", async () => {
      const { execute } = await import("../../scripts/util.mjs");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const out = await execute("node", [
        "-e",
        "process.stderr.write('err'); process.exit(0)",
      ]);
      expect(out).toBe("");
      expect(logSpy).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalled();

      logSpy.mockRestore();
      errSpy.mockRestore();
    });

    it("handles child that produces no output but exits successfully", async () => {
      const { execute } = await import("../../scripts/util.mjs");
      const out = await execute("node", ["-e", "process.exit(0)"]);
      expect(out).toBe("");
    });
  });
});
