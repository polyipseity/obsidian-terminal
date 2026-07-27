// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Integration tests for scripts/build.mjs — uses mocked esbuild
// to verify top-level behaviour such as writing a metafile and
// calling watch in dev mode.

function createSpawnMock() {
  return vi.fn().mockImplementation(() => {
    const obj = {
      once(event: string, cb: (code: number, signal: null) => void) {
        if (event === "exit") setImmediate(() => cb(0, null));
        return obj;
      },
    };
    return obj;
  });
}

describe("scripts/build.mjs", () => {
  let cwd: string;
  beforeEach(() => {
    vi.resetModules();
    cwd = process.cwd();
  });
  afterEach(() => {
    process.chdir(cwd);
    delete process.argv[2];
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
        dispose: vi.fn(),
      }),
    }));

    // Ensure PLUGIN_ID can be resolved by build.mjs on import
    fs.writeFileSync(
      path.join(project, "manifest.json"),
      JSON.stringify({ name: "test-plugin" }),
    );

    // Mock tsc invocation (which + spawn) to avoid running real tsc during import
    vi.doMock("which", () => ({
      __esModule: true,
      default: vi.fn().mockResolvedValue("bunx"),
    }));
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawn: createSpawnMock(),
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
    const contextResult = esbuild.context.mock.results[0];
    if (!contextResult) throw new Error("esbuild.context was not called");
    const { rebuild: rebuildSpy, dispose: disposeSpy } =
      await contextResult.value;

    expect(rebuildSpy).toHaveBeenCalled();
    expect(disposeSpy).toHaveBeenCalled();
    expect(esbuild.analyzeMetafile).toHaveBeenCalled();
    expect(esbuild.analyzeMetafile).toHaveBeenCalledWith(
      expect.objectContaining({ inputs: expect.anything() }),
      expect.anything(),
    );
    expect(esbuild.formatMessages).toHaveBeenCalled();

    // verify the module logged analyzeMetafile output and formatted errors
    expect(logSpy).toHaveBeenCalledWith("ANALYSIS");
    expect(errSpy).toHaveBeenCalledWith("formatted error");

    const mf = v.parse(
      v.pipe(v.string(), v.parseJson()),
      fs.readFileSync(path.join(project, "metafile.json"), "utf-8"),
    );
    expect(mf).toEqual(fakeMetafile);
  });

  it("calls watch when argv contains 'dev'", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "build-proj-"));
    process.chdir(project);

    // Ensure PLUGIN_ID can be resolved by build.mjs on import
    fs.writeFileSync(
      path.join(project, "manifest.json"),
      JSON.stringify({ id: "test-plugin" }),
    );

    // Mock tsc invocation (which + spawn) to avoid running real tsc during import
    vi.doMock("which", () => ({
      __esModule: true,
      default: vi.fn().mockResolvedValue("bunx"),
    }));
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawn: createSpawnMock(),
    }));

    const watch = vi.fn();
    const context = vi.fn().mockResolvedValue({ watch, dispose: vi.fn() });
    vi.doMock("esbuild", () => ({
      analyzeMetafile: vi.fn(),
      formatMessages: vi.fn(),
      context,
    }));

    process.argv[2] = "dev";

    await import("../../scripts/build.mjs");

    expect(watch).toHaveBeenCalled();

    delete process.argv[2];
  });

  it("logs warnings when rebuild returns warnings and no metafile", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const project = fs.mkdtempSync(path.join(os.tmpdir(), "build-proj-"));
    const fakeWarning = { text: "warn" };

    const fakeMetafile = { inputs: { "a.js": {} } };
    const context = vi.fn().mockResolvedValue({
      rebuild: vi.fn().mockResolvedValue({
        errors: [],
        warnings: [fakeWarning],
        metafile: fakeMetafile,
      }),
      dispose: vi.fn(),
    });

    const formatMessages = vi.fn().mockResolvedValue(["formatted warn"]);
    const analyzeMetafile = vi.fn();

    vi.doMock("esbuild", () => ({
      analyzeMetafile,
      formatMessages,
      context,
    }));

    // Ensure PACKAGE_ID can be resolved by build.mjs on import
    fs.writeFileSync(
      path.join(project, "manifest.json"),
      JSON.stringify({ name: "test-plugin" }),
    );

    // Mock tsc invocation (which + spawn) to avoid running real tsc during import
    vi.doMock("which", () => ({
      __esModule: true,
      default: vi.fn().mockResolvedValue("bunx"),
    }));
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawn: createSpawnMock(),
    }));

    process.chdir(project);

    await import("../../scripts/build.mjs");

    const esbuild = vi.mocked(await import("esbuild"));

    expect(esbuild.formatMessages).toHaveBeenCalled();
    // formatMessages should be called with warnings and kind 'warning'
    const calls = esbuild.formatMessages.mock.calls;
    expect(calls.some((c) => c[1].kind === "warning")).toBe(true);

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
      default: vi.fn().mockResolvedValue("bunx"),
    }));
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawn: createSpawnMock(),
    }));

    const fakeMetafile = { inputs: { "a.js": {} } };
    const context = vi.fn().mockResolvedValue({
      rebuild: vi.fn().mockResolvedValue({
        errors: [],
        warnings: [],
        metafile: fakeMetafile,
      }),
      dispose: vi.fn(),
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
      return Object.assign({}, actual, {
        rm: vi.fn().mockRejectedValue(new Error("boom")),
      });
    });

    // Mock tsc invocation (which + spawn)
    vi.doMock("which", () => ({
      __esModule: true,
      default: vi.fn().mockResolvedValue("bunx"),
    }));
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      spawn: createSpawnMock(),
    }));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const fakeMetafile = { inputs: { "a.js": {} } };
    const context = vi.fn().mockResolvedValue({
      rebuild: vi.fn().mockResolvedValue({
        errors: [],
        warnings: [],
        metafile: fakeMetafile,
      }),
      dispose: vi.fn(),
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

    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to remove previous build output, proceeding anyway:",
      expect.objectContaining({ message: "boom" }),
    );
  });
});
