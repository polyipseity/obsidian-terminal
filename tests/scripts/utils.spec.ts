// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit spec for scripts/utils.mjs — prefer hermetic behavior and keep tests
// deterministic. Some tests use quick node child processes to exercise
// `execute` but the module is imported per-test to keep state isolated.

async function mktemp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "obsidian-plugin-template-test-"));
}

describe("scripts/utils.mjs", () => {
  let origCwd: string;
  beforeEach(() => {
    vi.resetModules();
    origCwd = process.cwd();
  });
  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
  });

  it("has a frozen PATHS object with expected keys", async () => {
    const { PATHS } = await import("../../scripts/utils.mjs");
    expect(Object.isFrozen(PATHS)).toBe(true);
    expect(PATHS).toHaveProperty("main");
    expect(PATHS).toHaveProperty("manifest");
    expect(PATHS).toHaveProperty("metafile");
    expect(PATHS).toHaveProperty("styles");
  });

  it("execute logs stdout and stderr and returns stdout on success", async () => {
    const { execute } = await import("../../scripts/utils.mjs");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await execute("node", [
      "-e",
      "process.stdout.write('ok'); process.stderr.write('bad'); process.exit(0)",
    ]);
    expect(out).toContain("ok");
    expect(logSpy).toHaveBeenCalledWith("ok");
    expect(errSpy).toHaveBeenCalledWith("bad");
  });

  it("execute throws when the child exits with non-zero exit code", async () => {
    const { execute } = await import("../../scripts/utils.mjs");
    await expect(execute("node", ["-e", "process.exit(2)"])).rejects.toThrow();
  });

  it("PLUGIN_ID resolves to id from manifest.json", async () => {
    const tmp = await mktemp();
    process.chdir(tmp);
    await fs.writeFile("manifest.json", JSON.stringify({ id: "test-plugin" }));

    const { PLUGIN_ID } = await import("../../scripts/utils.mjs");
    const id = await PLUGIN_ID;
    expect(id).toBe("test-plugin");
  });

  describe("scripts/utils.mjs PLUGIN_ID and execute edge cases", () => {
    it("PLUGIN_ID caches its value after first resolution", async () => {
      const project = await fs.mkdtemp(
        path.join(os.tmpdir(), "plugin-id-proj-"),
      );
      const manifestPath = path.join(project, "manifest.json");
      await fs.writeFile(manifestPath, JSON.stringify({ id: "first-id" }));

      const cwd = process.cwd();
      try {
        process.chdir(project);
        vi.resetModules();
        const { PLUGIN_ID } = await import("../../scripts/utils.mjs");

        const first = await PLUGIN_ID;
        expect(first).toBe("first-id");

        await fs.writeFile(manifestPath, JSON.stringify({ id: "second-id" }));
        const second = await PLUGIN_ID;
        expect(second).toBe("first-id");
      } finally {
        process.chdir(cwd);
      }
    });

    it("execute throws when the child exits with non-zero exit code", async () => {
      const { execute } = await import("../../scripts/utils.mjs");
      await expect(
        execute("node", [
          "-e",
          "process.stdout.write('o'); process.stderr.write('e'); process.exit(3)",
        ]),
      ).rejects.toThrow();
    });
  });

  describe("scripts/utils.mjs execute edge cases", () => {
    it("returns stdout when child writes only to stdout and logs nothing to stderr", async () => {
      const { execute } = await import("../../scripts/utils.mjs");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const out = await execute("node", [
        "-e",
        "process.stdout.write('hello'); process.exit(0)",
      ]);
      expect(out).toContain("hello");
      expect(logSpy).toHaveBeenCalledWith("hello");
      expect(errSpy).not.toHaveBeenCalled();
    });

    it("logs stderr when child writes only to stderr and returns empty stdout", async () => {
      const { execute } = await import("../../scripts/utils.mjs");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const out = await execute("node", [
        "-e",
        "process.stderr.write('err'); process.exit(0)",
      ]);
      expect(out).toBe("");
      expect(logSpy).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith("err");
    });

    it("handles child that produces no output but exits successfully", async () => {
      const { execute } = await import("../../scripts/utils.mjs");
      const out = await execute("node", ["-e", "process.exit(0)"]);
      expect(out).toBe("");
    }, 20000);

    it("throws Error(String(exitCode)) when execFile resolves and child.exitCode is non-zero", async () => {
      vi.resetModules();
      // Mock util.promisify to return a function whose Promise has a .child prop
      vi.doMock("node:util", () => ({
        promisify: () => () => {
          const p: Promise<unknown> & { child: { readonly exitCode: number } } =
            Object.assign(
              new Promise((resolve) =>
                // resolve asynchronously to mimic real execFile behavior
                setImmediate(() => {
                  resolve({ stdout: "stdout", stderr: "stderr" });
                }),
              ),
              { child: { exitCode: 5 } },
            );
          return p;
        },
      }));

      // execFile itself isn't used by our mocked promisify, but provide it anyway
      vi.doMock("node:child_process", () => ({ execFile: vi.fn() }));

      // Prevent test output from printing to the terminal and assert it
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { execute } = await import("../../scripts/utils.mjs");
      await expect(execute("cmd", ["arg"])).rejects.toThrow("5");

      expect(logSpy).toHaveBeenCalledWith("stdout");
      expect(errSpy).toHaveBeenCalledWith("stderr");
    });
  });
});
