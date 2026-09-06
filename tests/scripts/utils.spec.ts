import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit spec for scripts/utils.mjs — prefer hermetic behavior and keep tests
// deterministic. Some tests spawn the current runtime (process.execPath) to
// exercise `execute` but the module is imported per-test to keep state isolated.

async function mktemp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "obsidian-plugin-test-"));
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

    const out = await execute(process.execPath, [
      "-e",
      "process.stdout.write('ok'); process.stderr.write('bad'); process.exit(0)",
    ]);
    expect(out).toContain("ok");
    expect(logSpy).toHaveBeenCalledWith("ok");
    expect(errSpy).toHaveBeenCalledWith("bad");
  });

  it("execute throws when the child exits with non-zero exit code", async () => {
    const { execute } = await import("../../scripts/utils.mjs");
    await expect(
      execute(process.execPath, ["-e", "process.exit(2)"]),
    ).rejects.toThrow();
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

      const out = await execute(process.execPath, [
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

      const out = await execute(process.execPath, [
        "-e",
        "process.stderr.write('err'); process.exit(0)",
      ]);
      expect(out).toBe("");
      expect(logSpy).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith("err");
    });

    it("handles child that produces no output but exits successfully", async () => {
      const { execute } = await import("../../scripts/utils.mjs");
      const out = await execute(process.execPath, ["-e", "process.exit(0)"]);
      expect(out).toBe("");
    }, 20000);

    it("throws Error(String(exitCode)) when execFile resolves and child.exitCode is non-zero", async () => {
      vi.resetModules();
      // Mock util.promisify to return a function whose Promise has a .child prop.
      // The mock must expose a `default` export: vitest v4 ESM interop requires
      // it on the mocked module even for named imports, and the factory returns
      // a pre-declared const (not an inline literal) so vitest won't auto-add it.
      interface UtilMock {
        promisify: () => () => Promise<unknown> & {
          child: { readonly exitCode: number };
        };
        default?: UtilMock;
      }
      const utilMock: UtilMock = {
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
      };
      utilMock.default = utilMock;
      vi.doMock("node:util", () => utilMock);

      // execFile itself isn't used by our mocked promisify, but provide a mock
      // so the module's named import resolves. It also needs a `default`
      // export for the same vitest v4 interop reason as the util mock.
      interface CpMock {
        execFile: ReturnType<typeof vi.fn>;
        default?: CpMock;
      }
      const cpMock: CpMock = { execFile: vi.fn() };
      cpMock.default = cpMock;
      vi.doMock("node:child_process", () => cpMock);

      // Prevent test output from printing to the terminal and assert it
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { execute } = await import("../../scripts/utils.mjs");
      await expect(execute("cmd", ["arg"])).rejects.toThrow("5");

      expect(logSpy).toHaveBeenCalledWith("stdout");
      expect(errSpy).toHaveBeenCalledWith("stderr");
    });
  });

  describe("shared JSON helpers", () => {
    async function loadHelpers(): Promise<
      typeof import("../../scripts/utils.mjs")
    > {
      return await import("../../scripts/utils.mjs");
    }

    it("sortKeys sorts nested keys and recurses into arrays without mutating input", async () => {
      const { sortKeys } = await loadHelpers();
      const input = { b: 1, a: { z: 2, y: 3 }, arr: [{ d: 4, c: 5 }] };
      const result = sortKeys(input);
      expect(result).toEqual({
        a: { y: 3, z: 2 },
        arr: [{ c: 5, d: 4 }],
        b: 1,
      });
      expect(Object.keys(input)).toEqual(["b", "a", "arr"]);
      expect(input.a).toEqual({ z: 2, y: 3 });
    });

    it("stringifySorted writes 2-space indented JSON with sorted keys and trailing newline", async () => {
      const { stringifySorted } = await loadHelpers();
      expect(stringifySorted({ b: 1, a: { d: 2, c: 3 } })).toBe(
        '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n',
      );
    });

    it("stringifySorted escapes invisible characters", async () => {
      const { stringifySorted } = await loadHelpers();
      // non-breaking space becomes a literal \u00a0 escape sequence
      expect(stringifySorted({ note: "a\u00a0b" })).toBe(
        '{\n  "note": "a\\u00a0b"\n}\n',
      );
      // C1 control character (U+0085) is escaped too
      expect(stringifySorted({ note: "c\u0085d" })).toContain('"c\\u0085d"');
      // escaped output still parses back to the original value
      expect(
        v.parse(
          v.record(v.string(), v.unknown()),
          JSON.parse(stringifySorted({ note: "a\u00a0b" })),
        ),
      ).toEqual({ note: "a\u00a0b" });
    });

    it("readJSON parses a JSON file", async () => {
      const tmp = await mktemp();
      const file = path.join(tmp, "data.json");
      await fs.writeFile(file, JSON.stringify({ b: 2, a: { d: 4, c: 3 } }));
      const { readJSON } = await loadHelpers();
      await expect(readJSON(file)).resolves.toEqual({
        b: 2,
        a: { d: 4, c: 3 },
      });
    });

    it("writeJSON writes sorted JSON with trailing newline", async () => {
      const tmp = await mktemp();
      const file = path.join(tmp, "data.json");
      const { writeJSON, stringifySorted } = await loadHelpers();
      await writeJSON(file, { b: 1, a: 2 });
      const raw = await fs.readFile(file, "utf-8");
      expect(raw).toBe(stringifySorted({ a: 2, b: 1 }));
      expect(raw.endsWith("\n")).toBe(true);
    });
  });
});
