// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Integration tests for scripts/build.mjs — uses mocked esbuild
// to verify top-level behaviour such as writing a metafile and
// calling watch in dev mode.

describe("scripts/build.mjs", () => {
  let cwd;
  beforeEach(() => {
    vi.resetModules();
    cwd = process.cwd();
  });
  afterEach(() => {
    process.chdir(cwd);
    process.argv[2] = undefined;
    vi.restoreAllMocks();
  });

  it("writes metafile and logs errors when rebuild returns errors and metafile", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "build-proj-"));

    const fakeMetafile = { inputs: { "a.js": {} } };
    const fakeError = { text: "err" };
    vi.doMock("esbuild", () => ({
      analyzeMetafile: vi.fn().mockResolvedValue("ANALYSIS"),
      formatMessages: vi.fn().mockResolvedValue(["formatted error"]),
      context: vi.fn().mockResolvedValue({
        rebuild: vi.fn().mockResolvedValue({
          errors: [fakeError],
          warnings: [],
          metafile: fakeMetafile,
        }),
        dispose: vi.fn().mockResolvedValue(),
      }),
    }));

    const cwd = process.cwd();
    process.chdir(project);

    // Spy on console to prevent noisy test output and assert logged messages
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await import("../../scripts/build.mjs");
    } finally {
      process.chdir(cwd);
    }

    const esbuild = vi.mocked(await import("esbuild"));
    const { rebuild: rebuildSpy, dispose: disposeSpy } =
      await esbuild.context.mock.results[0].value;

    expect(rebuildSpy).toHaveBeenCalled();
    expect(disposeSpy).toHaveBeenCalled();
    expect(esbuild.analyzeMetafile).toHaveBeenCalled();
    expect(esbuild.analyzeMetafile.mock.calls[0][0]).toHaveProperty("inputs");
    expect(esbuild.formatMessages).toHaveBeenCalled();

    // verify the module logged analyzeMetafile output and formatted errors
    expect(logSpy).toHaveBeenCalledWith("ANALYSIS");
    expect(errSpy).toHaveBeenCalledWith("formatted error");

    const mf = JSON.parse(
      fs.readFileSync(path.join(project, "metafile.json"), "utf-8"),
    );
    expect(mf).toEqual(fakeMetafile);
  });

  it("calls watch when argv contains 'dev'", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "build-proj-"));
    process.chdir(project);

    const watch = vi.fn().mockResolvedValue();
    const context = vi.fn().mockResolvedValue({ watch, dispose: vi.fn() });
    vi.doMock("esbuild", () => ({
      analyzeMetafile: vi.fn(),
      formatMessages: vi.fn(),
      context,
    }));

    process.argv[2] = "dev";

    await import("../../scripts/build.mjs");

    expect(watch).toHaveBeenCalled();

    process.argv[2] = undefined;
  });

  it("logs warnings when rebuild returns warnings and no metafile", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const project = fs.mkdtempSync(path.join(os.tmpdir(), "build-proj-"));
    const fakeWarning = { text: "warn" };

    const context = vi.fn().mockResolvedValue({
      rebuild: vi.fn().mockResolvedValue({
        errors: [],
        warnings: [fakeWarning],
        metafile: undefined,
      }),
      dispose: vi.fn().mockResolvedValue(),
    });

    const formatMessages = vi.fn().mockResolvedValue(["formatted warn"]);
    const analyzeMetafile = vi.fn();

    vi.doMock("esbuild", () => ({
      analyzeMetafile,
      formatMessages,
      context,
    }));

    process.chdir(project);

    await import("../../scripts/build.mjs");

    const esbuild = vi.mocked(await import("esbuild"));

    expect(esbuild.formatMessages).toHaveBeenCalled();
    // formatMessages should be called with warnings and kind 'warning'
    const calls = esbuild.formatMessages.mock.calls;
    expect(calls.some((c) => c[1] && c[1].kind === "warning")).toBe(true);

    expect(warnSpy).toHaveBeenCalledWith("formatted warn");
  });

  it("removes existing built files (main + styles) before building", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "build-proj-"));
    const mainFile = path.join(project, "main.js");
    const stylesFile = path.join(project, "styles.css");

    // create stale build artifacts that should be removed
    fs.writeFileSync(mainFile, "stale");
    fs.writeFileSync(stylesFile, "stale");

    // Ensure PACKAGE_ID can be resolved by build.mjs on import
    fs.writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({ name: "test-package" }),
    );

    // Mock tsc invocation (which + spawn)
    vi.doMock("which", () => ({
      __esModule: true,
      default: vi.fn().mockResolvedValue("npx"),
    }));
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawn: vi.fn().mockImplementation(() => {
        const obj = {
          once(event, cb) {
            if (event === "exit") setImmediate(() => cb(0, null));
            return obj;
          },
        };
        return obj;
      }),
    }));

    const context = vi.fn().mockResolvedValue({
      rebuild: vi.fn().mockResolvedValue({
        errors: [],
        warnings: [],
        metafile: undefined,
      }),
      dispose: vi.fn().mockResolvedValue(),
    });
    vi.doMock("esbuild", () => ({
      analyzeMetafile: vi.fn(),
      formatMessages: vi.fn(),
      context,
    }));

    const cwd = process.cwd();
    process.chdir(project);
    try {
      await import("../../scripts/build.mjs");
    } finally {
      process.chdir(cwd);
    }

    expect(fs.existsSync(mainFile)).toBe(false);
    expect(fs.existsSync(stylesFile)).toBe(false);
  });

  it("logs a warning and continues when removing previous build files fails", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "build-proj-"));

    // Ensure PACKAGE_ID can be resolved by build.mjs on import
    fs.writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({ name: "test-package" }),
    );

    // Mock rm to fail while preserving other fs/promises functions (readFile is used by utils.PACKAGE_ID)
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        rm: vi.fn().mockRejectedValue(new Error("boom")),
      };
    });

    // Mock tsc invocation (which + spawn)
    vi.doMock("which", () => ({
      __esModule: true,
      default: vi.fn().mockResolvedValue("npx"),
    }));
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawn: vi.fn().mockImplementation(() => {
        const obj = {
          once(event, cb) {
            if (event === "exit") setImmediate(() => cb(0, null));
            return obj;
          },
        };
        return obj;
      }),
    }));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const context = vi.fn().mockResolvedValue({
      rebuild: vi.fn().mockResolvedValue({
        errors: [],
        warnings: [],
        metafile: undefined,
      }),
      dispose: vi.fn().mockResolvedValue(),
    });
    vi.doMock("esbuild", () => ({
      analyzeMetafile: vi.fn(),
      formatMessages: vi.fn(),
      context,
    }));

    const cwd = process.cwd();
    process.chdir(project);
    try {
      await import("../../scripts/build.mjs");
    } finally {
      process.chdir(cwd);
    }

    expect(warnSpy).toHaveBeenCalled();
    const call = warnSpy.mock.calls[0];
    expect(call[0]).toBe(
      "Failed to remove previous build output, proceeding anyway:",
    );
    expect(call[1]).toBeInstanceOf(AggregateError);
    expect(Array.isArray(call[1].errors)).toBe(true);
    expect(call[1].errors[0]).toBeInstanceOf(Error);
    expect(call[1].errors[0].message).toBe("boom");
  });
});
